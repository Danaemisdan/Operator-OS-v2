'use strict';

const http = require('http');

/**
 * Call the local LLM via streaming SSE to decompose a high-level goal
 * into 2–5 sequential steps.
 *
 * @param {string}   goal            - The high-level goal string.
 * @param {string[]} availableSkills - Names of skills the agent can use.
 * @param {string}   currentUrl      - The current browser URL (context).
 * @param {object}   sender          - Electron WebContents (or null) for streaming chunks to renderer.
 * @returns {Promise<{ steps: string[], current: number }>}
 */
async function decomposeGoal(goal, availableSkills, currentUrl, sender) {
  const prompt =
    `You are a task planning agent. Break the user's goal into 2-5 clear, sequential browser steps.\n` +
    `Output ONLY a raw JSON object. No explanation. No prose. No markdown. Start with { immediately.\n\n` +
    `STEPS FORMAT RULES:\n` +
    `- Every step MUST be a plain English sentence string. NEVER put a JSON object or raw URL inside steps[].\n` +
    `- Navigate steps: say the site name only — "navigate to Instagram", "navigate to Amazon". Never include raw URLs.\n` +
    `- Never construct deep URL paths — let the site's own search/nav do the work once you arrive.\n` +
    `- Steps describe WHAT to do, not HOW to do it in the browser. The executor figures out the HOW.\n` +
    `  GOOD: "navigate to Amazon", "search for Sony WH-1000XM5", "click the first product result"\n` +
    `  BAD: "type amazon.com into the address bar", "type into the search box", "navigate https://..."\n\n` +
    `CLARIFYING QUESTIONS — if the goal is ambiguous, ask before planning:\n` +
    `Ask when missing info directly changes what site to use, what to search for, or who/what to target.\n` +
    `Examples REQUIRING questions:\n` +
    `  "follow people on instagram" → ask: which account to target? any specific criteria?\n` +
    `  "find me a job" → ask: what role? what location?\n` +
    `  "buy something" → ask: what product? what budget?\n` +
    `  "book a flight" → ask: from where? to where? when?\n` +
    `Examples NOT requiring questions:\n` +
    `  "search youtube for lofi music" → specific enough\n` +
    `  "open amazon" → obvious destination\n` +
    `Max 2 questions. Return questions:[] if goal is fully specified.\n\n` +
    `RESEARCH SKILLS — headless tools that run before the browser opens:\n` +
    `- searchLeads: returns structured list of people matching a role/industry/location\n` +
    `- lookupCompany: returns structured data about a named company\n` +
    `- lookupApp: returns structured data about a named software/app\n` +
    `- searchNews: returns recent news articles on a topic\n` +
    `- extractPageData: extracts structured data from a URL\n\n` +
    `RESEARCH GATE — set research_needed=true only if research output feeds directly into browser steps.\n\n` +
    `Output format (steps[] contains ONLY plain string sentences):\n` +
    `{"questions":[],"research_needed":false,"research_skill":null,"research_args":null,"steps":["sentence 1","sentence 2"]}\n\n` +
    `Goal: "${goal}"\n` +
    `Current page: ${currentUrl || 'New tab'}\n` +
    `Available skills: ${availableSkills.length > 0 ? availableSkills.join(', ') : 'none'}\n\n` +
    `Output ONLY JSON:`;



  const body = JSON.stringify({
    model: 'operator-engine-3b',
    messages: [
      { role: 'system', content: 'You are a JSON-only planning agent. Never write prose. Always respond with only a raw JSON object.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.15,
    max_tokens: 400,
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
        timeout: 30000,
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
 * Strategy 1: Find and parse a JSON block with a "steps" array.
 * Strategy 2: Extract numbered list lines from prose as fallback.
 * Always strips "Step N:" prefixes from step text.
 */
function parseSteps(full, goal) {
  // Strategy 1: find ANY valid JSON object containing a "steps" array
  // Use greedy match but also try all JSON-like substrings in case model adds trailing text
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
            // Step is a JSON object — extract the most meaningful text from all possible fields
            if (s && typeof s === 'object') {
              const a = s.action || s.type || '';
              const detail = s.url || s.text || s.query || s.target ||
                s.searchTerm || s.searchQuery || s.term || s.value ||
                s.description || s.step || s.instruction || '';
              // Build a readable sentence instead of stringifying the object
              if (a && detail) return `${a} ${detail}`.trim();
              if (detail) return detail;
              if (a) return a;
              // Last resort: join all string values
              const vals = Object.values(s).filter(v => typeof v === 'string' && v.length > 2);
              return vals.length > 0 ? vals.join(' ') : JSON.stringify(s);
            }
            return String(s);
          })
          .map(s => s
            .replace(/^(\d+[.)]\s*)/, '')
            .replace(/^(step\s*\d+\s*[:.)\-]\s*)/i, '')
            .trim()
          )
          .filter(s => s.length > 3 && s !== '[object Object]');
        if (steps.length > 0) return {
          steps,
          questions: Array.isArray(obj.questions) ? obj.questions.filter(q => typeof q === 'string' && q.length > 3) : [],
          current: 0,
          research_needed:  obj.research_needed === true,
          research_skill:   obj.research_skill   || null,
          research_args:    obj.research_args    || null,
        };
      }
    } catch (_) {}
  }

  // Strategy 2: extract numbered lines from prose (e.g. "1. Do this\n2. Do that")
  const lines = full.split('\n');
  const numbered = lines
    .map(l => l.trim())
    .filter(l => /^(\d+[.\)]\s+|[-•*]\s+|step\s*\d+[:.\-]\s*)/i.test(l))
    .map(l => l.replace(/^(\d+[.\)]\s+|[-•*]\s+|step\s*\d+[:.\-]\s*)/i, '').trim())
    .filter(l => l.length > 5);
  if (numbered.length > 0) return { steps: numbered, questions: [], current: 0, research_needed: false, research_skill: null, research_args: null };

  // Final fallback: treat the whole goal as a single step
  return { steps: [goal], questions: [], current: 0, research_needed: false, research_skill: null, research_args: null };
}

/**
 * Execute a plan produced by decomposeGoal.
 * Iterates through steps and invokes the provided executor for each.
 *
 * @param {{ steps: string[], current: number }} plan
 * @param {function} stepExecutor - async (step: string, index: number) => void
 * @param {function} onProgress   - (current: number, total: number, step: string) => void
 * @returns {Promise<void>}
 */
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
