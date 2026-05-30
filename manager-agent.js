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
    `You are a task planning agent. Break the user's goal into 2-4 clear, sequential browser steps.\n` +
    `Output ONLY a raw JSON object. No explanation. No prose. No markdown. Start with { immediately.\n\n` +
    `NAVIGATION PRINCIPLE:\n` +
    `You are a language model. You already know the URL of every major website and service.\n` +
    `If a user mentions ANY named service (Amazon, YouTube, LinkedIn, Gmail, Spotify, Netflix, Reddit, GitHub, etc.),\n` +
    `navigate directly to its URL as the first step. NEVER search Google or any search engine to find a site you already know.\n` +
    `Wrong: "Open Google" then "Search for Amazon" then "Navigate to Amazon"\n` +
    `Right: "Navigate to https://www.amazon.com"\n\n` +
    `RESEARCH SKILLS — headless tools that run before the browser opens:\n` +
    `- searchLeads: returns structured list of people matching a role/industry/location\n` +
    `- lookupCompany: returns structured data about a named company\n` +
    `- lookupApp: returns structured data about a named software/app\n` +
    `- searchNews: returns recent news articles on a topic\n` +
    `- extractPageData: extracts structured data from a URL\n\n` +
    `RESEARCH GATE — ask: would the research output directly feed into the browser steps as input?\n` +
    `  YES → set research_needed=true and choose the right skill\n` +
    `  NO  → set research_needed=false and just plan browser steps\n\n` +
    `Research makes sense when: the goal requires gathering a list of targets, contacts, or data points\n` +
    `that the agent will then act on in the browser (open pages, extract info, fill forms).\n` +
    `Research does NOT make sense when: the browser itself can find the answer just by navigating and searching.\n\n` +
    `JSON output format (two variants):\n` +
    `No research: {"research_needed":false,"research_skill":null,"research_args":null,"steps":[...]}\n` +
    `With research: {"research_needed":true,"research_skill":"skillName","research_args":{...},"steps":[...]}\n\n` +
    `Now plan this goal:\n` +
    `Goal: "${goal}"\n` +
    `Current page: ${currentUrl || 'New tab'}\n` +
    `Available skills: ${availableSkills.length > 0 ? availableSkills.join(', ') : 'none'}\n\n` +
    `Output ONLY JSON: {"research_needed":bool,"research_skill":null_or_string,"research_args":null_or_object,"steps":[...]}`;


  const body = JSON.stringify({
    model: 'operator-engine-3b',
    messages: [
      { role: 'system', content: 'You are a JSON-only planning agent. Never write prose. Always respond with only a raw JSON object.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.05,
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
          .map(s => String(s)
            .replace(/^(\d+[.)]\s*)/,    '')
            .replace(/^(step\s*\d+\s*[:.)\-]\s*)/i, '')
            .trim()
          )
          .filter(s => s.length > 3);
        if (steps.length > 0) return {
          steps,
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
  if (numbered.length > 0) return { steps: numbered, current: 0, research_needed: false, research_skill: null, research_args: null };

  // Final fallback: treat the whole goal as a single step
  return { steps: [goal], current: 0, research_needed: false, research_skill: null, research_args: null };
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
