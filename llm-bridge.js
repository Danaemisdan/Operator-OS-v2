'use strict';
const http = require('http');

// ─── UI Analysis (heuristic, no LLM needed) ───────────────────────────────────
function analyzeUIWithLLM(graph) {
  const url = (graph.url || '').toLowerCase();
  const textStr = (graph.elements || []).map(e => (e.text || '').toLowerCase()).join(' ');

  let pattern = 'Generic Web Page';
  if (url.includes('login') || url.includes('signin') || url.includes('auth') || url.includes('accounts.'))
    pattern = 'Authentication / Sign-in Portal';
  else if (textStr.includes('inbox') || textStr.includes('compose') || url.includes('mail'))
    pattern = 'Email / Messaging Application';
  else if (textStr.includes('add to cart') || textStr.includes('checkout') || url.includes('store') || url.includes('shop'))
    pattern = 'E-Commerce / Storefront';
  else if (textStr.includes('feed') || textStr.includes('followers') || url.includes('twitter') || url.includes('instagram') || url.includes('linkedin'))
    pattern = 'Social Media Feed';
  else if (url.includes('github'))
    pattern = 'Code Repository';
  else if (url.includes('youtube'))
    pattern = 'Video Platform';
  else if (url.includes('google.com/search') || url.includes('duckduckgo') || url.includes('bing.com'))
    pattern = 'Search Results Page';
  else if (url.includes('google.com') && !url.includes('accounts.'))
    pattern = 'Search Engine Homepage';
  else if (textStr.includes('dashboard') || textStr.includes('analytics'))
    pattern = 'Application Dashboard';

  const predictions = {};
  (graph.elements || []).forEach(el => {
    const t = (el.text || '').toLowerCase().trim();
    const rawText = (el.text || '').trim();
    const href = (el.href || '').toLowerCase();
    const role = (el.role || '').toLowerCase();
    const placeholder = (el.placeholder || '').toLowerCase();
    if (!el.id) return;

    // ── Inputs: describe by placeholder or role ─────────────────────
    if (el.id.startsWith('INP')) {
      const label = placeholder || t || 'text';
      if (label.includes('search') || role.includes('search') || href.includes('search'))
        predictions[el.id] = `Search box — type a query here to search the page`;
      else if (label.includes('email') || label.includes('mail'))
        predictions[el.id] = `Email address input field`;
      else if (label.includes('password') || label.includes('pass'))
        predictions[el.id] = `Password input field`;
      else if (label.includes('user') || label.includes('username') || label.includes('name'))
        predictions[el.id] = `Username / name input field`;
      else
        predictions[el.id] = `Text input field for: "${label.substring(0, 40)}"`;
      return;
    }

    // ── Common action verbs on buttons / links ───────────────────────
    if (t.includes('sign in') || t.includes('log in') || t.includes('login'))
      return void (predictions[el.id] = 'Opens sign-in / login authentication flow');
    if (t.includes('sign up') || t.includes('register') || t.includes('create account'))
      return void (predictions[el.id] = 'Opens account registration / sign-up flow');
    if (t.includes('sign out') || t.includes('log out') || t.includes('logout'))
      return void (predictions[el.id] = 'Logs the user out of their account');
    if (t.includes('submit') || t.includes('send') || t.includes('confirm') || t.includes('done'))
      return void (predictions[el.id] = `Submits or confirms: "${rawText.substring(0, 40)}"`);
    if (t.includes('next') || t.includes('continue'))
      return void (predictions[el.id] = 'Proceeds to the next step in the flow');
    if (t.includes('back') || t.includes('previous') || t.includes('cancel'))
      return void (predictions[el.id] = 'Goes back or cancels the current action');
    if (t.includes('search'))
      return void (predictions[el.id] = 'Submits the search query');
    if (t.includes('add to cart') || t.includes('buy') || t.includes('purchase') || t.includes('checkout'))
      return void (predictions[el.id] = `E-commerce action: "${rawText.substring(0, 40)}"`);
    if (t.includes('connect') || t.includes('follow') || t.includes('message'))
      return void (predictions[el.id] = `Social action: "${rawText.substring(0, 40)}"`);
    if (t.includes('close') || t.includes('dismiss') || t.includes('skip') || t.includes('no thanks'))
      return void (predictions[el.id] = `Closes or dismisses a modal/popup: "${rawText.substring(0, 40)}"`);
    if (t.includes('allow') || t.includes('accept') || t.includes('agree') || t.includes('ok'))
      return void (predictions[el.id] = `Accepts a prompt or cookie/permission dialog`);

    // ── Links: use href to describe destination ──────────────────────
    if (el.id.startsWith('LNK')) {
      if (href.includes('mail') || href.includes('gmail'))
        predictions[el.id] = `Navigates to Gmail / email inbox`;
      else if (href.includes('cart') || href.includes('checkout'))
        predictions[el.id] = `Navigates to shopping cart or checkout page`;
      else if (href.includes('account') || href.includes('profile') || href.includes('settings'))
        predictions[el.id] = `Navigates to account, profile, or settings page`;
      else if (href.includes('search'))
        predictions[el.id] = `Navigates to search results page`;
      else if (rawText.length > 1 && rawText.length < 60)
        predictions[el.id] = `Navigates to the "${rawText.substring(0, 40)}" section or page`;
      else
        predictions[el.id] = `Navigation link`;
      return;
    }

    // ── Buttons with meaningful text ─────────────────────────────────
    if (el.id.startsWith('BTN')) {
      if (rawText.length > 1 && rawText.length < 60)
        predictions[el.id] = `Triggers the "${rawText.substring(0, 40)}" action`;
      else
        predictions[el.id] = `Interactive button`;
      return;
    }

    predictions[el.id] = `Interactive element`;
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
${interactiveEls.slice(0, 15).map(e => `  [${e.id}] "${e.text || ''}" — ${e.predictedEffect || e.role || ''}`).join('\n')}`;
  }

  // Chat system prompt: minimal by default, expanded only when page context is attached
  const hasChatPageContext = !!pageContext;
  const systemPrompt = isChatMode
    ? (hasChatPageContext
        ? `You are Operator, a browser AI. Answer ONLY from the page context below — never guess or hallucinate page content.\nBe concise.${pageContext}`
        : `You are Operator, a browser AI assistant. Be concise and conversational.`)
    : `You are the Operator Executor Agent controlling a real browser.${pageContext}
${memory ? `\nPast memory:\n${memory}` : ''}
Actions so far: ${previousActions.length === 0 ? 'None' : previousActions.slice(-8).join(' | ')}

RULES:
- Study the page elements carefully. INP_ = input field, BTN_ = button, LNK_ = navigation link, TXT_ = visible text.
- Read TXT_ elements to understand what page you are actually on before deciding what to do.
- If the page shows "not found", "404", "page doesn't exist", "uh-oh", or similar error text → the URL was wrong. Use navigate to go to the site's homepage instead. Do NOT try to dismiss any dialogs on error pages.
- If a popup, modal, cookie banner, or overlay is blocking an otherwise correct page, dismiss it first.
- If you are already on the correct site/page, do NOT navigate again — take the next action.
- If you need critical missing info the user didn't provide, use ask_user. Do NOT ask about things you can infer.
- Output status="complete" ONLY when the goal is actually visible/verified on screen.
- ONE tool per response. No extra text outside the JSON.

Tools: navigate(args.text=URL), click(args.targetId=ID), type(args.targetId=ID,args.text=text), press_enter(no args, submits focused form/search), scroll, reply(args.text=msg), ask_user(args.text=question), research(args.text=query)

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
      max_tokens: isChatMode ? 400 : 300,
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
