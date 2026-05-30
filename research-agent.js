'use strict';

const https = require('https');
const http = require('http');

/**
 * Fetch a URL and return the HTML body as a string.
 * - Handles both http and https
 * - Follows redirects (max 3)
 * - 10-second timeout
 * - Returns empty string on any error
 */
function fetchPage(url, redirectsLeft = 3) {
  return new Promise((resolve) => {
    if (redirectsLeft < 0) return resolve('');

    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return resolve('');
    }

    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      timeout: 10000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; OperatorOS/1.0; +https://operator.ai)',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    };

    const req = lib.request(options, (res) => {
      // Follow redirects
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        let redirectUrl = res.headers.location;
        // Handle relative redirects
        if (!redirectUrl.startsWith('http')) {
          redirectUrl = `${parsed.protocol}//${parsed.host}${redirectUrl}`;
        }
        res.resume(); // Discard body
        resolve(fetchPage(redirectUrl, redirectsLeft - 1));
        return;
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', () => resolve(''));
    });

    req.on('timeout', () => {
      req.destroy();
      resolve('');
    });

    req.on('error', () => resolve(''));
    req.end();
  });
}

/**
 * Strip all HTML tags and return readable plain text.
 * - Removes <script> and <style> blocks entirely (including their content)
 * - Removes all remaining HTML tags
 * - Collapses whitespace
 * - Returns first 3000 characters
 */
function extractText(html) {
  if (!html) return '';

  // Remove <script ...>...</script> blocks
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  // Remove <style ...>...</style> blocks
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  // Replace block-level tags with newlines for readability
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br|section|article|header|footer)>/gi, '\n');
  // Remove all remaining tags
  text = text.replace(/<[^>]+>/g, ' ');
  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  // Collapse whitespace (but preserve single newlines)
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  return text.slice(0, 3000);
}

/**
 * Parse DuckDuckGo HTML search results.
 * Returns an array of up to 5 { title, url, snippet } objects.
 *
 * DuckDuckGo HTML structure (html.duckduckgo.com/html/):
 *   Result titles:  <a class="result__a" href="...">Title Text</a>
 *   Result snippets: <a class="result__snippet">...Snippet Text...</a>
 */
function parseDDGResults(html) {
  if (!html) return [];

  const results = [];

  // Match result links: capture href and inner text
  const linkRegex = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  // Match result snippets
  const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const links = [];
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const href = linkMatch[1];
    const title = linkMatch[2].replace(/<[^>]+>/g, '').trim();
    links.push({ href, title });
  }

  const snippets = [];
  let snippetMatch;
  while ((snippetMatch = snippetRegex.exec(html)) !== null) {
    const snippet = snippetMatch[1].replace(/<[^>]+>/g, '').trim();
    snippets.push(snippet);
  }

  for (let i = 0; i < Math.min(5, links.length); i++) {
    let url = links[i].href;

    // DuckDuckGo often uses redirect URLs like //duckduckgo.com/l/?uddg=...
    // Decode them to get the real destination URL
    if (url.includes('uddg=')) {
      try {
        const uddg = url.match(/[?&]uddg=([^&]+)/);
        if (uddg) url = decodeURIComponent(uddg[1]);
      } catch (e) { /* keep original */ }
    }
    // Handle protocol-relative URLs
    if (url.startsWith('//')) url = 'https:' + url;

    // Skip non-http URLs
    if (!url.startsWith('http')) continue;

    results.push({
      title: links[i].title || url,
      url,
      snippet: snippets[i] || '',
    });
  }

  return results;
}

/**
 * Main research function.
 * @param {string} query - The search query / topic to research.
 * @param {function} onToken - Called with each string chunk as the report is built.
 * @returns {Promise<string>} The full consolidated markdown report.
 */
async function researchHeadless(query, onToken) {
  onToken('🔍 Searching DuckDuckGo for: ' + query + '\n\n');

  const ddgUrl =
    'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const ddgHtml = await fetchPage(ddgUrl);
  const results = parseDDGResults(ddgHtml);

  if (results.length === 0) {
    onToken('❌ No results found.\n');
    return 'No results found.';
  }

  onToken(`📋 Found ${results.length} results. Fetching top pages...\n\n`);

  let reportContext = `Research Results for: ${query}\n\n`;

  for (let i = 0; i < Math.min(3, results.length); i++) {
    const result = results[i];
    onToken(`📖 Reading: ${result.title}\n`);

    const pageHtml = await fetchPage(result.url);
    const text = extractText(pageHtml);
    reportContext += `## Source: ${result.title}\n${text}\n\n`;
  }
  
  onToken(`\n🧠 Synthesizing report...\n\n`);

  // Call LLM to summarize
  const prompt = `You are a research assistant. The user asked: "${query}".
Here is the text extracted from the top web search results:

${reportContext.slice(0, 12000)}

Please write a clear, concise, and informative research summary that answers the user's request using the provided information. Use markdown formatting.`;

  const body = JSON.stringify({
    model: 'operator-engine-3b',
    messages: [
      { role: 'system', content: 'You are a helpful research assistant.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.3,
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
      },
      (res) => {
        let full = '';
        let buffer = '';
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
              if (token) {
                full += token;
                onToken(token);
              }
            } catch (e) {}
          }
        });
        res.on('end', () => resolve(full));
        res.on('error', () => resolve(full + '\n\n[Error generating summary]'));
      }
    );
    req.on('error', () => resolve('LLM server offline.'));
    req.write(body);
    req.end();
  });
}

module.exports = { researchHeadless, fetchPage, extractText, parseDDGResults };
