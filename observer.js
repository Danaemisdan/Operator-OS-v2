'use strict';
const http = require('http');

/**
 * OBSERVER AI — Dedicated page state observer.
 *
 * Role (from ARCHITECTURE.md):
 *   After every action, describe what actually happened on screen. Objectively.
 *   NEVER plans. NEVER decides. ONLY reports state.
 *
 * Input:  current DOM graph + last action taken + what was expected
 * Output: { state, what_changed, blockers, confidence, next_hint }
 */
async function observePageState({ graph, lastAction, expectation, goalContext }) {
  const url = graph.url || '';
  const title = graph.title || '';

  const interactiveEls = (graph.elements || []).filter(e =>
    e.id && (e.id.startsWith('BTN') || e.id.startsWith('INP') || e.id.startsWith('LNK'))
  );
  const textEls = (graph.elements || []).filter(e =>
    e.id && e.id.startsWith('TXT') && e.text && e.text.length > 2 && e.text.length < 120
  );
  const visibleTexts = textEls.slice(0, 10).map(e => `"${e.text}"`).join(', ');

  // ── Heuristic blockers (no LLM needed) ───────────────────────────────────────
  const allText = (graph.elements || []).map(e => (e.text || '').toLowerCase()).join(' ');
  const blockers = [];

  if (allText.includes('sign in') || allText.includes('log in') || allText.includes('create account')) {
    if (url.includes('accounts.') || url.includes('login') || url.includes('signin')) {
      blockers.push('login_required');
    }
  }
  if (allText.includes('captcha') || allText.includes("i'm not a robot") || allText.includes('verify you')) {
    blockers.push('captcha_detected');
  }
  if (allText.includes('cookie') && (allText.includes('accept') || allText.includes('agree'))) {
    blockers.push('cookie_banner');
  }
  if (allText.includes('before you continue') || allText.includes('consent')) {
    blockers.push('consent_dialog');
  }

  // ── Build observer prompt ─────────────────────────────────────────────────────
  const prompt = `You are an Observer AI. Your ONLY job is to describe the current state of a webpage after an action was taken.
You do NOT plan. You do NOT decide what to do next. You ONLY report what you see.

Goal context: ${goalContext || 'Unknown'}
Last action taken: ${lastAction || 'None'}
Expected result: ${expectation || 'Unknown'}

Current page state:
- URL: ${url}
- Title: ${title}
- Visible text: ${visibleTexts || 'none'}
- Interactive elements (${interactiveEls.length}):
${interactiveEls.slice(0, 15).map(e => `  [${e.id}] "${e.text || ''}" — ${e.predictedEffect || e.role || ''}`).join('\n')}
${blockers.length > 0 ? `\nDetected blockers: ${blockers.join(', ')}` : ''}

Answer ONLY with this JSON (no other text):
{
  "state": "machine_readable_state_name",
  "what_changed": "one sentence: what visibly changed after the action",
  "action_succeeded": true_or_false,
  "blockers": ${JSON.stringify(blockers)},
  "confidence": 0.0_to_1.0,
  "next_hint": "one sentence: what the planner should try next"
}`;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'operator-engine-3b',
      messages: [
        { role: 'system', content: 'You are a JSON-only page state observer. Never plan. Never decide. Only describe what you see.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.05,
      max_tokens: 250,
      stream: true,
    });

    let buffer = '';
    let full = '';

    const req = http.request({
      hostname: '127.0.0.1', port: 8080,
      path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, (res) => {
      res.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data: ')) continue;
          const p = t.slice(6);
          if (p === '[DONE]') continue;
          try { const tok = JSON.parse(p).choices?.[0]?.delta?.content; if (tok) full += tok; } catch (_) {}
        }
      });
      res.on('end', () => resolve(parseObserverOutput(full, blockers, lastAction)));
      res.on('error', () => resolve(fallbackObservation(blockers, lastAction)));
    });

    req.on('timeout', () => { req.destroy(); resolve(fallbackObservation(blockers, lastAction)); });
    req.on('error', () => resolve(fallbackObservation(blockers, lastAction)));
    req.write(body);
    req.end();
  });
}

function parseObserverOutput(full, blockers, lastAction) {
  // Try all JSON objects in the response
  const candidates = [];
  let depth = 0, start = -1;
  for (let i = 0; i < full.length; i++) {
    if (full[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (full[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) { candidates.push(full.substring(start, i + 1)); start = -1; }
    }
  }
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      if (obj.state || obj.what_changed) {
        return {
          state: obj.state || 'unknown',
          what_changed: obj.what_changed || 'Unknown',
          action_succeeded: obj.action_succeeded !== false,
          blockers: obj.blockers || blockers,
          confidence: typeof obj.confidence === 'number' ? obj.confidence : 0.7,
          next_hint: obj.next_hint || '',
        };
      }
    } catch (_) {}
  }
  return fallbackObservation(blockers, lastAction);
}

function fallbackObservation(blockers, lastAction) {
  return {
    state: 'unknown',
    what_changed: `Action "${lastAction || 'unknown'}" was taken`,
    action_succeeded: blockers.length === 0,
    blockers,
    confidence: 0.5,
    next_hint: blockers.length > 0 ? `Resolve blocker: ${blockers[0]}` : 'Continue with next step',
  };
}

// ── Recovery Agent ────────────────────────────────────────────────────────────
/**
 * RECOVERY AGENT — Finds an alternative when expected element is missing.
 *
 * Role (from ARCHITECTURE.md):
 *   When an expected element is missing, find the equivalent and continue.
 *   Updates the Knowledge Graph after every successful recovery.
 */
async function recoverMissingElement({ targetText, targetId, currentElements, goal, siteMemory }) {
  const elementList = (currentElements || [])
    .filter(e => e.id && (e.id.startsWith('BTN') || e.id.startsWith('INP') || e.id.startsWith('LNK')))
    .slice(0, 20)
    .map(e => `  [${e.id}] "${e.text || ''}" — ${e.predictedEffect || ''}`)
    .join('\n');

  const prompt = `You are a Recovery Agent. An expected UI element is missing. Find the best alternative.

Goal: ${goal}
Missing element: "${targetText || targetId || 'unknown'}"
${siteMemory ? `Site knowledge: ${siteMemory}` : ''}

Current page elements:
${elementList || '  (no interactive elements found)'}

Which element on the current page is the best substitute for the missing one?
If nothing is a reasonable substitute, say null.

Respond ONLY with JSON:
{
  "found": true_or_false,
  "target_id": "element_id_or_null",
  "target_text": "element_text",
  "reasoning": "why this is a good substitute",
  "confidence": 0.0_to_1.0
}`;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'operator-engine-3b',
      messages: [
        { role: 'system', content: 'You are a JSON-only recovery agent. Find alternative UI elements.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 200,
      stream: true,
    });

    let buffer = '', full = '';

    const req = http.request({
      hostname: '127.0.0.1', port: 8080,
      path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, (res) => {
      res.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data: ')) continue;
          const p = t.slice(6);
          if (p === '[DONE]') continue;
          try { const tok = JSON.parse(p).choices?.[0]?.delta?.content; if (tok) full += tok; } catch (_) {}
        }
      });
      res.on('end', () => resolve(parseRecoveryOutput(full)));
      res.on('error', () => resolve({ found: false }));
    });

    req.on('timeout', () => { req.destroy(); resolve({ found: false }); });
    req.on('error', () => resolve({ found: false }));
    req.write(body);
    req.end();
  });
}

function parseRecoveryOutput(full) {
  const candidates = [];
  let depth = 0, start = -1;
  for (let i = 0; i < full.length; i++) {
    if (full[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (full[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) { candidates.push(full.substring(start, i + 1)); start = -1; }
    }
  }
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      if (typeof obj.found !== 'undefined') return obj;
    } catch (_) {}
  }
  return { found: false };
}

module.exports = { observePageState, recoverMissingElement };
