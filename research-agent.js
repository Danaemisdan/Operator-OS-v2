'use strict';

/**
 * RESEARCH AGENT — ARCHITECTURE.md
 *
 * Two modes:
 *   1. HEADLESS — external DuckDuckGo + direct HTTP fetching.
 *      Separate from the main browser. Fast, parallel, no interference.
 *      Used for: company lookup, news, leads, tech research, app info.
 *
 *   2. HEADFUL — uses the Operator OS browser (webview).
 *      Used for: pages that require login/JS/interaction.
 *      Caller passes in a webContentsId + page graph already extracted.
 *
 * Skill functions (structured output — not prose):
 *   searchLeads(criteria)         → [{name, title, company, url, source}]
 *   lookupCompany(name)           → {name, website, description, size, funding, tech_stack}
 *   lookupApp(name)               → {name, website, category, pricing, competitors, founded}
 *   searchNews(topic, days)       → [{title, url, date, summary}]
 *   extractPageData(url, schema)  → structured JSON matching schema
 *   researchHeadless(query, cb)   → markdown report (legacy, kept for UI stream)
 *
 * Never mixes with automation. Returns data. Automation acts on data.
 */

const https = require('https');
const http  = require('http');

// ─── Low-level HTTP ──────────────────────────────────────────────────────────

function fetchPage(url, redirectsLeft = 3, timeoutMs = 12000) {
  return new Promise((resolve) => {
    if (redirectsLeft < 0) return resolve('');
    let parsed;
    try { parsed = new URL(url); } catch { return resolve(''); }

    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let loc = res.headers.location;
        if (!loc.startsWith('http')) loc = `${parsed.protocol}//${parsed.host}${loc}`;
        res.resume();
        return resolve(fetchPage(loc, redirectsLeft - 1, timeoutMs));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8').slice(0, 300000)));
      res.on('error',() => resolve(''));
    });
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.on('error',   () => resolve(''));
    req.end();
  });
}

// Parallel fetch — up to N URLs at once
async function fetchAll(urls, maxConcurrent = 5) {
  const results = [];
  for (let i = 0; i < urls.length; i += maxConcurrent) {
    const batch = urls.slice(i, i + maxConcurrent);
    const fetched = await Promise.all(batch.map(u => fetchPage(u)));
    results.push(...fetched);
  }
  return results;
}

// ─── HTML → clean text ───────────────────────────────────────────────────────

function extractText(html, maxChars = 4000) {
  if (!html) return '';
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t.slice(0, maxChars);
}

// Extract specific data from HTML using regex patterns
function extractMeta(html) {
  const get = (pattern) => { const m = html.match(pattern); return m ? m[1].trim() : ''; };
  return {
    title:       get(/<title[^>]*>([^<]{1,200})<\/title>/i),
    description: get(/<meta[^>]+name="description"[^>]+content="([^"]{1,400})"/i) ||
                 get(/<meta[^>]+content="([^"]{1,400})"[^>]+name="description"/i),
    ogTitle:     get(/<meta[^>]+property="og:title"[^>]+content="([^"]{1,200})"/i),
    ogDesc:      get(/<meta[^>]+property="og:description"[^>]+content="([^"]{1,400})"/i),
  };
}

// ─── DuckDuckGo search ───────────────────────────────────────────────────────

function parseDDGResults(html, maxResults = 8) {
  if (!html) return [];
  const results = [];
  const linkRx    = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRx = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const links = []; let m;
  while ((m = linkRx.exec(html)) !== null) {
    let url = m[1];
    if (url.includes('uddg=')) {
      try { const u = url.match(/[?&]uddg=([^&]+)/); if (u) url = decodeURIComponent(u[1]); } catch {}
    }
    if (url.startsWith('//')) url = 'https:' + url;
    if (!url.startsWith('http')) continue;
    links.push({ url, title: m[2].replace(/<[^>]+>/g, '').trim() });
  }
  const snippets = []; let s;
  while ((s = snippetRx.exec(html)) !== null) snippets.push(s[1].replace(/<[^>]+>/g, '').trim());
  for (let i = 0; i < Math.min(maxResults, links.length); i++) {
    results.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] || '' });
  }
  return results;
}

async function ddgSearch(query, maxResults = 8) {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const html = await fetchPage(url);
  return parseDDGResults(html, maxResults);
}

// ─── LLM extraction helper ───────────────────────────────────────────────────

async function llmExtract(systemPrompt, userPrompt, maxTokens = 600) {
  const body = JSON.stringify({
    model: 'operator-engine-3b',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
    temperature: 0.1,
    max_tokens: maxTokens,
    stream: false,
  });
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 8080,
      path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 20000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString());
          resolve(json.choices?.[0]?.message?.content || '');
        } catch { resolve(''); }
      });
      res.on('error', () => resolve(''));
    });
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.on('error', () => resolve(''));
    req.write(body);
    req.end();
  });
}

function parseJSON(text, fallback = null) {
  const candidates = [];
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' || text[i] === '[') { if (depth === 0) start = i; depth++; }
    else if (text[i] === '}' || text[i] === ']') {
      depth--;
      if (depth === 0 && start !== -1) { candidates.push(text.substring(start, i + 1)); start = -1; }
    }
  }
  for (const c of candidates) {
    try { return JSON.parse(c); } catch {}
  }
  return fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// SKILL FUNCTIONS — structured output, never prose
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find leads based on criteria.
 * Sources: DuckDuckGo search, open directories, news.
 * Returns: [{name, title, company, url, email?, source}]
 */
async function searchLeads(criteria) {
  const { role, industry, location, source = 'web', limit = 20 } = criteria;

  const queries = [
    `${role} ${industry} ${location || ''} site:linkedin.com/in`,
    `${role} ${industry} ${location || ''} email contact`,
    `${role} at ${industry} company director OR VP OR founder`,
  ].filter(Boolean);

  const allResults = [];
  for (const q of queries.slice(0, 2)) {
    const results = await ddgSearch(q, 10);
    allResults.push(...results);
  }

  // Deduplicate by URL
  const seen = new Set();
  const unique = allResults.filter(r => { if (seen.has(r.url)) return false; seen.add(r.url); return true; });

  // Extract structured lead data from snippets using LLM
  const context = unique.slice(0, 12).map(r => `URL: ${r.url}\nTitle: ${r.title}\nSnippet: ${r.snippet}`).join('\n\n');
  const raw = await llmExtract(
    'You extract structured lead data. Return ONLY a JSON array, no other text.',
    `Extract sales leads from these search results. Criteria: ${JSON.stringify(criteria)}\n\nResults:\n${context}\n\nReturn JSON array:\n[{"name":"","title":"","company":"","url":"","source":"web"}]`,
    800
  );

  const leads = parseJSON(raw, []);
  return Array.isArray(leads) ? leads.slice(0, limit) : [];
}

/**
 * Look up structured info about a company.
 * Returns: {name, website, description, size, funding, founded, hq, tech_stack, linkedin, crunchbase}
 */
async function lookupCompany(companyName) {
  const queries = [
    `${companyName} company overview funding employees`,
    `${companyName} crunchbase OR linkedin`,
    `site:${companyName.toLowerCase().replace(/\s+/g, '')}.com about`,
  ];

  const searchResults = await ddgSearch(queries[0], 5);
  const urls = searchResults.map(r => r.url).slice(0, 3);
  const pages = await fetchAll(urls);

  const context = searchResults.map((r, i) => {
    const meta = extractMeta(pages[i] || '');
    const text = extractText(pages[i] || '', 1500);
    return `Source: ${r.url}\nTitle: ${meta.title || r.title}\nDescription: ${meta.description || r.snippet}\nContent: ${text}`;
  }).join('\n\n---\n\n');

  const raw = await llmExtract(
    'You extract structured company data. Return ONLY valid JSON, no other text.',
    `Extract information about "${companyName}" from these sources:\n\n${context.slice(0, 8000)}\n\nReturn JSON:\n{"name":"","website":"","description":"","size":"","funding":"","founded":"","hq":"","tech_stack":[],"linkedin":"","crunchbase":""}`,
    500
  );

  return parseJSON(raw, { name: companyName, website: '', description: '', size: '', funding: '' });
}

/**
 * Look up structured info about an app or service.
 * Returns: {name, website, category, pricing, description, competitors, founded, users, tech_stack}
 */
async function lookupApp(appName) {
  const queries = [
    `${appName} app pricing review features`,
    `${appName} alternatives competitors`,
    `site:${appName.toLowerCase().replace(/\s+/g, '')}.com pricing`,
  ];

  const searchResults = await ddgSearch(queries[0], 6);
  const urls = searchResults.map(r => r.url).slice(0, 3);
  const pages = await fetchAll(urls);

  const context = searchResults.map((r, i) => {
    const meta = extractMeta(pages[i] || '');
    const text = extractText(pages[i] || '', 2000);
    return `Source: ${r.url}\nTitle: ${meta.title || r.title}\nDesc: ${meta.description || r.snippet}\nContent: ${text}`;
  }).join('\n\n---\n\n');

  // Competitors search
  const altResults = await ddgSearch(queries[1], 4);
  const altContext = altResults.map(r => `${r.title}: ${r.snippet}`).join('\n');

  const raw = await llmExtract(
    'You extract structured SaaS/app data. Return ONLY valid JSON.',
    `Extract info about the app/service "${appName}":\n\n${context.slice(0, 6000)}\n\nAlternatives search results:\n${altContext}\n\nReturn JSON:\n{"name":"","website":"","category":"","pricing":"","description":"","competitors":[],"founded":"","users":""}`,
    600
  );

  return parseJSON(raw, { name: appName, website: '', category: '', pricing: '' });
}

/**
 * Search recent news about a topic.
 * Returns: [{title, url, date, summary, source}]
 */
async function searchNews(topic, days = 7, limit = 10) {
  const timeFilter = days <= 1 ? 'd' : days <= 7 ? 'w' : days <= 30 ? 'm' : 'y';
  const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(topic + ' news')}&df=${timeFilter}`;
  const html = await fetchPage(ddgUrl);
  const results = parseDDGResults(html, limit);

  if (results.length === 0) return [];

  // Fetch top 3 full pages for richer summaries
  const topUrls = results.slice(0, 3).map(r => r.url);
  const pages = await fetchAll(topUrls);

  return results.map((r, i) => ({
    title:  r.title,
    url:    r.url,
    date:   '', // DuckDuckGo HTML doesn't expose dates reliably
    summary: pages[i] ? extractText(pages[i], 500) : r.snippet,
    source: (() => { try { return new URL(r.url).hostname.replace('www.', ''); } catch { return ''; } })(),
  }));
}

/**
 * Fetch a page and extract structured data matching a schema.
 * schema = {field: "description of what to extract"}
 * Returns: JSON object matching schema keys.
 */
async function extractPageData(url, schema) {
  const html = await fetchPage(url);
  if (!html) return {};
  const meta = extractMeta(html);
  const text = extractText(html, 5000);

  const schemaStr = JSON.stringify(schema, null, 2);
  const raw = await llmExtract(
    'You extract structured data from web pages. Return ONLY valid JSON matching the schema.',
    `Page URL: ${url}\nPage title: ${meta.title}\nPage description: ${meta.description}\n\nContent:\n${text}\n\nExtract data matching this schema:\n${schemaStr}\n\nReturn JSON with exactly these keys filled in from the page content.`,
    800
  );

  return parseJSON(raw, {});
}

/**
 * Multi-source research on any topic.
 * Fetches top N results in parallel, extracts text, summarizes.
 * Used for: "research X", "find out about Y", "tell me about Z".
 * Returns streaming via onToken callback + full report string.
 */
async function researchHeadless(query, onToken) {
  onToken(`🔍 **Research Agent** — headless DDG search: "${query}"\n\n`);

  const results = await ddgSearch(query, 8);
  if (results.length === 0) { onToken('❌ No results found.\n'); return 'No results.'; }

  onToken(`📋 Found ${results.length} sources. Fetching top pages in parallel...\n\n`);

  // Parallel fetch of top 4 pages
  const topUrls  = results.slice(0, 4).map(r => r.url);
  const pages    = await fetchAll(topUrls, 4);

  let reportContext = `Research topic: "${query}"\n\n`;
  results.slice(0, 4).forEach((r, i) => {
    const meta = extractMeta(pages[i] || '');
    const text = extractText(pages[i] || '', 3000);
    onToken(`📖 Read: ${meta.title || r.title} (${r.url})\n`);
    reportContext += `## Source ${i + 1}: ${meta.title || r.title}\nURL: ${r.url}\n${meta.description ? 'Description: ' + meta.description + '\n' : ''}${text}\n\n`;
  });

  onToken(`\n🧠 Synthesizing...\n\n`);

  // Streaming LLM summary
  const prompt = `You are a research assistant. The user asked: "${query}"\n\nHere is content from the top web search results:\n\n${reportContext.slice(0, 14000)}\n\nWrite a clear, concise, well-structured research summary. Use markdown headings, bullet points, and include key facts, numbers, and sources where available.`;

  const body = JSON.stringify({
    model: 'operator-engine-3b',
    messages: [
      { role: 'system', content: 'You are a precise research assistant. No hallucinations. Only what the sources say.' },
      { role: 'user',   content: prompt },
    ],
    temperature: 0.2,
    max_tokens: 1200,
    stream: true,
  });

  return new Promise((resolve) => {
    let full = '', buffer = '';
    const req = http.request({
      hostname: '127.0.0.1', port: 8080,
      path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 30000,
    }, (res) => {
      res.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data: ') || t === 'data: [DONE]') continue;
          try { const tok = JSON.parse(t.slice(6)).choices?.[0]?.delta?.content; if (tok) { full += tok; onToken(tok); } } catch {}
        }
      });
      res.on('end',   () => resolve(full));
      res.on('error', () => resolve(full || 'Error generating summary.'));
    });
    req.on('timeout', () => { req.destroy(); resolve(full || 'Timeout.'); });
    req.on('error',   () => resolve('LLM offline.'));
    req.write(body);
    req.end();
  });
}

// ─── Headful research (uses Operator OS browser, called from renderer) ────────
// This is a signal-only export. The actual execution happens in renderer.js
// via the normal task executor — we just provide the skill definitions here
// so the Planner knows what headful research can do.

const HEADFUL_RESEARCH_SKILLS = {
  linkedin_profile_search: {
    description: 'Search LinkedIn for profiles matching criteria. Requires browser with LinkedIn session.',
    inputs:  { query: 'string', filters: 'object' },
    outputs: { profiles: 'array of {name, title, company, url}' },
  },
  linkedin_company_page: {
    description: 'Extract structured data from a LinkedIn company page.',
    inputs:  { company_url: 'string' },
    outputs: { name: 'string', employees: 'string', about: 'string', jobs_count: 'number' },
  },
  twitter_profile_data: {
    description: 'Extract public Twitter/X profile information.',
    inputs:  { handle: 'string' },
    outputs: { bio: 'string', followers: 'number', following: 'number', recent_tweets: 'array' },
  },
  product_hunt_apps: {
    description: 'Browse Product Hunt for apps in a category.',
    inputs:  { category: 'string', sort: 'string' },
    outputs: { apps: 'array of {name, tagline, votes, url}' },
  },
};

module.exports = {
  // Headless skills
  searchLeads,
  lookupCompany,
  lookupApp,
  searchNews,
  extractPageData,
  researchHeadless,
  // Utilities
  fetchPage,
  fetchAll,
  extractText,
  extractMeta,
  parseDDGResults,
  ddgSearch,
  // Headful skill definitions
  HEADFUL_RESEARCH_SKILLS,
};
