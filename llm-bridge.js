'use strict';
const http = require('http');

// ─── UI Analysis (heuristic, no LLM needed) ───────────────────────────────────
function analyzeUIWithLLM(graph) {
  const url = (graph.url || '').toLowerCase();
  const els = graph.elements || [];

  // ── Page pattern: multi-signal convergence, not single URL checks ──────────
  // Each signal votes, highest total wins. No hardcoded site names.
  const allText = els.map(e => (e.text || '').toLowerCase()).join(' ');
  const urlPath = url.replace(/https?:\/\/[^/]+/, '');

  const patternVotes = {
    'Authentication / Sign-in Page':     0,
    'E-Commerce / Shopping':             0,
    'Search Results Page':               0,
    'Search Engine Homepage':            0,
    'Video Platform':                    0,
    'Social Media / Feed':               0,
    'Code Repository':                   0,
    'Email / Messaging':                 0,
    'Application Dashboard':             0,
    'News / Article Page':               0,
    'Generic Web Page':                  1, // baseline
  };

  // URL path signals
  if (/\/(login|signin|sign-in|auth|oauth|sso|account\/login)/.test(urlPath)) patternVotes['Authentication / Sign-in Page'] += 3;
  if (/\/(search|results|find|query|s\?)/.test(urlPath)) patternVotes['Search Results Page'] += 2;
  if (/\/(watch|video|player|videos)/.test(urlPath)) patternVotes['Video Platform'] += 2;
  if (/\/(cart|checkout|order|buy|purchase)/.test(urlPath)) patternVotes['E-Commerce / Shopping'] += 2;
  if (/\/(inbox|mail|compose|message|chat)/.test(urlPath)) patternVotes['Email / Messaging'] += 2;
  if (/\/(dashboard|analytics|admin|console|panel)/.test(urlPath)) patternVotes['Application Dashboard'] += 2;
  if (/\/(repo|commit|pull|issues|blob)/.test(urlPath)) patternVotes['Code Repository'] += 2;
  if (/\/(feed|timeline|post|profile|followers)/.test(urlPath)) patternVotes['Social Media / Feed'] += 2;
  if (/\/(article|news|story|post|blog)/.test(urlPath)) patternVotes['News / Article Page'] += 2;
  if (/^\/?$|^\/\?/.test(urlPath)) patternVotes['Search Engine Homepage'] += 1; // root path

  // Interactive element signals
  const hasPasswordInput = els.some(e => e.inputType === 'password');
  const hasSearchInput   = els.some(e => e.id?.startsWith('INP') && ((e.placeholder || '').toLowerCase().includes('search') || (e.name || '') === 'q'));
  const hasVideoPlayer   = els.some(e => e.tag === 'video');
  const hasPriceText     = allText.match(/\$[\d,]+|\d+\.\d{2}|add to cart/);
  const hasCodeText      = allText.includes('commit') || allText.includes('pull request') || allText.includes('repository');

  if (hasPasswordInput)  { patternVotes['Authentication / Sign-in Page'] += 2; }
  if (hasSearchInput && urlPath === '' || urlPath === '/') patternVotes['Search Engine Homepage'] += 2;
  if (hasSearchInput && urlPath.includes('search')) patternVotes['Search Results Page'] += 2;
  if (hasVideoPlayer)    { patternVotes['Video Platform'] += 3; }
  if (hasPriceText)      { patternVotes['E-Commerce / Shopping'] += 2; }
  if (hasCodeText)       { patternVotes['Code Repository'] += 2; }

  const pattern = Object.entries(patternVotes).sort((a, b) => b[1] - a[1])[0][0];

  // ── Per-element labels: derive from ALL available context signals ──────────
  // No predetermined keyword lists — signals from the element itself.
  const predictions = {};

  els.forEach(el => {
    if (!el.id) return;

    // Gather all text signals from the element
    const labelText   = (el.text || '').trim();
    const placeholder = (el.placeholder || '').trim();
    const ariaLabel   = (el.ariaLabel || el['aria-label'] || '').trim();
    const nameAttr    = (el.name || '').trim();
    const hrefPath    = (el.href || '').replace(/https?:\/\/[^/]+/, '').toLowerCase();
    const inputType   = (el.inputType || '').toLowerCase();
    const role        = (el.role || '').toLowerCase();
    const tag         = (el.tag || '').toLowerCase();

    // Primary descriptor: best human-readable signal available
    const primaryLabel = ariaLabel || placeholder || labelText || nameAttr;

    if (el.id.startsWith('INP')) {
      // Input: describe what it's for, not what it IS
      if (inputType === 'password') {
        predictions[el.id] = `Password field${ariaLabel ? ` — ${ariaLabel}` : ''}`;
      } else if (inputType === 'email') {
        predictions[el.id] = `Email address field${ariaLabel ? ` — ${ariaLabel}` : ''}`;
      } else if (inputType === 'search' || nameAttr === 'q' || role === 'search' || (placeholder || '').toLowerCase().includes('search')) {
        predictions[el.id] = `Search box${placeholder ? ` — "${placeholder}"` : ''}`;
      } else if (inputType === 'checkbox') {
        predictions[el.id] = `Checkbox: ${primaryLabel || 'toggle option'}`;
      } else if (inputType === 'radio') {
        predictions[el.id] = `Radio button: ${primaryLabel || 'select option'}`;
      } else {
        predictions[el.id] = primaryLabel
          ? `Text field: "${primaryLabel.substring(0, 50)}"`
          : `Text input field`;
      }
      return;
    }

    if (el.id.startsWith('BTN')) {
      // Button: describe what clicking it DOES, derived from its label + context
      if (!labelText && !ariaLabel) {
        // Icon-only button — use context clues
        if (hrefPath.includes('close') || hrefPath.includes('dismiss')) {
          predictions[el.id] = `Close / dismiss button`;
        } else {
          predictions[el.id] = `Unlabelled button (icon only)`;
        }
        return;
      }
      // Use the label directly — it's the most honest description
      // Add context about what kind of action it is
      const lc = primaryLabel.toLowerCase();
      if (inputType === 'submit' || lc === 'submit' || lc === 'send' || lc === 'go' || lc === 'search') {
        predictions[el.id] = `Submit / confirm button: "${labelText}"`;
      } else if (lc.includes('close') || lc.includes('dismiss') || lc === '✕' || lc === 'x' || lc === '×') {
        predictions[el.id] = `Close/dismiss: "${labelText}" — closes this modal or overlay`;
      } else if (lc.includes('sign in') || lc.includes('log in')) {
        predictions[el.id] = `Authentication button: "${labelText}" — starts login flow`;
      } else if (lc.includes('sign up') || lc.includes('register') || lc.includes('join')) {
        predictions[el.id] = `Registration button: "${labelText}" — creates new account`;
      } else if (lc.includes('continue with') || lc.includes('sign in with')) {
        predictions[el.id] = `OAuth login: "${labelText}" — authenticates via third party`;
      } else {
        predictions[el.id] = `Button: "${primaryLabel.substring(0, 50)}"`;
      }
      return;
    }

    if (el.id.startsWith('LNK')) {
      // Link: describe destination, derived from text + href path
      if (primaryLabel.length > 0 && primaryLabel.length < 80) {
        const dest = hrefPath.split('/').filter(Boolean)[0] || '';
        predictions[el.id] = dest
          ? `Link to "${primaryLabel}" (${dest} section)`
          : `Link: "${primaryLabel.substring(0, 60)}"`;
      } else if (hrefPath) {
        const segment = hrefPath.split('/').filter(Boolean)[0] || hrefPath;
        predictions[el.id] = `Link to /${segment}`;
      } else {
        predictions[el.id] = `Navigation link`;
      }
      return;
    }

    predictions[el.id] = primaryLabel ? `Element: "${primaryLabel.substring(0, 40)}"` : `Interactive element`;
  });

  return Promise.resolve({ semanticPattern: pattern, predictions });
}

// ─── Main Agent Chat (with full conversation history for chat mode) ────────────
async function chatAgentWithLLM(promptText, graph, previousActions = [], sender, memory = '', conversationHistory = [], silent = false) {
  // Chat mode = no page context passed (empty graph). Executor mode = real graph provided.
  const isChatMode = !graph.url && (!graph.elements || graph.elements.length === 0);

  // Build page context — always inject when we have a real graph (both chat AND executor)
  let pageContext = '';
  if (graph.url || (graph.elements && graph.elements.length > 0)) {
    const els = graph.elements || [];

    // Visible text content — what the user actually SEES on the page
    const textContent = els
      .filter(e => e.id && e.id.startsWith('TXT') && e.text && e.text.length > 2 && e.text.length < 150)
      .slice(0, 12)
      .map(e => e.text.trim())
      .join(' | ');

    // Link labels visible on page (text of links, not their hrefs)
    const linkLabels = els
      .filter(e => e.id && e.id.startsWith('LNK') && e.text && e.text.length > 1 && e.text.length < 40)
      .slice(0, 10)
      .map(e => e.text.trim())
      .join(', ');

    // Interactive elements (for executor mode)
    const interactiveEls = els.filter(e =>
      e.id && (e.id.startsWith('BTN') || e.id.startsWith('INP') || e.id.startsWith('LNK'))
    );

    pageContext = `\n\nCurrent browser page:
- URL: ${graph.url || 'unknown'}
- Title: ${graph.title || 'Unknown'}
- Page type: ${graph.semanticPattern || 'Unknown'}
- Visible page text: ${textContent || '(none captured)'}
- Visible links/buttons: ${linkLabels || '(none)'}
- Interactive elements (${interactiveEls.length} total):
${interactiveEls.slice(0, 15).map(e => {
  const val = e.value ? ` [current value: "${e.value}"]` : '';
  return `  [${e.id}] "${e.text || ''}"${val} — ${e.predictedEffect || e.role || ''}`;
}).join('\n')}`;
  }

  // Chat system prompt: minimal by default, expanded only when page context is attached
  const hasChatPageContext = !!pageContext;
  const systemPrompt = isChatMode
    ? (hasChatPageContext
        ? `You are Operator, a browser AI. Answer ONLY from the page context below — never guess or hallucinate page content.\nBe concise.${pageContext}`
        : `You are Operator, a browser AI assistant. Be concise and conversational.`)
    : `You are the Operator Executor Agent controlling a real browser.${pageContext}
${memory ? `\nPast memory:\n${memory}` : ''}
Actions so far: ${previousActions.length === 0 ? 'None' : previousActions.slice(-6).join(' | ')}

RULES:
- Study the page elements carefully. INP_ = input field, BTN_ = button, LNK_ = navigation link, TXT_ = visible text.
- Read TXT_ elements to understand what page you are actually on before deciding what to do.
- If the page shows "not found", "404", "page doesn't exist", "uh-oh", or similar error text → the URL was wrong. Use navigate to go to the site's homepage instead.
- If a popup, modal, cookie banner, or overlay is blocking an otherwise correct page, dismiss it first.
- If you are already on the correct site/page, do NOT navigate again — take the next action.
- NEVER use the reply tool during task execution. reply is only for when the task is complete and you have a result to share.
- If you already typed into a field, do NOT type again — press_enter or click submit instead.
- If you already pressed enter, do NOT press enter again — read the new page first.
- Output status="complete" ONLY when the goal is actually visible/verified on screen.
- ONE tool per response. No extra text outside the JSON.

Tools: navigate(args.text=URL), click(args.targetId=ID), type(args.targetId=ID,args.text=text), press_enter(no args), scroll(args.text=up|down), reply(args.text=result_summary), ask_user(args.text=question), research(args.text=query)

Respond with ONLY this JSON:
{"thought":"one sentence reasoning","expectation":"what should change on screen after this action","status":"running|complete","tool":"toolname","args":{"targetId":null,"text":null},"extracted_data":"If complete, summarize what was found/done, else null"}`;

  const messages = isChatMode
    ? [
        { role: 'system', content: systemPrompt },
        ...conversationHistory.slice(-12), // last 6 turns — smaller context = faster inference
        { role: 'user', content: promptText },
      ]
    : [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Goal: ${promptText}` },
      ];

  return new Promise((resolve) => {
    let buffer = '';
    let fullContent = '';
    let resolved = false;

    const body = JSON.stringify({
      model: 'operator-engine-3b',
      messages,
      temperature: isChatMode ? 0.7 : 0.05,
      max_tokens: isChatMode ? 500 : 350,
      stream: true,
    });

    const req = http.request({
      hostname: '127.0.0.1',
      port: 8080,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      res.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === 'data: [DONE]') {
            if (!resolved) { resolved = true; resolveResponse(fullContent, isChatMode, resolve); }
            return;
          }
          if (trimmed.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(trimmed.slice(6));
              const token = parsed.choices?.[0]?.delta?.content;
              if (token) {
                fullContent += token;
                // Stream tokens to UI only in chat mode — executor JSON stays hidden
                if (isChatMode && !silent && sender && !sender.isDestroyed()) {
                  sender.send('agent-stream-chunk', token);
                }
              }
              if (parsed.choices?.[0]?.finish_reason === 'stop' && !resolved) {
                resolved = true;
                resolveResponse(fullContent, isChatMode, resolve);
              }
            } catch (_) {}
          }
        }
      });
      res.on('end', () => { if (!resolved) { resolved = true; resolveResponse(fullContent, isChatMode, resolve); } });
      res.on('error', () => { if (!resolved) { resolved = true; resolve({ tool: 'reply', args: { text: 'Stream error.' }, status: 'error' }); } });
    });

    req.on('error', () => { if (!resolved) { resolved = true; resolve({ tool: 'reply', args: { text: 'LLM server offline.' }, status: 'error' }); } });
    req.write(body);
    req.end();
  });
}

// ─── Response parser ──────────────────────────────────────────────────────────
function resolveResponse(fullContent, isChatMode, resolve) {
  if (isChatMode) {
    resolve({ tool: 'reply', args: { text: fullContent.trim() }, status: 'complete' });
    return;
  }
  // Try direct JSON extraction
  try {
    const m = fullContent.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      if (parsed.tool || parsed.status) { resolve(parsed); return; }
    }
  } catch (_) {}
  // Regex fallback for partial JSON from small models
  const tool   = (fullContent.match(/"tool"\s*:\s*"([^"]+)"/) || [])[1];
  const status = (fullContent.match(/"status"\s*:\s*"([^"]+)"/) || [])[1];
  const thought= (fullContent.match(/"thought"\s*:\s*"([^"]+)"/) || [])[1];
  const expectation = (fullContent.match(/"expectation"\s*:\s*"([^"]+)"/) || [])[1];
  const tid    = (fullContent.match(/"targetId"\s*:\s*"([^"]+)"/) || [])[1];
  const txt    = (fullContent.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/) || [])[1];
  const extData= (fullContent.match(/"extracted_data"\s*:\s*"((?:[^"\\]|\\.)*)"/) || [])[1];
  
  if (tool || status === 'complete') {
    resolve({
      thought: thought || '',
      expectation: expectation || '',
      status: status || 'running',
      tool: tool || 'reply',
      extracted_data: extData ? extData.replace(/\\n/g, '\n').replace(/\\"/g, '"') : null,
      args: {
        targetId: tid && tid !== 'null' ? tid : null,
        text: txt ? txt.replace(/\\n/g, '\n').replace(/\\"/g, '"') : null,
      },
    });
  } else {
    resolve({ tool: 'reply', args: { text: fullContent.trim() || 'No action.' }, status: 'complete' });
  }
}

module.exports = { analyzeUIWithLLM, chatAgentWithLLM };
