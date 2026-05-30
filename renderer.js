// Initialize Lucide icons
lucide.createIcons();

const chatInput = document.getElementById('chat-input');
const chatSubmit = document.getElementById('chat-submit');
const chatHistory = document.getElementById('chat-history');

const urlInput = document.getElementById('url-input');
const btnBack = document.getElementById('btn-back');
const btnForward = document.getElementById('btn-forward');
const btnRefresh = document.getElementById('btn-refresh');
const btnNewTab = document.getElementById('btn-new-tab');

const tabsContainer = document.getElementById('browser-tabs');
const webviewContainer = document.getElementById('webview-container');
const loadingBar = document.getElementById('loading-progress-bar');

// Tab Management State
let tabs = [];
let activeTabId = null;
let tabCounter = 0;
let activeGraph = null; // Store the latest Knowledge Graph

// ─── DOM Event Handler ─────────────────────────────────────────────────────
// Receives events from dom-monitor.js running inside each webview.
// Reacts to: notifications, new messages, badges, heartbeats.
// Silently writes interesting data to the Knowledge Graph.

const domEventCooldowns = new Map(); // prevent spam

function handleDomEvent(evt, tabId) {
  const { type, payload, url } = evt;
  if (!payload) return;

  // Cooldown: same event type+text max once per 10s
  const key = `${type}:${payload.kind || ''}:${(payload.text || '').substring(0, 30)}`;
  const last = domEventCooldowns.get(key) || 0;
  if (Date.now() - last < 10000) return;
  domEventCooldowns.set(key, Date.now());

  if (type === 'heartbeat') return; // silent — just keeps agent aware

  // ── Toast notification in chat sidebar ──────────────────────────────────
  if (type === 'dom_change' || type === 'page_snapshot') {
    const kind    = payload.kind || type;
    const text    = payload.text || (payload.notifications || []).map(n => n.text).join(', ') || '';
    const count   = payload.count;
    const isOnActiveTab = tabId === activeTabId;

    if (text && isOnActiveTab) {
      // Show a non-intrusive toast in chat
      const icon = kind === 'new_message' ? '💬' : kind === 'badge' ? '🔔' : kind === 'toast' ? '📣' : '📍';
      const countStr = count != null ? ` (${count})` : '';
      showDomToast(`${icon} <strong>Page event:</strong> ${text.substring(0, 80)}${countStr}`);

      // Auto-store messages/notifications to Knowledge Graph
      if (kind === 'new_message' || kind === 'notification_text') {
        window.electronAPI.kgUpsert('note', text.substring(0, 60), {
          text, url, source: 'dom_monitor', context: kind, date: new Date().toISOString(),
        }).catch(() => {});
      }
    }
  }
}

// Non-intrusive floating toast — shows in the chat sidebar but fades in 6s
function showDomToast(html) {
  const toast = document.createElement('div');
  toast.className = 'message ai dom-toast';
  toast.style.cssText = `
    border-left: 3px solid #6366f1;
    background: rgba(99,102,241,0.06);
    padding: 8px 12px;
    font-size: 0.8rem;
    opacity: 0;
    transition: opacity 0.4s;
  `;
  toast.innerHTML = html;
  chatHistory.appendChild(toast);
  smartScroll();
  requestAnimationFrame(() => { toast.style.opacity = '1'; });
  // Auto-fade after 6 seconds
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 500);
  }, 6000);
}


function createTab(url = 'https://google.com') {
  const tabId = `tab-${tabCounter++}`;
  
  // 1. Create Webview
  const webview = document.createElement('webview');
  webview.id = `wv-${tabId}`;
  webview.src = url;
  webview.setAttribute('autosize', 'on');
  const preloadPath = window.location.href.replace('index.html', 'webview-preload.js');
  webview.setAttribute('preload', preloadPath);
  webviewContainer.appendChild(webview);
  
  // 2. Create Tab UI
  const tabEl = document.createElement('div');
  tabEl.className = 'browser-tab';
  tabEl.id = `ui-${tabId}`;
  tabEl.innerHTML = `
    <span class="tab-title">Loading...</span>
    <button class="tab-close"><i data-lucide="x"></i></button>
  `;
  tabsContainer.appendChild(tabEl);
  lucide.createIcons({ root: tabEl });
  
  const tabObj = { id: tabId, webview, tabEl };
  tabs.push(tabObj);
  
  // Events
  tabEl.addEventListener('click', (e) => {
    if (e.target.closest('.tab-close')) {
      closeTab(tabId);
    } else {
      activateTab(tabId);
    }
  });
  
  webview.addEventListener('did-navigate', (e) => {
    urlInput.value = e.url;
    tabObj.url = e.url;
    tabObj.graph = null; // Clear graph on hard navigation
    if (activeTabId === tabId) {
       activeGraph = null;
       updateDashboardLive({ url: e.url, title: 'Loading...', elementCount: 0, elements: [] });
    }
  });
  
  webview.addEventListener('did-navigate-in-page', (e) => {
    if (activeTabId === tabId) urlInput.value = e.url;
  });
  
  webview.addEventListener('page-title-updated', (e) => {
    tabEl.querySelector('.tab-title').textContent = e.title;
  });
  
  webview.addEventListener('new-window', (e) => {
    e.preventDefault();
    createTab(e.url);
  });
  
  webview.addEventListener('did-start-loading', () => {
    tabEl.querySelector('.tab-title').textContent = 'Loading...';
    if (activeTabId === tabId) showLoading();
  });

  webview.addEventListener('did-stop-loading', () => {
    if (activeTabId === tabId) hideLoading();
  });
  
  webview.addEventListener('dom-ready', async () => {
    try {
      // Inject indexer (UI graph builder)
      const idxResp = await fetch('indexer.js');
      const idxText = await idxResp.text();
      webview.executeJavaScript(idxText).catch(e => console.error('Indexer inject error:', e));

      // Inject DOM monitor (notification/message watcher)
      const monResp = await fetch('dom-monitor.js');
      const monText = await monResp.text();
      webview.executeJavaScript(monText).catch(e => console.error('Monitor inject error:', e));
    } catch (err) {
      console.error('dom-ready inject error:', err);
    }
  });

  // Handle events fired by dom-monitor.js inside the webview
  webview.addEventListener('ipc-message', async (e) => {
    if (e.channel === 'dom-event') {
      try {
        const evt = JSON.parse(e.args[0]);
        handleDomEvent(evt, tabId);
      } catch (_) {}
    }
  });


  let llmDebounce = null;
  webview.addEventListener('ipc-message', async (e) => {
    if (e.channel === 'ui-update') {
      try {
        let graph = JSON.parse(e.args[0]);
        // Debounce expensive LLM calls
        clearTimeout(llmDebounce);
        llmDebounce = setTimeout(async () => {
           try {
              const result = await window.electronAPI.analyzeUI(graph);
              graph.semanticPattern = result.semanticPattern;
              graph.elements.forEach(el => {
                 if (result.predictions && result.predictions[el.id]) {
                    el.predictedEffect = result.predictions[el.id];
                 }
              });
              
              if (activeTabId === tabId) {
                 webview.send('semantic-predictions', result.predictions || {});
                 updateDashboardLive(graph);
              }
           } catch(err) { console.error("LLM API Error:", err); }
        }, 1000);
        
        // Update the tab's internal graph state instantly for speed
        tabObj.graph = graph;
        if (activeTabId === tabId) {
           // Phase 8: Load persistent Knowledge Graph for this domain
           const domain = new URL(graph.url).hostname;
           const knowledge = await window.electronAPI.getKnowledge(domain);
           
           // If we already have a previous semantic pattern, preserve it during fast updates
           if (activeGraph && activeGraph.semanticPattern) {
              graph.semanticPattern = activeGraph.semanticPattern;
              graph.elements.forEach(el => {
                 const oldEl = activeGraph.elements.find(old => old.id === el.id);
                 if (oldEl && oldEl.predictedEffect) el.predictedEffect = oldEl.predictedEffect;
                 
                 // Apply persistent semantic labels from Knowledge Graph!
                 if (knowledge.elements && knowledge.elements[el.id] && knowledge.elements[el.id].semanticLabel) {
                    el.predictedEffect = `[User Defined] ${knowledge.elements[el.id].semanticLabel}`;
                 }
              });
           }
           
           // Save newly discovered elements back to the graph
           const newElements = {};
           graph.elements.forEach(el => { newElements[el.id] = el; });
           await window.electronAPI.saveKnowledge({ domain, elements: newElements });
           
           activeGraph = graph;
           updateDashboardLive(graph);
        }
      } catch(err) {}
    }
  });
  
  activateTab(tabId);
  return tabObj;
}

// UI Loading State
let loadingTimeout;
function showLoading() {
  clearTimeout(loadingTimeout);
  loadingBar.style.transition = 'none';
  loadingBar.classList.remove('done');
  
  // force reflow
  void loadingBar.offsetWidth;
  
  loadingBar.classList.add('loading');
  btnRefresh.innerHTML = '<i data-lucide="x"></i>';
  lucide.createIcons();
}

function hideLoading() {
  loadingBar.classList.remove('loading');
  loadingBar.classList.add('done');
  btnRefresh.innerHTML = '<i data-lucide="rotate-cw"></i>';
  lucide.createIcons();
  
  loadingTimeout = setTimeout(() => {
    loadingBar.classList.remove('done');
    loadingBar.style.opacity = '0';
    setTimeout(() => {
      loadingBar.style.width = '0';
    }, 200);
  }, 400);
}

function activateTab(tabId) {
  activeTabId = tabId;
  tabs.forEach(t => {
    if (t.id === tabId) {
      t.tabEl.classList.add('active');
      t.webview.classList.add('active');
      urlInput.value = t.webview.src || '';
      activeGraph = t.graph || null;
      try {
        if (t.webview.isLoading()) showLoading();
        else hideLoading();
      } catch (e) {}
    } else {
      t.tabEl.classList.remove('active');
      t.webview.classList.remove('active');
    }
  });
}

function closeTab(tabId) {
  const index = tabs.findIndex(t => t.id === tabId);
  if (index === -1) return;
  
  const tab = tabs[index];
  tab.tabEl.remove();
  tab.webview.remove();
  tabs.splice(index, 1);
  
  if (tabs.length === 0) {
    createTab(); // Always keep one tab
  } else if (activeTabId === tabId) {
    // Switch to another tab
    const nextTab = tabs[Math.max(0, index - 1)];
    activateTab(nextTab.id);
  }
}

function getActiveWebview() {
  const tab = tabs.find(t => t.id === activeTabId);
  return tab ? tab.webview : null;
}

// Initialize first tab
createTab();

// Toolbar Actions
urlInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    let url = urlInput.value.trim();
    if (url !== '') {
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
      }
      const wv = getActiveWebview();
      if (wv) wv.src = url;
    }
  }
});

btnBack.addEventListener('click', () => {
  const wv = getActiveWebview();
  if (wv && wv.canGoBack()) wv.goBack();
});

btnForward.addEventListener('click', () => {
  const wv = getActiveWebview();
  if (wv && wv.canGoForward()) wv.goForward();
});

btnRefresh.addEventListener('click', () => {
  const wv = getActiveWebview();
  if (wv) {
    if (wv.isLoading()) {
      wv.stop();
    } else {
      wv.reload();
    }
  }
});

btnNewTab.addEventListener('click', () => {
  createTab();
});

// Chat Logic & Planner Agent Loop
// Rolling conversation history — persists across chat turns so model has full context
const conversationHistory = [];
const MAX_HISTORY_TURNS = 20; // keep last 20 role pairs

function pushToHistory(userMsg, assistantMsg) {
  conversationHistory.push({ role: 'user', content: userMsg });
  conversationHistory.push({ role: 'assistant', content: assistantMsg });
  // Trim to keep last MAX_HISTORY_TURNS messages (pairs)
  while (conversationHistory.length > MAX_HISTORY_TURNS * 2) {
    conversationHistory.splice(0, 2);
  }
}

async function handleChatSubmit() {
  const goalText = chatInput.value.trim();
  if (!goalText) return;

  appendUserMessage(goalText);
  chatInput.value = '';

  // ─── KG shortcut: check before intent classification ─────────────────────
  if (await tryKgChatQuery(goalText)) return;

  // ─── Phase 1: Intent Classification ──────────────────────────────────────
  const intentResult = await window.electronAPI.classifyIntent(goalText);
  const intent = intentResult.intent || 'task';
  appendAiMessage(`<span class="intent-badge intent-${intent}">${intent.toUpperCase().replace('_', ' ')}</span>`);


  if (intent === 'chat') {
    streamDiv = null;
    const chatResponse = await window.electronAPI.agentChat(
      goalText,
      { url: '', title: '', elements: [] },
      [], '',
      conversationHistory
    );

    // streamDiv is set by the streaming handler — if it was used, content is already rendered
    const alreadyStreamed = !!streamDiv;
    const replyText = (streamDiv?.textContent || chatResponse?.args?.text || '').trim();
    streamDiv = null;

    const SITE_NAMES = [
      'linkedin','google','gmail','amazon','twitter','instagram','facebook',
      'youtube','notion','slack','discord','github','reddit','netflix',
      'spotify','hubspot','salesforce','shopify','airbnb','booking','zoom','outlook',
    ];
    const TASK_SIGNALS = [
      'help you','assist you','find','search','navigate','go to','look for',
      'lead','leads','job','jobs','apply','send','message','book','order',
    ];
    const replyLower = replyText.toLowerCase();
    const inputLower = goalText.toLowerCase();
    const combinedLower = replyLower + ' ' + inputLower;

    const siteInReplyOrInput = SITE_NAMES.some(s => combinedLower.includes(s));
    const taskInReply        = TASK_SIGNALS.some(t => replyLower.includes(t));

    if (siteInReplyOrInput && taskInReply) {
      // Strip disclaimers, show only the useful part — but ONLY if streaming didn't already render it
      const disclaimerPhrases = [
        /i('ll need to clarify|'m a browser[- ]based)[^.]*\./gi,
        /i can only provide general guidance[^.]*\./gi,
        /\(and by the way[^)]*\)/gi,
        /i don'?t have (direct )?access[^.]*\./gi,
      ];
      let cleanReply = replyText;
      for (const rx of disclaimerPhrases) cleanReply = cleanReply.replace(rx, '').trim();
      cleanReply = cleanReply.replace(/\n{3,}/g, '\n\n').trim();

      if (!alreadyStreamed && cleanReply) {
        appendAiMessage(cleanReply);
      }
      pushToHistory(goalText, cleanReply || replyText);

      const badge = document.querySelector('.intent-badge');
      if (badge) { badge.textContent = 'TASK'; badge.className = 'intent-badge intent-task'; }
      appendAiMessage(`<em style="opacity:0.6;font-size:0.85em">↳ Escalated to task mode</em>`);
      await handleTaskExecution(goalText);
      return;
    }

    // Pure chat
    if (!alreadyStreamed && replyText) appendAiMessage(replyText);
    pushToHistory(goalText, replyText);
    return;
  }

  if (intent === 'research_for_me') {
    appendAiMessage(`<i data-lucide="search" class="spin"></i> **Research Agent** spinning up...`);
    lucide.createIcons();
    await window.electronAPI.startResearch(goalText);
    return;
  }

  // ─── refreshActiveGraph: re-scan the real live DOM and update activeGraph ────
  async function refreshActiveGraph(wv) {
    try {
      if (!wv || wv.getWebContentsId == null) return;
      const response = await fetch('indexer.js');
      const scriptText = await response.text();
      const resultJson = await wv.executeJavaScript(`
        try { ${scriptText} } catch(e) { JSON.stringify({error: e.message}); }
      `);
      if (!resultJson) return;
      const parsed = JSON.parse(resultJson);
      if (parsed.error) return;
      // Enrich with semantic analysis
      const analysis = await window.electronAPI.analyzeUI(parsed);
      parsed.semanticPattern = analysis.semanticPattern;
      parsed.elements.forEach(el => {
        if (analysis.predictions && analysis.predictions[el.id]) {
          el.predictedEffect = analysis.predictions[el.id];
        }
      });
      activeGraph = parsed;

      // ── Exploration Agent: runs on every page load, zero LLM ──────────────
      // Classifies all elements, detects flows, stores page knowledge in KG.
      // Silent — no UI output. This builds the behavioral map over time.
      try {
        const domain = new URL(parsed.url.startsWith('http') ? parsed.url : 'https://' + parsed.url).hostname;
        const exploration = await window.electronAPI.explorePage({ graph: parsed, domain });
        if (exploration && exploration.enrichedElements) {
          // Merge exploration purposes back into activeGraph elements
          activeGraph.elements = exploration.enrichedElements;
          activeGraph._exploration = exploration.pageKnowledge;
        }
      } catch (_) {}

    } catch (e) {
      console.warn('[refreshActiveGraph] failed:', e.message);
    }
  }

  // ─── askUser: pause and show an input prompt ──────────────────────────────
  function askUser(question) {
    return new Promise((resolve) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'message ai ask-user-prompt';
      wrapper.innerHTML = `
        <div style="margin-bottom:8px">💬 <strong>I need to know:</strong></div>
        <div style="margin-bottom:10px;color:#e4e4e7">${question}</div>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="text" class="agent-q-input" placeholder="Your answer..."
            style="flex:1;background:rgba(255,255,255,0.05);border:1px solid #3f3f46;border-radius:8px;padding:8px 12px;color:white;font-size:0.9rem;outline:none">
          <button class="agent-q-btn"
            style="background:#10b981;color:white;border:none;border-radius:8px;padding:8px 18px;cursor:pointer;font-weight:600">Send</button>
        </div>`;
      chatHistory.appendChild(wrapper);
      smartScroll();
      const input = wrapper.querySelector('.agent-q-input');
      const btn   = wrapper.querySelector('.agent-q-btn');
      input.focus();
      const submit = () => {
        const val = input.value.trim();
        if (!val) return;
        wrapper.style.opacity = '0.5';
        input.disabled = true; btn.disabled = true;
        resolve(val);
      };
      btn.addEventListener('click', submit);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    });
  }

  // ─── waitForPageLoad: resolves on load, error, or timeout ───────────────
  function waitForPageLoad(wv, ms = 8000) {
    return new Promise(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const t = setTimeout(finish, ms);
      // Resolve on successful load OR on navigation failure (ERR_ABORTED, redirects etc.)
      wv.addEventListener('did-stop-loading', () => { clearTimeout(t); finish(); }, { once: true });
      wv.addEventListener('did-fail-load', () => { clearTimeout(t); finish(); }, { once: true });
    });
  }

  // ─── PRE-TASK: Gather missing info before decomposing ──────────────────────
  async function gatherMissingInfo(goal) {
    const gatherPrompt = `You are about to execute this browser task: "${goal}"

What CRITICAL information is missing that makes it impossible to start?
Be very conservative. Only ask if you genuinely cannot proceed without it.
Do NOT ask about method, approach, or preferences — you decide those.
Do NOT ask about things you can figure out from context.
Maximum 2 questions. If you can proceed with reasonable assumptions, return [].

Examples of GOOD questions: ["What email address should I search for?", "What product name should I buy?"]
Examples of BAD questions: ["What type of leads?", "What message to send?", "What method to use?"]

Return ONLY a JSON array of strings (max 2 items), nothing else: ["question1"] or []`;

    try {
      const resp = await window.electronAPI.agentChat(
        gatherPrompt,
        { url: '', title: '', elements: [] },
        [], '', []
      );
      const text = resp?.args?.text || '[]';
      const match = text.match(/\[[\s\S]*?\]/);
      if (!match) return goal;
      const questions = JSON.parse(match[0]);
      if (!Array.isArray(questions) || questions.length === 0) return goal;
      // Hard cap: never ask more than 2 questions
      const capped = questions.slice(0, 2);

      appendAiMessage(`💡 Quick question before I start:`);
      let enrichedGoal = goal;
      for (const q of capped) {
        const answer = await askUser(q);
        enrichedGoal += `\n[${q}: ${answer}]`;
        appendAiMessage(`✓ Got it: **${answer}**`);
      }
      return enrichedGoal;
    } catch (_) {
      return goal;
    }
  }

  // ─── TASK EXECUTION — called from TASK intent path AND chat escalation ─────
  async function handleTaskExecution(rawGoal) {
    const enrichedGoal = await gatherMissingInfo(rawGoal);

  // Phase B: decompose enriched goal into steps
  streamDiv = null;
  const plan = await window.electronAPI.decomposeGoal(enrichedGoal, getActiveWebview().src);
  if (streamDiv) streamDiv = null;

  // ── Research Gate: run research skill BEFORE browser steps if Planner flagged it ──
  let researchContext = '';
  if (plan.research_needed && plan.research_skill) {
    const skillName = plan.research_skill;
    const skillArgs = plan.research_args || {};
    appendAiMessage(`🔬 **Research Agent** running \`${skillName}\` before browser steps...`);
    try {
      let researchResult = null;
      if (skillName === 'searchLeads')    researchResult = await window.electronAPI.researchLeads(skillArgs);
      else if (skillName === 'lookupCompany') researchResult = await window.electronAPI.researchCompany(skillArgs.name || String(skillArgs));
      else if (skillName === 'lookupApp')     researchResult = await window.electronAPI.researchApp(skillArgs.name || String(skillArgs));
      else if (skillName === 'searchNews')    researchResult = await window.electronAPI.researchNews(skillArgs.topic || enrichedGoal, skillArgs.days, skillArgs.limit);
      else if (skillName === 'extractPageData') researchResult = await window.electronAPI.researchExtract(skillArgs.url, skillArgs.schema);

      if (researchResult) {
        const resultStr = JSON.stringify(researchResult, null, 2);
        researchContext = `\n\n[RESEARCH RESULTS from ${skillName}]:\n${resultStr.slice(0, 3000)}`;
        const preview = Array.isArray(researchResult)
          ? `Found **${researchResult.length}** results`
          : `Got structured data: ${Object.keys(researchResult).join(', ')}`;
        appendAiMessage(`✅ Research complete — ${preview}\n\`\`\`json\n${resultStr.slice(0, 600)}${resultStr.length > 600 ? '\n...' : ''}\n\`\`\``);
      }
    } catch (e) {
      appendAiMessage(`⚠️ Research skill failed (${e.message}) — continuing with browser only`);
    }
  }

  // Inject research results into the goal context for the executor
  const executorGoal = researchContext ? enrichedGoal + researchContext : enrichedGoal;

  // Show Research Agent spinner in TPP
  if (plan.research_needed && plan.research_skill) {
    tpp.setResearch(true, `Research Agent — ${plan.research_skill}`);
  }

  const planHtml = plan.steps.map((s, i) => `<li>${i + 1}. ${s}</li>`).join('');
  appendAiMessage(`📋 **Plan:**<ol style="margin:8px 0 0 16px;padding:0">${planHtml}</ol>`);

  // ── Show the Task Progress Panel ────────────────────────────────────────
  tpp.show(rawGoal, plan.steps);
  tpp.setResearch(false);

  let isComplete = false;
  let previousActions = [];
  let currentStepIdx = 0;
  const MAX_ACTIONS_PER_STEP = 12;
  const delay = ms => new Promise(r => setTimeout(r, ms));


  while (!isComplete && currentStepIdx < plan.steps.length) {
    const currentStep = plan.steps[currentStepIdx];
    tpp.setStep(currentStepIdx);
    let actionCount = 0;


    while (!isComplete && actionCount < MAX_ACTIONS_PER_STEP) {
      actionCount++;
      try {
        const wv = getActiveWebview();
        const urlBefore = wv.src || '';

        // ── ALWAYS refresh DOM before asking LLM what to do ──────────────
        await refreshActiveGraph(wv);
        if (!activeGraph) { appendAiMessage('⚠️ Cannot read page.'); break; }

        const prunedGraph = await window.electronAPI.pruneGraph(activeGraph, currentStep);
        const memory = await window.electronAPI.recallMemory(currentStep, activeGraph.url);

        // Update thought in TPP while LLM decides next action
        tpp.setThought(`Deciding: ${currentStep.substring(0, 80)}`);
        tpp.incrementAction(currentStepIdx);


        // Tell the agent EXACTLY what's on screen + the full original goal for context
        const contextualStep = `ORIGINAL GOAL: ${enrichedGoal}
CURRENT STEP (${currentStepIdx + 1} of ${plan.steps.length}): ${currentStep}
[You are currently on: ${activeGraph.url}]
[Page type: ${activeGraph.semanticPattern || 'Unknown'}]
[Page title: ${activeGraph.title || 'Unknown'}]`;

        streamDiv = null;
        const agentResponse = await window.electronAPI.agentChat(
          contextualStep, prunedGraph, previousActions, memory, []
        );
        streamDiv = null;

        if (agentResponse.status === 'error') {
          appendAiMessage(`❌ ${agentResponse.args?.text || 'Error'}`);
          await window.electronAPI.recordMemory({ goal: currentStep, url: activeGraph.url, action: 'executor', outcome: 'failure', detail: agentResponse.args?.text });
          isComplete = true; break;
        }

        // ── Extract action details for observer ────────────────────────────
        const action = agentResponse.tool;
        const args   = agentResponse.args || {};
        const expectation = agentResponse.expectation || '';
        const thought = agentResponse.thought || '';

        if (agentResponse.status === 'complete') {
          // ── OBSERVER VERIFICATION: use real DOM signals, not just LLM guess ──
          await refreshActiveGraph(wv);
          tpp.setThought(`Verifying: ${plan.steps[currentStepIdx].substring(0, 70)}`);
          appendAiMessage(`🕵️ Verifying: **${plan.steps[currentStepIdx]}**...`);

          const obs = await window.electronAPI.observePage({
            graph: activeGraph,
            lastAction: `${action} ${args.targetId || args.text || ''}`,
            expectation,
            goalContext: enrichedGoal,
          });

          // Hard blockers = cannot be complete
          if (obs.blockers && obs.blockers.length > 0) {
            const blockerMsg = obs.blockers.join(', ');
            appendAiMessage(`⚠️ Blocker detected: **${blockerMsg}**. Resolving before continuing...`);
            tpp.setObserver('BLOCKED', obs.next_hint, true);
            previousActions.push(`BLOCKER: ${blockerMsg}. You MUST resolve this first. ${obs.next_hint}`);
            continue;
          }

          if (!obs.action_succeeded && obs.confidence > 0.7) {
            appendAiMessage(`❌ Observer: step not complete — ${obs.what_changed}. ${obs.next_hint}`);
            previousActions.push(`Observer says NOT complete: ${obs.what_changed}. Hint: ${obs.next_hint}`);
            continue;
          }

          // Step done
          await window.electronAPI.recordMemory({ goal: currentStep, url: activeGraph.url, action: 'complete', outcome: 'success', detail: obs.what_changed });
          tpp.stepDone(currentStepIdx);
          tpp.setObserver(obs.state, obs.next_hint, false);
          currentStepIdx++;
          if (currentStepIdx >= plan.steps.length) {
            appendAiMessage(`✅ **All ${plan.steps.length} steps done!** — ${obs.what_changed}`);
            isComplete = true;
            tpp.complete();
          } else {
            appendAiMessage(`✅ Step done (${obs.what_changed}) → **${plan.steps[currentStepIdx]}**`);
            tpp.setStep(currentStepIdx);
            previousActions = [`Observer summary of last step: ${obs.what_changed}`];
          }
          continue;
        }

        // ── Execute the action ─────────────────────────────────────────────
        let msg = `<div class="thought-log">🤔 ${thought}<br>🎯 <em>Expects: ${expectation}</em></div>▶️ **${action || 'thinking'}**`;

        if (action === 'navigate') {
          const navUrl = (args.text || '').trim();
          if (!navUrl.startsWith('http')) {
            msg += `<br>⚠️ Bad URL: ${navUrl}`;
            previousActions.push(`Bad URL attempted: ${navUrl}`);
          } else {
            // ── Deduplicate: skip navigation if already on this URL ──────
            const currentUrl = wv.src || '';
            const isSameOrigin = currentUrl.startsWith(navUrl) || navUrl.startsWith(currentUrl.split('?')[0]);
            if (isSameOrigin) {
              msg += `<br>⚠️ Already on this page — skipping redundant navigation`;
              previousActions.push(`Expectation: "${expectation}". Outcome: Already on ${currentUrl} — navigation to ${navUrl} was skipped. Take the NEXT action based on what is currently on screen.`);
            } else {
              msg += `<br>🌐 → ${navUrl}`;
              wv.src = navUrl;
              await waitForPageLoad(wv);
              await delay(800);
              await refreshActiveGraph(wv);

              // ── Observer: fast heuristic blocker check after navigation ────────
              const navObs = await window.electronAPI.observePage({
                graph: activeGraph,
                lastAction: `navigate to ${navUrl}`,
                expectation,
                goalContext: enrichedGoal,
              });
              if (navObs.blockers && navObs.blockers.length > 0) {
                const b = navObs.blockers.join(', ');
                msg += `<br>⚠️ Blocker: <strong>${b}</strong> — ${navObs.next_hint}`;
                previousActions.push(`Navigated to ${navUrl}. BLOCKER DETECTED: ${b}. You MUST resolve this before doing anything else. ${navObs.next_hint}`);
              } else {
                previousActions.push(`Navigated to ${navUrl}. Observer: ${navObs.what_changed}. ${navObs.next_hint}`);
              }
            }
          }
        } else if (action === 'scroll') {
          msg += `<br>↕️ Scroll`;
          await window.electronAPI.executeAction({ webContentsId: wv.getWebContentsId(), action: 'scroll', payload: { deltaX: 0, deltaY: 300, x: 500, y: 500 } });
          await delay(600);
          await refreshActiveGraph(wv);
          previousActions.push(`Expectation: "${expectation}". Outcome: Scrolled page`);

        } else if (action === 'ask_user') {
          const question = args.text || 'I need more info.';
          msg += `<br>💬 <em>${question}</em>`;
          appendAiMessage(msg);
          const answer = await askUser(question);
          previousActions.push(`Expectation: "${expectation}". Outcome: User answered: "${answer}"`);
          appendAiMessage(`👍 Got it. Continuing...`);
          continue;

        } else if (action === 'research') {
          msg += `<br>🔍 Researching: <em>${args.text}</em>`;
          appendAiMessage(msg);
          researchDiv = null;
          await window.electronAPI.startResearch(args.text);
          previousActions.push(`Expectation: "${expectation}". Outcome: Researched: ${args.text}`);
          continue;

        } else if (action === 'click' || action === 'type') {
          const targetId = (args.targetId || '').trim();
          const el = activeGraph.elements.find(e => e.id === targetId);

          if (el && el.position) {
            const x = Math.round(el.position.x + el.position.width / 2);
            const y = Math.round(el.position.y + el.position.height / 2);
            msg += `<br>🖱️ **${action}** [${x},${y}] on <code>${targetId}</code> ("${(el.text || '').substring(0,30)}")` ;

            const domBefore = JSON.stringify(activeGraph.elements);

            if (action === 'type') {
              // Step 1: Click the element to focus it
              await window.electronAPI.executeAction({
                webContentsId: wv.getWebContentsId(),
                action: 'click',
                payload: { x, y }
              });
              await delay(200);
              // Step 2: Select all existing text (Ctrl+A) to clear it before typing
              await window.electronAPI.executeAction({
                webContentsId: wv.getWebContentsId(),
                action: 'keyboard_shortcut',
                payload: { modifiers: ['ctrl'], keyCode: 'A' }
              });
              await delay(100);
              // Step 3: Type the new text
              await window.electronAPI.executeAction({
                webContentsId: wv.getWebContentsId(),
                action: 'type',
                payload: { x, y, text: args.text || '' }
              });
            } else {
              await window.electronAPI.executeAction({
                webContentsId: wv.getWebContentsId(),
                action: 'click',
                payload: { x, y }
              });
            }

            if (action === 'click') await waitForPageLoad(wv, 4000);
            else await delay(600);
            await refreshActiveGraph(wv);

            const urlNow = wv.src || '';
            const domAfter = JSON.stringify(activeGraph.elements);

            let outcome = `Executed ${action} on ${targetId}. `;
            if (action === 'type') outcome += `Typed "${(args.text || '').substring(0,60)}". `;
            if (urlNow !== urlBefore) {
              outcome += `URL changed to ${urlNow}. `;
            } else if (domBefore !== domAfter) {
              outcome += `DOM changed (content updated/modal/autocomplete appeared). `;
            } else {
              outcome += `Nothing visually changed. `;
            }

            previousActions.push(`Expectation: "${expectation}". Outcome: ${outcome}`);

            // ── Behavioral Learning: record what this element did ─────────────────
            // Builds the site knowledge graph over time — no LLM needed.
            if (action === 'click' && (urlNow !== urlBefore || domBefore !== domAfter)) {
              const newElements = activeGraph.elements.filter(e =>
                !JSON.parse(domBefore).find(old => old.id === e.id)
              );
              try {
                const domain = new URL(urlBefore.startsWith('http') ? urlBefore : 'https://' + urlBefore).hostname;
                window.electronAPI.recordBehavior({
                  domain,
                  url: urlBefore,
                  elementId: targetId,
                  elementText: el.text || '',
                  elementCategory: el._exploration?.category || 'unknown',
                  action: 'click',
                  resultUrl: urlNow,
                  resultPagePurpose: activeGraph._exploration?.purpose || 'unknown',
                  resultElementsAppeared: newElements.slice(0, 8),
                }).catch(() => {});
              } catch (_) {}
            }

            // ── Observer: feed real state back to planner after DOM change ─────────
            if (domBefore !== domAfter || urlNow !== urlBefore) {
              const actObs = await window.electronAPI.observePage({
                graph: activeGraph,
                lastAction: `${action} ${targetId}${action === 'type' ? ' with text: ' + (args.text || '') : ''}`,
                expectation,
                goalContext: enrichedGoal,
              });
              if (actObs.blockers && actObs.blockers.length > 0) {
                const b = actObs.blockers.join(', ');
                appendAiMessage(`⚠️ Blocker appeared: <strong>${b}</strong>`);
                previousActions.push(`BLOCKER: ${b}. You MUST handle this first. ${actObs.next_hint}`);
              } else {
                previousActions.push(`Observer state: ${actObs.state}. ${actObs.what_changed}. Hint: ${actObs.next_hint}`);
              }
            }

            await window.electronAPI.recordMemory({ goal: currentStep, url: urlBefore, action: `${action} ${targetId}`, outcome: 'success', detail: outcome });
          } else {
            // ── RECOVERY AGENT: element not found — try to find an alternative ──
            appendAiMessage(`⚠️ <code>${targetId}</code> not in DOM. Calling Recovery Agent...`);
            const recovery = await window.electronAPI.recoverElement({
              targetText: el ? el.text : targetId,
              targetId,
              currentElements: activeGraph.elements,
              goal: currentStep,
              siteMemory: `Domain: ${activeGraph.url}`,
            });
            if (recovery.found && recovery.target_id) {
              appendAiMessage(`🔧 Recovery found alternative: <code>${recovery.target_id}</code> ("${recovery.target_text}") — ${recovery.reasoning}`);
              // Re-run the action on the recovered element
              const recEl = activeGraph.elements.find(e => e.id === recovery.target_id);
              if (recEl && recEl.position) {
                const rx = Math.round(recEl.position.x + recEl.position.width / 2);
                const ry = Math.round(recEl.position.y + recEl.position.height / 2);
                await window.electronAPI.executeAction({ webContentsId: wv.getWebContentsId(), action: 'click', payload: { x: rx, y: ry } });
                await waitForPageLoad(wv, 4000);
                await refreshActiveGraph(wv);
                previousActions.push(`Recovery: used "${recovery.target_text}" (${recovery.target_id}) as substitute for missing "${targetId}". Confidence: ${recovery.confidence}`);
              }
            } else {
              previousActions.push(`${targetId} not found, Recovery Agent found no substitute. Try a different approach or scroll to find it.`);
            }
          }

        } else if (action === 'press_enter') {
          // Submit forms, confirm searches, send messages
          msg += `<br>↩️ Pressing Enter`;
          await window.electronAPI.executeAction({
            webContentsId: wv.getWebContentsId(),
            action: 'keyboard_shortcut',
            payload: { modifiers: [], keyCode: 'Return' }
          });
          await waitForPageLoad(wv, 5000);
          await refreshActiveGraph(wv);
          previousActions.push(`Expectation: "${expectation}". Outcome: Pressed Enter — URL is now ${wv.src}`);

        } else if (action === 'reply') {
          appendAiMessage(`🗣️ ${args.text || ''}`);
          previousActions.push('replied to user');
        } else {
          previousActions.push(`${action || 'unknown'} — unrecognised action`);
        }

        appendAiMessage(msg);
        await delay(1000);

      } catch (err) {
        appendAiMessage(`❌ Executor error: ${err.message}`);
        isComplete = true; break;
      }
    } // inner

    if (actionCount >= MAX_ACTIONS_PER_STEP && !isComplete) {
      appendAiMessage(`⚠️ Step ${currentStepIdx + 1} hit ${MAX_ACTIONS_PER_STEP}-action limit. Moving on.`);
      currentStepIdx++;
      previousActions = [];
    }
  } // outer while

  } // end handleTaskExecution

  // ─── Route to task execution from TASK intent ─────────────────────────────
  await handleTaskExecution(goalText);

} // end handleChatSubmit






chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleChatSubmit();
  }
});

chatSubmit.addEventListener('click', () => {
  handleChatSubmit();
});

// Auto-resize chat textarea
chatInput.addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = (this.scrollHeight) + 'px';
});

// Dock & Panel UI Logic
const leftPanel = document.getElementById('left-panel');
const dashboardOverlay = document.getElementById('dashboard-overlay');
const btnCloseDashboard = document.getElementById('btn-close-dashboard');

const dockChat = document.getElementById('dock-chat');
const dockDashboard = document.getElementById('dock-dashboard');
const dockBrowser = document.getElementById('dock-browser');

dockChat.addEventListener('click', () => {
  leftPanel.classList.toggle('hidden');
});

dockDashboard.addEventListener('click', () => {
  dashboardOverlay.classList.remove('hidden');
});

btnCloseDashboard.addEventListener('click', () => {
  dashboardOverlay.classList.add('hidden');
});

dockBrowser.addEventListener('click', () => {
  dashboardOverlay.classList.add('hidden');
});

// ─── Knowledge Graph Panel ──────────────────────────────────────────────────
const kgOverlay     = document.getElementById('kg-overlay');
const btnCloseKg    = document.getElementById('btn-close-kg');
const kgSearch      = document.getElementById('kg-search');
const kgTypeFilter  = document.getElementById('kg-type-filter');
const kgRefreshBtn  = document.getElementById('kg-refresh');
const kgStats       = document.getElementById('kg-stats');
const kgNodes       = document.getElementById('kg-nodes');
const dockKg        = document.getElementById('dock-kg');

const TYPE_ICONS = { person:'👤', task:'✅', message:'💬', note:'📝', url:'🔗', entity:'🏷️' };

async function renderKgPanel(search = '', type = '') {
  kgNodes.innerHTML = '<div style="color:#71717a;padding:20px">Loading...</div>';

  const [nodes, summary] = await Promise.all([
    window.electronAPI.kgQuery(type || null, search || null, 80),
    window.electronAPI.kgSummary(),
  ]);

  // Stats bar
  kgStats.innerHTML = Object.entries(summary.byType || {})
    .map(([t, n]) => `<span>${TYPE_ICONS[t]||'•'} <strong style="color:#e4e4e7">${n}</strong> ${t}</span>`)
    .join('<span style="color:#3f3f46">│</span>') +
    `<span style="margin-left:auto;color:#52525b">${summary.totalNodes} nodes · ${summary.totalEdges} edges</span>`;

  if (!nodes.length) {
    kgNodes.innerHTML = '<div style="color:#71717a;padding:20px;grid-column:1/-1">Nothing stored yet. Complete tasks and I\'ll remember everything here.</div>';
    return;
  }

  kgNodes.innerHTML = nodes.map(n => {
    const icon  = TYPE_ICONS[n.type] || '•';
    const age   = n.updatedAt ? new Date(n.updatedAt).toLocaleDateString() : '';
    const meta  = [n.goal || n.text || n.content || n.url || '', age].filter(Boolean).join(' · ');
    const tags  = (n.tags || []).map(t => `<span style="background:rgba(99,102,241,0.12);color:#818cf8;padding:1px 6px;border-radius:10px;font-size:0.7rem">${t}</span>`).join(' ');
    return `
      <div class="kg-node-card">
        <span class="kg-node-type kg-type-${n.type}">${icon} ${n.type}</span>
        <div class="kg-node-name">${n.name || '—'}</div>
        <div class="kg-node-meta">${meta.substring(0, 120)}</div>
        ${tags ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">${tags}</div>` : ''}
      </div>`;
  }).join('');
}

dockKg.addEventListener('click', () => {
  kgOverlay.classList.remove('hidden');
  renderKgPanel(kgSearch.value, kgTypeFilter.value);
});

btnCloseKg.addEventListener('click', () => kgOverlay.classList.add('hidden'));
kgRefreshBtn.addEventListener('click', () => renderKgPanel(kgSearch.value, kgTypeFilter.value));

let kgSearchDebounce;
kgSearch.addEventListener('input', () => {
  clearTimeout(kgSearchDebounce);
  kgSearchDebounce = setTimeout(() => renderKgPanel(kgSearch.value, kgTypeFilter.value), 350);
});
kgTypeFilter.addEventListener('change', () => renderKgPanel(kgSearch.value, kgTypeFilter.value));

// ─── KG query from chat ─────────────────────────────────────────────────────
// When user types "show my knowledge graph", "what do you know about X",
// "list people", "show tasks" etc. — handled in chat as a special case
async function tryKgChatQuery(text) {
  const t = text.toLowerCase().trim();
  const kgTriggers = [
    'show knowledge graph', 'open knowledge graph', 'show my graph',
    'what do you know', 'show me what you know', 'list people',
    'show tasks', 'show notes', 'show messages', 'my contacts',
    'knowledge graph', 'show memory', 'what have you stored',
  ];
  const matched = kgTriggers.some(k => t.includes(k));
  if (!matched) return false;

  // Extract search term if any: "what do you know about Jagadeesh"
  const aboutMatch = t.match(/(?:about|for|on)\s+(.+)$/i);
  const search = aboutMatch ? aboutMatch[1].trim() : '';
  const typeMatch = t.match(/\b(people|person|task|tasks|note|notes|message|messages|url|urls)\b/i);
  const typeMap = { people:'person', person:'person', tasks:'task', task:'task', notes:'note', note:'note', messages:'message', message:'message', urls:'url', url:'url' };
  const type = typeMatch ? (typeMap[typeMatch[1].toLowerCase()] || '') : '';

  const nodes = await window.electronAPI.kgQuery(type||null, search||null, 20);
  const summary = await window.electronAPI.kgSummary();

  if (nodes.length === 0) {
    appendAiMessage(`🧠 **Knowledge Graph** is empty${search ? ` — nothing found for "${search}"` : ''}. Complete tasks and I'll start building it automatically.`);
    return true;
  }

  const lines = nodes.slice(0, 12).map(n => {
    const icon = TYPE_ICONS[n.type] || '•';
    const detail = n.goal || n.text || n.content || n.url || '';
    return `${icon} **${n.name}** <span style="color:#71717a;font-size:0.8rem">${detail.substring(0, 60)}</span>`;
  }).join('<br>');

  appendAiMessage(`🧠 **Knowledge Graph** (${summary.totalNodes} nodes):<br><br>${lines}<br><br><em style="color:#71717a;font-size:0.8rem">Click the branch icon in the dock to see the full graph →</em>`);

  // Also open the panel
  kgOverlay.classList.remove('hidden');
  renderKgPanel(search, type);
  return true;
}



function updateDashboardLive(graph) {
  if (dashboardOverlay.classList.contains('hidden')) return;
  const notesContent = document.getElementById('notes-content');
  if (!notesContent) return;

  let html = `<h2 style="color: white; border-bottom: 1px solid #27272a; padding-bottom: 12px; margin-bottom: 16px; display: flex; align-items: center; gap: 8px;">
    <i data-lucide="radio" style="color: #10b981; animation: pulse 2s infinite;"></i> Live Observer Active
  </h2>`;
  html += `<p style="margin-bottom: 4px;"><strong>URL:</strong> <span style="color: #a1a1aa">${graph.url}</span></p>`;
  html += `<p style="margin-bottom: 12px;"><strong>Title:</strong> <span style="color: #a1a1aa">${graph.title}</span></p>`;
  
  if (graph.semanticPattern) {
    html += `<div style="background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); padding: 12px; border-radius: 8px; margin-bottom: 24px;">
      <h3 style="color: #10b981; margin: 0 0 4px 0; font-size: 1rem;"><i data-lucide="brain" style="width: 16px; height: 16px; display: inline-block; vertical-align: middle;"></i> Cognitive Pattern Detected</h3>
      <p style="color: white; margin: 0; font-weight: bold; font-size: 1.1rem;">${graph.semanticPattern}</p>
    </div>`;
  }
  
  html += `<h3 style="color: white; margin-bottom: 12px;">Interactive & Content Elements (${graph.elementCount})</h3>`;
  html += `<div style="display: flex; flex-direction: column; gap: 8px;">`;
  
  graph.elements.forEach(el => {
    let content = '';
    if (el.src) {
      content = `<span style="color: #10b981; word-break: break-all; font-size: 0.8rem;">[Media] ${el.src}</span>`;
    } else if (el.text) {
      content = `"${el.text}"`;
    }
    
    let predHtml = '';
    if (el.predictedEffect) {
       predHtml = `<div style="color: #a855f7; font-size: 0.8rem; margin-top: 4px; border-top: 1px dashed rgba(168, 85, 247, 0.3); padding-top: 4px;"><i data-lucide="zap" style="width: 12px; height: 12px; display: inline-block; vertical-align: -2px;"></i> ${el.predictedEffect}</div>`;
    }
    
    html += `<div style="background: rgba(255,255,255,0.02); border: 1px solid #27272a; padding: 12px; border-radius: 8px;">
      <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
        <strong style="color: #3b82f6;">${el.id}</strong>
        <span style="color: #52525b; font-size: 0.8rem;">${el.role}</span>
      </div>
      <p style="color: #f4f4f5; font-size: 0.95rem; margin-bottom: 6px;">${content}</p>
      <div style="color: #71717a; font-size: 0.75rem;">Pos: [${el.position.x}, ${el.position.y}] - Parent: ${el.parentContext || 'None'}</div>
      ${predHtml}
    </div>`;
  });
  html += `</div>`;
  
  // State Transitions handled by LLM moving forward
  
  notesContent.innerHTML = html;
  lucide.createIcons({ root: notesContent });
}

const dockMapper = document.getElementById('dock-mapper');
dockMapper.addEventListener('click', async () => {
  const wv = getActiveWebview();
  if (!wv) return;
  
  dashboardOverlay.classList.remove('hidden');
  const notesContent = document.getElementById('notes-content');
  
  notesContent.innerHTML = `<h3 style="color: white; display: flex; align-items: center; gap: 8px;">
    <i data-lucide="loader" class="spin"></i> Mapping Site...
  </h3>
  <p>Forcing a fresh UI scan and LLM inference for ${wv.src}</p>`;
  lucide.createIcons();
  
  try {
    const response = await fetch('indexer.js');
    const scriptText = await response.text();
    const resultJsonString = await wv.executeJavaScript(`
      try {
        ${scriptText}
      } catch (e) {
        JSON.stringify({ error: e.message, stack: e.stack });
      }
    `);
    
    if (resultJsonString) {
       const parsed = JSON.parse(resultJsonString);
       if (parsed.error) {
          throw new Error("Webview Error: " + parsed.error + "\\n" + parsed.stack);
       }
       activeGraph = parsed;
       try {
          const result = await window.electronAPI.analyzeUI(activeGraph);
          activeGraph.semanticPattern = result.semanticPattern;
          activeGraph.elements.forEach(el => {
             if (result.predictions && result.predictions[el.id]) el.predictedEffect = result.predictions[el.id];
          });
          wv.send('semantic-predictions', result.predictions || {});
       } catch(err) {}
       updateDashboardLive(activeGraph);
    }
  } catch(e) {
    console.error("DOCK MAPPER ERROR:", e);
    notesContent.innerHTML = `<h3 style="color: #ef4444; display: flex; align-items: center; gap: 8px;">
      <i data-lucide="alert-triangle"></i> Mapping Failed
    </h3>
    <p>${e.message}</p>
    <p>Failed to map the site. The page may still be loading or navigating. Try again in a moment.</p>`;
    lucide.createIcons({ root: notesContent });
  }
});

// Smart scroll — only auto-scroll when user is already near the bottom
function smartScroll() {
  const threshold = 120; // px from bottom
  const nearBottom = chatHistory.scrollHeight - chatHistory.scrollTop - chatHistory.clientHeight < threshold;
  if (nearBottom) chatHistory.scrollTop = chatHistory.scrollHeight;
}

// Helper for user messages
function appendUserMessage(msg) {
  const userDiv = document.createElement('div');
  userDiv.className = 'message user';
  userDiv.textContent = msg;
  chatHistory.appendChild(userDiv);
  chatHistory.scrollTop = chatHistory.scrollHeight; // always scroll on OWN message
}

// Helper for AI messages
function appendAiMessage(msg) {
  const aiDiv = document.createElement('div');
  aiDiv.className = 'message ai';
  aiDiv.innerHTML = msg;
  chatHistory.appendChild(aiDiv);
  smartScroll();
}

// ─── Agent Stream (CHAT MODE ONLY) ──────────────────────────────────────────
// In executor/task mode, streaming is suppressed in llm-bridge and never fires here.
// This only fires during chat intent where the model streams plain text.
let streamDiv = null;
window.electronAPI.onAgentStream((token) => {
  if (!streamDiv) {
    streamDiv = document.createElement('div');
    streamDiv.className = 'message ai';
    streamDiv.style.whiteSpace = 'pre-wrap';
    streamDiv.style.lineHeight = '1.6';
    chatHistory.appendChild(streamDiv);
  }
  streamDiv.textContent += token;
  smartScroll();
});

// ─── Research Subagent Stream ─────────────────────────────────────────────────
let researchDiv = null;
let researchBody = null; // separate text node so header stays
window.electronAPI.onResearchStream((token) => {
  if (!researchDiv) {
    researchDiv = document.createElement('div');
    researchDiv.className = 'message ai';
    researchDiv.style.background = 'rgba(99,102,241,0.07)';
    researchDiv.style.border = '1px solid rgba(99,102,241,0.3)';
    researchDiv.style.borderRadius = '10px';
    researchDiv.style.padding = '12px';

    const header = document.createElement('div');
    header.innerHTML = '🔍 <strong style="color:#818cf8">Research Report</strong>';
    header.style.marginBottom = '10px';
    researchDiv.appendChild(header);

    researchBody = document.createElement('div');
    researchBody.style.fontFamily = 'monospace';
    researchBody.style.fontSize = '0.83rem';
    researchBody.style.lineHeight = '1.65';
    researchBody.style.whiteSpace = 'pre-wrap';
    researchDiv.appendChild(researchBody);

    chatHistory.appendChild(researchDiv);
  }
  researchBody.textContent += token;
  smartScroll();
});

// Reset research panels between calls
window.electronAPI.startResearch = (() => {
  const _orig = window.electronAPI.startResearch;
  return async (query) => { researchDiv = null; researchBody = null; return _orig(query); };
})();

// ─── Skill ask_user handler ─────────────────────────────────────────────────
// When a skill's conditional step asks the user (e.g. login wall detected),
// show the interactive prompt bubble in chat.
window.electronAPI.onSkillAskUser((data) => {
  const { question } = data;
  const wrapper = document.createElement('div');
  wrapper.className = 'message ai ask-user-prompt';
  wrapper.innerHTML = `
    <div style="margin-bottom:8px">💬 <strong>Skill needs your help:</strong></div>
    <div style="margin-bottom:10px;color:#e4e4e7">${question}</div>
    <div style="display:flex;gap:8px;align-items:center">
      <input id="skill-user-input" type="text" placeholder="Type your answer or 'done'..."
        style="flex:1;background:rgba(255,255,255,0.05);border:1px solid #3f3f46;border-radius:8px;padding:8px 12px;color:white;font-size:0.9rem;outline:none">
      <button id="skill-user-submit"
        style="background:#10b981;color:white;border:none;border-radius:8px;padding:8px 16px;cursor:pointer;font-weight:600">Done</button>
    </div>`;
  chatHistory.appendChild(wrapper);
  smartScroll();
  const input = wrapper.querySelector('#skill-user-input');
  const btn = wrapper.querySelector('#skill-user-submit');
  input.focus();
  const submit = () => {
    wrapper.style.opacity = '0.5';
    appendAiMessage(`👍 Got it. Continuing...`);
  };
  btn.addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
});


// Resizer Logic
const resizer = document.getElementById('resizer');
let isResizing = false;

resizer.addEventListener('mousedown', () => {
  isResizing = true;
  document.body.style.cursor = 'col-resize';
  tabs.forEach(t => t.webview.style.pointerEvents = 'none');
});

window.addEventListener('mousemove', (e) => {
  if (!isResizing) return;
  const newWidth = e.clientX;
  if (newWidth > 200 && newWidth < window.innerWidth - 300) {
    leftPanel.style.width = `${newWidth}px`;
  }
});

window.addEventListener('mouseup', () => {
  if (isResizing) {
    isResizing = false;
    document.body.style.cursor = 'default';
    tabs.forEach(t => {
      if(t.id === activeTabId) t.webview.style.pointerEvents = 'auto';
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// TASK PROGRESS PANEL (TPP) CONTROLLER
// Controls the live task progress UI at the bottom of the left panel.
// Called from the executor loop to show real-time state.
// ══════════════════════════════════════════════════════════════════════════════

const tpp = (() => {
  const panel       = document.getElementById('task-progress-panel');
  const goalLabel   = document.getElementById('tpp-goal-label');
  const stepsEl     = document.getElementById('tpp-steps');
  const thoughtEl   = document.getElementById('tpp-thought');
  const thoughtText = document.getElementById('tpp-thought-text');
  const observerEl  = document.getElementById('tpp-observer');
  const obsState    = document.getElementById('tpp-observer-state');
  const obsHint     = document.getElementById('tpp-observer-hint');
  const researchEl  = document.getElementById('tpp-research');
  const researchLbl = document.getElementById('tpp-research-label');
  const closeBtn    = document.getElementById('tpp-close');

  let _steps = [];
  let _currentIdx = 0;
  let _actionCounts = [];

  closeBtn.addEventListener('click', () => hide());

  function show(goal, steps) {
    _steps = steps;
    _currentIdx = 0;
    _actionCounts = steps.map(() => 0);
    goalLabel.textContent = goal.length > 45 ? goal.substring(0, 42) + '...' : goal;
    _renderSteps();
    panel.classList.remove('hidden');
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  function hide() {
    panel.classList.add('hidden');
    thoughtEl.classList.add('hidden');
    observerEl.classList.add('hidden');
    researchEl.classList.add('hidden');
  }

  function _stepIcon(status) {
    if (status === 'pending')  return '○';
    if (status === 'running')  return '⬡';
    if (status === 'done')     return '✓';
    if (status === 'error')    return '✕';
    if (status === 'skipped')  return '—';
    return '○';
  }

  function _renderSteps() {
    stepsEl.innerHTML = '';
    _steps.forEach((step, i) => {
      const status = i < _currentIdx ? 'done' : i === _currentIdx ? 'running' : 'pending';
      const div = document.createElement('div');
      div.className = `tpp-step ${status}`;
      div.id = `tpp-step-${i}`;
      div.innerHTML = `
        <div class="tpp-step-icon">${_stepIcon(status)}</div>
        <div class="tpp-step-text">${step}</div>
        <div class="tpp-step-count" id="tpp-count-${i}">${status === 'running' && _actionCounts[i] > 0 ? _actionCounts[i] + ' acts' : ''}</div>
      `;
      stepsEl.appendChild(div);
    });
  }

  function setStep(idx) {
    _currentIdx = idx;
    _renderSteps();
  }

  function stepDone(idx) {
    const el = document.getElementById(`tpp-step-${idx}`);
    if (el) { el.className = 'tpp-step done'; el.querySelector('.tpp-step-icon').textContent = '✓'; }
  }

  function stepError(idx) {
    const el = document.getElementById(`tpp-step-${idx}`);
    if (el) { el.className = 'tpp-step error'; el.querySelector('.tpp-step-icon').textContent = '✕'; }
  }

  function incrementAction(idx) {
    _actionCounts[idx] = (_actionCounts[idx] || 0) + 1;
    const countEl = document.getElementById(`tpp-count-${idx}`);
    if (countEl) countEl.textContent = _actionCounts[idx] + ' acts';
  }

  function setThought(text) {
    if (!text) { thoughtEl.classList.add('hidden'); return; }
    thoughtText.textContent = text.length > 120 ? text.substring(0, 117) + '...' : text;
    thoughtEl.classList.remove('hidden');
  }

  function setObserver(state, hint, isBlocker = false) {
    if (!state) { observerEl.classList.add('hidden'); return; }
    obsState.textContent = state.replace(/_/g, ' ').toUpperCase();
    obsState.className = 'tpp-state-pill' + (isBlocker ? ' blocker' : '');
    obsHint.textContent = hint || '';
    observerEl.classList.remove('hidden');
  }

  function setResearch(running, label) {
    if (!running) { researchEl.classList.add('hidden'); return; }
    researchLbl.textContent = label || 'Research Agent running...';
    researchEl.classList.remove('hidden');
  }

  function complete() {
    // Mark all remaining steps as done and auto-hide after delay
    _steps.forEach((_, i) => stepDone(i));
    setThought(null);
    setObserver(null);
    setResearch(false);
    setTimeout(() => hide(), 3000);
  }

  return { show, hide, setStep, stepDone, stepError, incrementAction, setThought, setObserver, setResearch, complete };
})();

// Expose tpp globally so handleTaskExecution (defined inside handleChatSubmit) can use it
window.tpp = tpp;
