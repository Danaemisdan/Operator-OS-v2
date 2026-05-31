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
    `You are a smart browser task planning agent. Your job is to break the user's goal into 2-5 specific, richly-described sequential steps.\n` +
    `Output ONLY a raw JSON object. No explanation. No prose. No markdown. Start with { immediately.\n\n` +

    `STEP QUALITY RULES — this is the most important part:\n` +
    `- Steps must be GOAL-LEVEL descriptions, not browser instructions. The executor handles clicking/typing.\n` +
    `- Steps must be SPECIFIC to this exact goal — include the actual names, queries, targets from the goal.\n` +
    `- GOOD: "navigate to LinkedIn", "search for 'software engineer jobs in Bangalore'", "click the first job listing that matches the goal"\n` +
    `- BAD: "navigate to a job site", "search for jobs", "click a result" — too vague, the executor is lost\n` +
    `- Navigate steps: always name the site — "navigate to LinkedIn", "navigate to Amazon". Never raw URLs.\n` +
    `- Search steps: include the exact search query derived from the goal.\n` +
    `- Click steps: describe what to click — "click the first furniture result", "click on the cheapest product listed"\n` +
    `- Research/shopping tasks need INTERMEDIATE steps: search → click result → read content → report. Do NOT skip the click step.\n` +
    `- GOOD shopping plan: ["search Google for 'affordable sofas'", "click the first relevant result or site", "find prices on the page", "report cheapest options to the user"]\n` +
    `- BAD shopping plan: ["search Google for 'affordable sofas'", "read and report the price"] — skips navigation to product page!\n` +
    `- Only add a 'report to the user' step AFTER steps that will actually load the relevant data onto the page.\n\n` +

    `CLARIFYING QUESTIONS — ask ONLY when the answer structurally changes the plan:\n` +
    `- What to search for is unknown → ask\n` +
    `- Which platform to use is ambiguous → ask  \n` +
    `- A specific name/date/location is needed → ask\n` +
    `Examples REQUIRING questions:\n` +
    `  "find me a job" → ask: what role? what location? remote or on-site?\n` +
    `  "follow people on instagram" → ask: follow people from where? any search criteria?\n` +
    `  "book a flight" → ask: from? to? when? how many passengers?\n` +
    `  "buy something for my mom" → ask: what kind of thing? what budget?\n` +
    `Examples NOT requiring questions:\n` +
    `  "search youtube for lofi music" → fully specified\n` +
    `  "open amazon" → obvious destination\n` +
    `  "search Amazon for Sony WH-1000XM5 and tell me the price" → fully specified\n` +
    `Max 2 questions. Return questions:[] if goal is fully specified.\n\n` +

    `AVAILABLE SKILLS (execution pipeline shortcuts — use them in steps when relevant):\n` +
    `${availableSkills.length > 0 ? availableSkills.map(s => `- ${s}`).join('\n') : '- (none)'}\n` +
    `Skills run inside the executor pipeline — they don't replace planning. Just mention the goal in the step.\n\n` +

    `RESEARCH TOOLS (headless, run before browser opens):\n` +
    `- searchLeads: structured list of people by role/industry/location\n` +
    `- lookupCompany: structured data about a company\n` +
    `- lookupApp: structured data about a software/app\n` +
    `- searchNews: recent news on a topic\n` +
    `- extractPageData: extract structured data from a URL\n` +
    `Set research_needed=true ONLY if research output directly feeds into browser steps.\n\n` +

    `Output format:\n` +
    `{"questions":[],"research_needed":false,"research_skill":null,"research_args":null,"steps":["specific step 1","specific step 2"]}\n\n` +

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
