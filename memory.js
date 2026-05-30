'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Storage path
// ---------------------------------------------------------------------------

const MEMORY_DIR = path.join(os.homedir(), 'Operator Downloads');
const MEMORY_PATH = path.join(MEMORY_DIR, 'episodic_memory.json');

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

/**
 * Load the memory store from disk.
 * Returns a fresh store if the file is missing or corrupt.
 * @returns {{ episodes: object[] }}
 */
function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_PATH)) {
      const raw = fs.readFileSync(MEMORY_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      // Validate basic shape
      if (parsed && Array.isArray(parsed.episodes)) return parsed;
    }
  } catch (e) {
    // File corrupt or unreadable — start fresh
  }
  return { episodes: [] };
}

/**
 * Persist the memory store to disk.
 * Creates the directory if it doesn't exist yet.
 * @param {{ episodes: object[] }} mem
 */
function saveMemory(mem) {
  try {
    if (!fs.existsSync(MEMORY_DIR)) {
      fs.mkdirSync(MEMORY_DIR, { recursive: true });
    }
    fs.writeFileSync(MEMORY_PATH, JSON.stringify(mem, null, 2), 'utf8');
  } catch (e) {
    console.error('[memory] Failed to save episodic memory:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record an episode of agent activity.
 *
 * @param {{
 *   goal:    string,
 *   url:     string,
 *   action:  string,
 *   outcome: 'success' | 'failure',
 *   detail:  string,
 * }} episode
 */
function recordEpisode(episode) {
  if (!episode || typeof episode !== 'object') return;

  const mem = loadMemory();

  mem.episodes.push({
    goal:      episode.goal    || '',
    url:       episode.url     || '',
    action:    episode.action  || '',
    outcome:   episode.outcome === 'success' ? 'success' : 'failure',
    detail:    episode.detail  || '',
    timestamp: Date.now(),
  });

  // Keep only the most recent 500 episodes to bound disk usage
  if (mem.episodes.length > 500) {
    mem.episodes = mem.episodes.slice(-500);
  }

  saveMemory(mem);
}

/**
 * Retrieve the most relevant past episodes for the given goal + URL context.
 *
 * Scoring heuristic:
 *   +5  if the episode's URL shares the same hostname as `url`
 *   +2  for each significant word in `goal` that appears in the episode's goal
 *   +1  if the episode's outcome was 'success'
 *
 * @param {string} goal - The current high-level goal.
 * @param {string} url  - The current page URL.
 * @returns {string} A formatted string (for LLM context) of up to 3 relevant episodes,
 *                   or an empty string if nothing relevant is found.
 */
function recallRelevant(goal, url) {
  const mem = loadMemory();
  if (mem.episodes.length === 0) return '';

  // Resolve current domain for domain-match scoring
  let currentDomain = url;
  try {
    currentDomain = new URL(url).hostname;
  } catch (e) { /* keep raw url */ }

  // Tokenise the goal into significant words (length > 3)
  const goalWords = (goal || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);

  // Score every stored episode
  const scored = mem.episodes.map((ep) => {
    let score = 0;

    // Domain match
    try {
      if (new URL(ep.url).hostname === currentDomain) score += 5;
    } catch (e) {
      if (ep.url === url) score += 5;
    }

    // Goal word overlap
    const epGoalLower = (ep.goal || '').toLowerCase();
    for (const word of goalWords) {
      if (epGoalLower.includes(word)) score += 2;
    }

    // Slight preference for successful episodes
    if (ep.outcome === 'success') score += 1;

    return { ep, score };
  });

  // Take top 3 with a positive score, most relevant first
  const relevant = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => s.ep);

  if (relevant.length === 0) return '';

  return relevant
    .map((ep) => {
      const icon = ep.outcome === 'success' ? '✅' : '❌';
      return `[${icon} ${ep.outcome}] Goal: "${ep.goal}" on ${ep.url} → ${ep.detail}`;
    })
    .join('\n');
}

/**
 * Return all stored episodes (primarily useful for debugging / UI display).
 * @returns {object[]}
 */
function getAllEpisodes() {
  return loadMemory().episodes;
}

/**
 * Wipe the entire episodic memory store.
 * Use with caution.
 */
function clearMemory() {
  saveMemory({ episodes: [] });
}

module.exports = {
  recordEpisode,
  recallRelevant,
  getAllEpisodes,
  clearMemory,
  // Expose path so callers can display where memory lives
  MEMORY_PATH,
};
