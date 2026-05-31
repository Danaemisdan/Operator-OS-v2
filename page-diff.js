'use strict';

/**
 * page-diff.js — Content-diff engine for step completion and loop detection.
 *
 * Replaces URL-only step checks and same-fingerprint loop detection.
 * Works on SPAs, embedded content, popups — anything the DOM graph captures.
 */

/**
 * Take a lightweight snapshot of a graph for diffing.
 */
function snapshot(graph) {
  const els = graph.elements || [];
  const ids  = new Set(els.map(e => e.id));
  const vals  = {};
  els.forEach(e => { if (e.value || e.text) vals[e.id] = (e.value || '') + '|' + (e.text || '').slice(0, 40); });
  return {
    ids,
    vals,
    title:   (graph.title || '').toLowerCase(),
    url:     graph.url || '',
    textKey: els.filter(e => e.id?.startsWith('TXT')).slice(0, 5).map(e => (e.text || '').slice(0, 30)).join('|'),
  };
}

/**
 * Diff two snapshots. Returns change summary.
 *
 * @param {object} prev  — snapshot before action
 * @param {object} curr  — snapshot after action
 * @returns {{ appeared, removed, changed, moved, isEmpty, score }}
 */
function diffSnapshots(prev, curr) {
  const appeared = [...curr.ids].filter(id => !prev.ids.has(id));
  const removed  = [...prev.ids].filter(id => !curr.ids.has(id));
  const changed  = [...curr.ids].filter(id =>
    prev.ids.has(id) && prev.vals[id] !== undefined && prev.vals[id] !== curr.vals[id]
  );

  const titleChanged = prev.title !== curr.title;
  const urlChanged   = prev.url   !== curr.url;
  const textChanged  = prev.textKey !== curr.textKey;

  const total = Math.max(prev.ids.size, 1);
  const score = (appeared.length + removed.length + changed.length) / total;

  // isEmpty = literally nothing changed at all
  const isEmpty = appeared.length === 0 && removed.length === 0 &&
                  changed.length === 0 && !titleChanged && !urlChanged && !textChanged;

  return { appeared, removed, changed, titleChanged, urlChanged, textChanged, score, isEmpty };
}

/**
 * Decide if the diff represents meaningful page movement toward a step.
 *
 * Thresholds (tuned for 3B model response):
 *  - score >= 0.15  → significant element turnover
 *  - OR title changed
 *  - OR URL changed
 *  - OR visible text changed
 */
function pageMoved(diff) {
  return diff.score >= 0.15 || diff.titleChanged || diff.urlChanged || diff.textChanged;
}

/**
 * Check if the current page likely satisfies the NEXT step.
 * Fast keyword heuristic — no LLM needed.
 *
 * @param {object} graph       — current active graph
 * @param {string} nextStep    — next plan step text
 * @returns {boolean}
 */
function pageMatchesStep(graph, nextStep) {
  if (!nextStep) return false;

  const haystack = [
    graph.url || '',
    graph.title || '',
    ...(graph.elements || [])
      .filter(e => e.id?.startsWith('TXT'))
      .slice(0, 10)
      .map(e => e.text || ''),
  ].join(' ').toLowerCase();

  // Extract meaningful keywords from the step (skip stopwords + action verbs)
  const STOP = new Set(['navigate','go','to','the','a','an','on','in','at','and','or','for',
    'search','find','click','type','open','visit','browse','look','check','see',
    'is','are','was','will','should','do','does','get','set','use']);
  const keywords = nextStep.toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP.has(w));

  if (keywords.length === 0) return false;
  const matches = keywords.filter(kw => haystack.includes(kw));
  // Step is satisfied if >50% of meaningful keywords appear in current page
  return matches.length >= Math.max(1, Math.ceil(keywords.length * 0.5));
}

/**
 * Format diff as a human-readable string for the model's context.
 */
function formatDiff(diff) {
  const lines = [];
  if (diff.appeared.length > 0) lines.push(`+ appeared: ${diff.appeared.slice(0, 6).join(', ')}`);
  if (diff.removed.length  > 0) lines.push(`- removed: ${diff.removed.slice(0, 6).join(', ')}`);
  if (diff.changed.length  > 0) lines.push(`~ changed: ${diff.changed.slice(0, 6).join(', ')}`);
  if (diff.titleChanged)        lines.push(`~ page title changed`);
  if (diff.urlChanged)          lines.push(`~ URL changed`);
  if (lines.length === 0)       lines.push('(no change detected)');
  return lines.join('\n');
}

module.exports = { snapshot, diffSnapshots, pageMoved, pageMatchesStep, formatDiff };
