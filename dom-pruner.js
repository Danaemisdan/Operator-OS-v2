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

  const stepLower = (goalText || '').toLowerCase();
  
  // 1. Intent Classification
  let intent = 'default';
  if (stepLower.match(/\b(search|find|query|look for)\b/)) {
    intent = 'search';
  } else if (stepLower.match(/\b(login|sign in|auth|account|register)\b/)) {
    intent = 'auth';
  } else if (stepLower.match(/\b(filter|sort|refine)\b/)) {
    intent = 'filter';
  } else if (stepLower.match(/\b(extract|compare|read|view|list|top)\b/)) {
    intent = 'content';
  } else if (stepLower.match(/\b(navigate|go to|open)\b/)) {
    intent = 'navigate';
  }

  // 2. Zone Mapping
  // Determine which chunk of the UI is most relevant to the intent
  let targetZones = [];
  if (intent === 'search' || intent === 'navigate') {
    targetZones = ['Header', 'Header Area', 'Navigation', 'Main Content'];
  } else if (intent === 'auth') {
    targetZones = ['Main Content', 'Form Area', 'Header Area'];
  } else if (intent === 'filter') {
    targetZones = ['Sidebar', 'Main Content', 'Navigation'];
  } else if (intent === 'content') {
    targetZones = ['Main Content'];
  } else {
    // Default fallback
    targetZones = ['Main Content', 'Header Area', 'Form Area'];
  }

  // 3. Filter Graph by Zone
  // Overlays/Popups must ALWAYS bypass the filter so the agent can dismiss them!
  const filtered = graph.elements.filter(el => {
     if (el.isOverlay) return true;
     // If the element's zone matches the intent's target zones, keep it.
     // Also keep anything we explicitly labeled as 'Form Area' if searching or authing.
     return targetZones.includes(el.zone) || !el.zone;
  });

  // Sort them spatially (top to bottom) so it reads naturally
  filtered.sort((a, b) => (a.position?.y || 0) - (b.position?.y || 0));

  // Cap at 150 elements for the specific chunk to prevent token overflow
  return { ...graph, elements: filtered.slice(0, 150), intent, targetZones };
}

module.exports = { pruneGraph };
