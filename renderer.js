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
    // Pass full conversation history so the model has context of all previous turns
    const chatResponse = await window.electronAPI.agentChat(
      goalText,
      { url: '', title: '', elements: [] },
      [],
      '',
      conversationHistory
    );
    const replyText = chatResponse?.args?.text || '';
    if (streamDiv) {
      // Streaming finished — capture what was streamed
      const streamed = streamDiv.textContent || '';
      streamDiv = null;
      if (streamed) pushToHistory(goalText, streamed);
    } else if (replyText) {
      appendAiMessage(replyText);
      pushToHistory(goalText, replyText);
    }
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
  // Ask the LLM what info it needs, then ask the user for each piece.
  // Returns an enriched goal string with all answers embedded.
  async function gatherMissingInfo(goal) {
    const gatherPrompt = `You are about to help execute this task: "${goal}"

What specific information is MISSING that you need from the user to complete this task?
Think about: recipient names, message content, credentials, preferences, quantities, dates, etc.

Return a JSON array of concise questions to ask. If you have everything, return [].
Only ask for things genuinely needed. Don't ask for things you can figure out yourself.
Example: ["Who should I send the message to?", "What should the message say?"]
Return ONLY the JSON array, nothing else.`;

    try {
      const resp = await window.electronAPI.agentChat(
        gatherPrompt,
        { url: '', title: '', elements: [] },
        [], '', []
      );
      const text = resp?.args?.text || '[]';
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) return goal;
      const questions = JSON.parse(match[0]);
      if (!Array.isArray(questions) || questions.length === 0) return goal;

      appendAiMessage(`💡 Before I start, I need a few things from you:`);
      let enrichedGoal = goal;
      for (const q of questions) {
        const answer = await askUser(q);
        enrichedGoal += `\n[${q}: ${answer}]`;
        appendAiMessage(`✓ Got it: **${answer}**`);
      }
      return enrichedGoal;
    } catch (_) {
      return goal;
    }
  }

  // ─── Executor setup ────────────────────────────────────────────────────────
  // Phase A: gather missing info BEFORE decomposing
  const enrichedGoal = await gatherMissingInfo(goalText);

  // Phase B: decompose enriched goal into steps
  streamDiv = null;
  const plan = await window.electronAPI.decomposeGoal(enrichedGoal, getActiveWebview().src);
  if (streamDiv) streamDiv = null;

  const planHtml = plan.steps.map((s, i) => `<li>${i + 1}. ${s}</li>`).join('');
  appendAiMessage(`📋 **Plan:**<ol style="margin:8px 0 0 16px;padding:0">${planHtml}</ol>`);

  let isComplete = false;
  let previousActions = [];
  let currentStepIdx = 0;
  const MAX_ACTIONS_PER_STEP = 10;
  const delay = ms => new Promise(r => setTimeout(r, ms));

  while (!isComplete && currentStepIdx < plan.steps.length) {
    const currentStep = plan.steps[currentStepIdx];
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

        // Tell the agent EXACTLY what's on screen right now
        const contextualStep = `${currentStep}
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

        if (agentResponse.status === 'complete') {
          // ── REAL VERIFICATION: LLM check to prevent premature completion ──
          await refreshActiveGraph(wv);
          appendAiMessage(`🕵️ Verifying completion of: **${plan.steps[currentStepIdx]}**...`);
          
          const verifyPrompt = `The agent claims this step is complete: "${plan.steps[currentStepIdx]}".
Look at the Current Page Context below. Is it actually complete? Did it achieve the goal?
If YES, extract any relevant data/output requested by the step.
If NO, explain what is missing.

Respond ONLY in JSON:
{
  "isComplete": true/false,
  "data": "Extracted data if any, or null",
  "reason": "Why it is complete or what is missing"
}`;
          const vResp = await window.electronAPI.agentChat(verifyPrompt, prunedGraph, [], memory, [], true);
          let isActuallyComplete = true;
          let verifyData = agentResponse.extracted_data || null;
          let verifyReason = "Agent marked complete";
          
          try {
            const vMatch = (vResp?.args?.text || '').match(/\{[\s\S]*\}/);
            if (vMatch) {
              const vJson = JSON.parse(vMatch[0]);
              // Default to true if the model couldn't decide, to avoid infinite loops,
              // but if it explicitly said false, reject it.
              if (vJson.isComplete === false) isActuallyComplete = false;
              if (vJson.data) verifyData = vJson.data;
              if (vJson.reason) verifyReason = vJson.reason;
            }
          } catch(e){}

          if (!isActuallyComplete) {
             appendAiMessage(`❌ Verification failed: ${verifyReason}. Resuming step...`);
             previousActions.push(`Attempted to complete, but verifier said: ${verifyReason}`);
             continue; // Go back to start of while loop and let agent try again
          }

          const verifyNote = verifyData ? `Found: ${verifyData}` : `Verified: ${verifyReason}`;

          await window.electronAPI.recordMemory({ goal: currentStep, url: activeGraph.url, action: 'complete', outcome: 'success', detail: verifyNote });
          currentStepIdx++;
          if (currentStepIdx >= plan.steps.length) {
            appendAiMessage(`✅ **All ${plan.steps.length} steps done!** (${verifyNote})`);
            isComplete = true;

            // ── Auto-write task result to Knowledge Graph ──────────────────
            // Ask LLM to extract entities (people, companies, URLs) from this task
            try {
              const extractPrompt = `The following task was just completed: "${enrichedGoal}"
Page at completion: ${activeGraph?.url || 'unknown'} (${activeGraph?.semanticPattern || ''})
Actions taken: ${previousActions.slice(-6).join(' | ')}

Extract entities to store in a knowledge graph. Return ONLY this JSON:
{
  "outcome": "one sentence summary of what was accomplished",
  "entities": [
    { "type": "person|company|url|note", "name": "...", "rel": "involved|recipient|sender|reference" }
  ]
}
Types: person=a real human, company=an organization, url=a website, note=a key fact.`;

              const resp = await window.electronAPI.agentChat(
                extractPrompt, { url: '', title: '', elements: [] }, [], '', [], true // silent
              );
              const text = resp?.args?.text || '{}';
              const match = text.match(/\{[\s\S]*\}/);
              if (match) {
                const extracted = JSON.parse(match[0]);
                await window.electronAPI.kgRecordTask({
                  goal: enrichedGoal,
                  outcome: extracted.outcome || verifyNote,
                  status: 'complete',
                  url: activeGraph?.url || '',
                  entities: (extracted.entities || []),
                });
                if (extracted.entities?.length > 0) {
                  const names = extracted.entities.map(e => `${e.name} (${e.type})`).join(', ');
                  appendAiMessage(`🧠 **Stored to Knowledge Graph:** ${names}`);
                }
              }
            } catch (_) {}
          } else {
            appendAiMessage(`✅ Step ${currentStepIdx} done (${verifyNote}) → **${plan.steps[currentStepIdx]}**`);
            previousActions = [];
          }
          break;

        }

        // ── Execute the action ─────────────────────────────────────────────
        const thought = agentResponse.thought || '';
        const expectation = agentResponse.expectation || 'No specific expectation';
        const action  = agentResponse.tool;
        const args    = agentResponse.args || {};
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
              previousActions.push(`Expectation: "${expectation}". Outcome: Navigated to ${navUrl} | now on: ${wv.src}`);
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
          previousActions.push(`Expectation: "${expectation}". Outcome: User told me: "${answer}" (in answer to: "${question}")`);
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
          // Search in the fresh activeGraph
          const el = activeGraph.elements.find(e => e.id === targetId);

          if (el && el.position) {
            const x = Math.round(el.position.x + el.position.width / 2);
            const y = Math.round(el.position.y + el.position.height / 2);
            msg += `<br>🖱️ **${action}** [${x},${y}] on <code>${targetId}</code> ("${(el.text || '').substring(0,30)}")`;

            // Hash elements to detect changes
            const domBefore = JSON.stringify(activeGraph.elements);

            await window.electronAPI.executeAction({
              webContentsId: wv.getWebContentsId(),
              action,
              payload: { x, y, text: args.text || '' }
            });

            // Wait then refresh DOM — see what actually changed
            if (action === 'click') await waitForPageLoad(wv, 4000);
            else await delay(600);
            await refreshActiveGraph(wv);

            const urlNow = wv.src || '';
            const domAfter = JSON.stringify(activeGraph.elements);
            
            let outcome = `Executed ${action} on ${targetId}. `;
            if (urlNow !== urlBefore) {
              outcome += `URL changed to ${urlNow}. `;
            } else if (domBefore !== domAfter) {
              outcome += `URL stayed same, but DOM changed (modal appeared/closed or content loaded). `;
            } else {
              outcome += `Nothing visually changed. Action may have failed or was a no-op. `;
            }

            previousActions.push(`Expectation: "${expectation}". Outcome: ${outcome}`);
            await window.electronAPI.recordMemory({ goal: currentStep, url: urlBefore, action: `click ${targetId}`, outcome: 'success', detail: outcome });
          } else {
            msg += `<br>⚠️ Element <code>${targetId}</code> not in current DOM. Asking for help.`;
            previousActions.push(`${targetId} not found in DOM (page: ${activeGraph.url})`);
          }

        } else if (action === 'reply') {
          appendAiMessage(`🗣️ ${args.text || ''}`);
          previousActions.push('replied to user');
        } else {
          previousActions.push(`${action || 'unknown'}`);
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
  } // outer

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
