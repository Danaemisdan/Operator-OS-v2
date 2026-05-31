'use strict';

const http = require('http');

/**
 * Call the local LLM to decompose a high-level goal into 2–5 richly-described steps.
 * The planner ALWAYS runs. Skills are execution pipeline tools — not plan replacements.
 */
async function decomposeGoal(goal, availableSkills, currentUrl, sender, pageContext) {
  // pageContext: optional { url, title, pageType, pageSummary } from exploration
  const ctx = pageContext || {};
  const pageInfo = ctx.url
    ? `Current page: ${ctx.url}\nPage type: ${ctx.pageType || 'unknown'}\nPage title: ${ctx.title || ''}`
    : `Current page: ${currentUrl || 'New tab (no page loaded)'}`;

  const prompt =
    `You are a browser task planning agent. Break the goal into 2-5 specific sequential steps.\n` +
    `Output ONLY a raw JSON object. No prose, no markdown. Start with { immediately.\n\n` +

    `STEP RULES:\n` +
    `- Every "find/search/show/look up" task MUST have at least 2 steps: (1) navigate+search, (2) report what you found.\n` +
    `- Steps must include actual site names, exact queries, and filter values from the goal.\n` +
    `- Group related sub-actions. "search Google for X and click first result" is ONE step.\n` +
    `- Never split: "click Submit" is not a step — the executor handles UI details.\n` +
    `- Good plan for "find cheap water bottles": ["search Google Shopping for cheap water bottles under 500", "report the top 3 results with names and prices"]\n` +
    `- Good plan for "book flight NYC to LA": ["search Google Flights for cheapest one-way NYC to LA next week", "report the cheapest options found"]\n\n` +

    `CLARIFYING QUESTIONS — ask when the goal is a CATEGORY, not a specific thing:\n` +
    `ASK when you see these patterns:\n` +
    `  "find me a job" → job role? location? remote or on-site?\n` +
    `  "find me some X" where X is a category (furniture, shoes, phone) → what type? budget?\n` +
    `  "book a flight / hotel / restaurant" → where from? where to? when? how many?\n` +
    `  "buy something / buy me a gift" → what category? budget?\n` +
    `  "follow people on instagram" → who? what criteria?\n` +
    `  "send a message" → to whom? what to say?\n` +
    `  "post something" → on which platform? what content?\n` +
    `  "order food" → from where? what do you want?\n` +
    `  "search for good ones" → good what? category? price range?\n` +
    `DO NOT ask when the goal is already specific:\n` +
    `  "search YouTube for lofi music" → specific enough\n` +
    `  "open amazon.com" → specific enough\n` +
    `  "find cheap iPhone 15 Pro on Amazon" → specific enough\n` +
    `  "search Google for water bottles under 500" → specific enough\n` +
    `Max 2 questions. questions:[] only if FULLY specified with a clear search target.\n\n` +

    `AVAILABLE SKILLS:\n` +
    `${availableSkills.length > 0 ? availableSkills.map(s => `- ${s}`).join('\n') : '- (none)'}\n\n` +

    `Output format:\n` +
    `{"questions":[],"research_needed":false,"research_skill":null,"research_args":null,"steps":["step 1","step 2"]}\n\n` +

    `${pageInfo}\n` +
    `Goal: "${goal}"\n\n` +
    `Output ONLY JSON:`;

  const body = JSON.stringify({
    model: 'operator-engine-3b',
    messages: [
      { role: 'system', content: 'You are a JSON-only planning agent. Never write prose. Always respond with only a raw JSON object. Be specific — include the actual names, queries, and targets from the goal in every step.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.15,
    max_tokens: 500,
    stream: true,
  });

  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 8080,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 45000,
      },
      (res) => {
        let buffer = '';
        let full = '';

        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            const payload = trimmed.slice(6);
            if (payload === '[DONE]') continue;
            try {
              const parsed = JSON.parse(payload);
              const token = parsed.choices?.[0]?.delta?.content;
              if (token) full += token;
            } catch (e) {}
          }
        });

        res.on('end', () => {
          resolve(parseSteps(full, goal));
        });

        res.on('error', () => resolve({ steps: [goal], current: 0 }));
      }
    );

    req.on('timeout', () => { req.destroy(); resolve({ steps: [goal], current: 0 }); });
    req.on('error', () => resolve({ steps: [goal], current: 0 }));
    req.write(body);
    req.end();
  });
}

/**
 * Multi-strategy parser for the model's response.
 */
function parseSteps(full, goal) {
  const jsonCandidates = [];
  let depth = 0, start = -1;
  for (let i = 0; i < full.length; i++) {
    if (full[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (full[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        jsonCandidates.push(full.substring(start, i + 1));
        start = -1;
      }
    }
  }
  for (const candidate of jsonCandidates) {
    try {
      const obj = JSON.parse(candidate);
      if (Array.isArray(obj.steps) && obj.steps.length > 0) {
        const steps = obj.steps
          .map(s => {
            if (s && typeof s === 'object') {
              const a = s.action || s.type || '';
              const detail = s.url || s.text || s.query || s.target ||
                s.searchTerm || s.searchQuery || s.term || s.value ||
                s.description || s.step || s.instruction || '';
              if (a && detail) return `${a} ${detail}`.trim();
              if (detail) return detail;
              if (a) return a;
              const vals = Object.values(s).filter(v => typeof v === 'string' && v.length > 2);
              return vals.length > 0 ? vals.join(' ') : JSON.stringify(s);
            }
            return String(s);
          })
          .map(s => s
            .replace(/^(\d+[.)]\s*)/, '')
            .replace(/^(step\s*\d+\s*[:.)\\-]\s*)/i, '')
            .trim()
          )
          .filter(s => s.length > 3 && s !== '[object Object]');
        // Filter garbage steps — tool-name + status strings from confused model output
        const GARBAGE_STEP = /^(navigate|type|click|scroll|press_enter|reply|ask_user)\s+(running|complete|done|failed|error|pending)$/i;
        const cleanSteps = steps.filter(s => !GARBAGE_STEP.test(s.trim()));
        if (cleanSteps.length > 0) {
          const planQuestions = Array.isArray(obj.questions)
            ? obj.questions.filter(q => typeof q === 'string' && q.length > 3)
            : [];

          // ── Deterministic question injection ──────────────────────────────
          // If LLM returned no questions but the goal is clearly underspecified,
          // inject questions ourselves. Do NOT rely solely on the 3B model.
          const goalL = goal.toLowerCase();
          const detectedQs = [];
          if (planQuestions.length === 0) {
            if (/\bbook\s+(a|me|the)?\s*(flight|ticket|seat)\b/i.test(goal) && !/\bfrom\b.+\bto\b/i.test(goal))
              detectedQs.push('Where are you flying from and to, and on what date?');
            if (/\bbook\s+(a|me|the)?\s*(hotel|room|stay)\b/i.test(goal) && !/\b(city|in|at)\b/i.test(goal))
              detectedQs.push('Which city and what dates?');
            if (/\bfind\s+me\s+(a\s+)?job\b/i.test(goal))
              detectedQs.push('What job role and location are you looking for? Remote or on-site?');
            if (/\b(buy|order|get)\s+(me\s+)?(a\s+)?gift\b/i.test(goal))
              detectedQs.push('What kind of gift and what\'s your budget?');
            if (/\bpost\s+(a|something|an?\s+update)\b/i.test(goal) && !/\binstagram|twitter|facebook|linkedin|reddit\b/i.test(goal))
              detectedQs.push('Which platform do you want to post on, and what should I post?');
            if (/\bsend\s+(a\s+)?message\b/i.test(goal) && !/\bto\s+\w+/i.test(goal))
              detectedQs.push('Who should I send the message to, and what should it say?');
            if (/\bfollow\s+people\b/i.test(goal))
              detectedQs.push('Who should I follow — any specific criteria or search terms?');
            if (/\bfind\s+me\s+(some|a|good|cheap|best)\b/i.test(goal) && /\bgood\s+ones?\b/i.test(goal))
              detectedQs.push('What type of item are you looking for, and do you have a budget in mind?');
          }
          const allQuestions = [...planQuestions, ...detectedQs].slice(0, 2);

          // ── Enforce minimum 2 steps for find/search/show tasks ─────────────
          // Any task whose goal is to find/show/report something needs a reply step.
          const needsReport = /\b(find|search|show|look up|tell me|what|list|compare)\b/i.test(goal);
          const lastStep = cleanSteps[cleanSteps.length - 1].toLowerCase();
          const alreadyHasReport = /\b(report|summarise|summarize|reply|tell|show|list|compare|answer)\b/i.test(lastStep);
          if (needsReport && !alreadyHasReport && cleanSteps.length < 2) {
            cleanSteps.push('report the top results found — names, prices, and key details');
          }

          return {
            steps: cleanSteps,
            questions: allQuestions,
            current: 0,
            research_needed:  obj.research_needed === true,
            research_skill:   obj.research_skill   || null,
            research_args:    obj.research_args    || null,
          };
        }
      }
    } catch (_) {}
  }

  // Strategy 2: extract numbered lines from prose
  const lines = full.split('\n');
  const numbered = lines
    .map(l => l.trim())
    .filter(l => /^(\d+[.\)]\s+|[-•*]\s+|step\s*\d+[:.\\-]\s*)/i.test(l))
    .map(l => l.replace(/^(\d+[.\)]\s+|[-•*]\s+|step\s*\d+[:.\\-]\s*)/i, '').trim())
    .filter(l => l.length > 5);
  if (numbered.length > 0) return { steps: numbered, questions: [], current: 0, research_needed: false, research_skill: null, research_args: null };

  return { steps: [goal], questions: [], current: 0, research_needed: false, research_skill: null, research_args: null };
}

async function executePlan(plan, stepExecutor, onProgress) {
  const { steps } = plan;
  for (let i = plan.current; i < steps.length; i++) {
    if (typeof onProgress === 'function') {
      onProgress(i, steps.length, steps[i]);
    }
    await stepExecutor(steps[i], i);
  }
}

module.exports = { decomposeGoal, executePlan };
