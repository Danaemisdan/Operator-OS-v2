// dom-pruner.js
// Prunes the UI element graph before sending it to the LLM.
// Keeps only the most relevant, interactive elements to save tokens and improve accuracy.

'use strict';

/**
 * Score and filter graph elements by relevance to the current goal.
 *
 * Scoring rules:
 *   +10  if element is interactive (BTN_, LNK_, INP_)
 *   +5   per goal word (>3 chars) found in element text
 *   +3   if element is NOT a footer/legal/cookie/privacy link
 *   +2   if element has a meaningful predictedEffect (length > 5)
 *   -5   if element starts with TXT_, IMG_, VID_ (non-interactive content)
 *   -3   if element text length < 2 or > 100
 *
 * After scoring, take the top 25 elements sorted by descending score.
 *
 * @param {{ elements: Array<object> }} graph   - The full UI graph
 * @param {string}                      goalText - The user's current goal sentence
 * @returns {{ elements: Array<object> }}        - Pruned graph with ≤25 elements
 */
function pruneGraph(graph, goalText) {
  if (!graph || !Array.isArray(graph.elements)) {
    return graph || { elements: [] };
  }

  // Tokenise the goal into meaningful words (longer than 3 characters)
  const goalWords = (goalText || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 3);

  // Noise words that indicate footer / legal content
  const legalTerms = ['privacy', 'terms', 'cookie', 'copyright', 'legal'];

  // Interactive element prefixes
  const interactivePrefixes = ['BTN_', 'LNK_', 'INP_'];

  // Non-interactive content prefixes
  const contentPrefixes = ['TXT_', 'IMG_', 'VID_'];

  const scored = graph.elements.map(el => {
    let score = 0;
    const text = (el.text || '').toLowerCase();
    const id = el.id || '';

    // +10 — interactive element
    if (interactivePrefixes.some(p => id.startsWith(p))) {
      score += 10;
    }

    // +5 per goal word found in element text
    for (const word of goalWords) {
      if (text.includes(word)) {
        score += 5;
      }
    }

    // +3 — not a legal/footer link
    if (!legalTerms.some(term => text.includes(term))) {
      score += 3;
    }

    // +2 — has a meaningful predictedEffect
    if (el.predictedEffect && typeof el.predictedEffect === 'string' && el.predictedEffect.length > 5) {
      score += 2;
    }

    // -5 — non-interactive content node
    if (contentPrefixes.some(p => id.startsWith(p))) {
      score -= 5;
    }

    // -3 — text too short or too long to be useful
    if (text.length < 2 || text.length > 100) {
      score -= 3;
    }

    return { el, score };
  });

  // Sort descending and keep top 25
  const top = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 25)
    .map(s => s.el);

  return { ...graph, elements: top };
}

module.exports = { pruneGraph };
