const { app, BrowserWindow, ipcMain, webContents, session, desktopCapturer } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const Tesseract = require('tesseract.js');
const { mouse, keyboard, Key, Point } = require('@nut-tree-fork/nut-js');

const { analyzeUIWithLLM, chatAgentWithLLM } = require('./llm-bridge.js');
const { classifyIntent } = require('./intent-classifier.js');
const { matchSkill, extractArgs, skills } = require('./skills/_registry.js');
const { executeSkill } = require('./skills/executor.js');
const { decomposeGoal } = require('./manager-agent.js');
const { recordEpisode, recallRelevant } = require('./memory.js');
const { researchHeadless, searchLeads, lookupCompany, lookupApp, searchNews, extractPageData } = require('./research-agent.js');
const { observePageState, recoverMissingElement } = require('./observer.js');
const { explorePage, buildBehaviorRecord, buildPageSummary } = require('./exploration-agent.js');
const kg = require('./knowledge-graph.js');

const downloadDir = path.join(os.homedir(), 'Operator Downloads');
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);

let llmProcess = null;
let mainWindow;
let overlayWindow;

function createWindow () {
  const isMac = process.platform === 'darwin';
  
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    transparent: true,
    frame: isMac, // False on Windows for borderless transparency
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    vibrancy: 'fullscreen-ui', // macOS native blur
    backgroundMaterial: 'acrylic', // Windows 11 native blur (Mica/Acrylic)
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true
    }
  });

  mainWindow.loadFile('index.html');

  // --- FULLSCREEN HUD OVERLAY FOR DESKTOP OS VISION ---
  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  overlayWindow = new BrowserWindow({
    x: primaryDisplay.bounds.x,
    y: primaryDisplay.bounds.y,
    width: primaryDisplay.bounds.width,
    height: primaryDisplay.bounds.height,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false, // hidden until activated
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });
  
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.loadFile('overlay.html');
}

// Prevent Chromium from throttling our background agent workers
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

app.whenReady().then(() => {
  // In packaged builds, __dirname is inside app.asar and 'node' doesn't exist.
  // Use Electron's own Node runtime (process.execPath) and resolve paths via
  // process.resourcesPath so the .gguf model and server script are found correctly.
  const isPackaged = app.isPackaged;
  const serverScript = isPackaged
    ? path.join(process.resourcesPath, 'app.asar', 'local-llm-server.js')
    : path.join(__dirname, 'local-llm-server.js');
  const modelPath = isPackaged
    ? path.join(process.resourcesPath, 'Operator-engine-3b.gguf')
    : path.join(__dirname, 'Operator-engine-3b.gguf');

  // Dev: use system 'node' (matches ABI llama native addon was compiled for)
  // Packaged: no system node available — use Electron's own runtime with ELECTRON_RUN_AS_NODE
  const nodeExec = isPackaged ? process.execPath : 'node';
  const spawnEnv = isPackaged
    ? { ...process.env, OPERATOR_MODEL_PATH: modelPath, ELECTRON_RUN_AS_NODE: '1' }
    : { ...process.env, OPERATOR_MODEL_PATH: modelPath };

  console.log('[Main] Starting LLM server:', serverScript);
  console.log('[Main] Model path:', modelPath);
  console.log('[Main] Node exec:', nodeExec);

  llmProcess = spawn(nodeExec, [serverScript], {
    stdio: 'inherit',
    env: spawnEnv
  });
  llmProcess.on('error', (err) => console.error('[Main] LLM server spawn error:', err));
  llmProcess.on('exit', (code) => console.warn('[Main] LLM server exited with code:', code));

  createWindow();

  session.defaultSession.on('will-download', (event, item, webContents) => {
    const savePath = path.join(downloadDir, item.getFilename());
    item.setSavePath(savePath);
    console.log(`Started downloading: ${item.getFilename()} to ${savePath}`);
  });

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// --- Knowledge Graph (Rich node-edge persistent store) ---
ipcMain.handle('kg-upsert', (event, { type, name, data }) => {
  return kg.upsertNode(type, name, data || {});
});

ipcMain.handle('kg-query', (event, { type, search, limit }) => {
  return kg.queryNodes(type || null, search || null, limit || 50);
});

ipcMain.handle('kg-get', (event, id) => {
  return kg.getNode(id);
});

ipcMain.handle('kg-edge', (event, { from, to, rel }) => {
  kg.addEdge(from, to, rel);
  return true;
});

ipcMain.handle('kg-summary', () => {
  return kg.getGraphSummary();
});

ipcMain.handle('kg-record-task', (event, payload) => {
  return kg.recordTaskResult(payload);
});

// Legacy domain-knowledge (still used by webview UI scan) ---
const downloadDir2 = path.join(os.homedir(), 'Operator Downloads');
const legacyKnowledgePath = path.join(downloadDir2, 'knowledge_graph.json');
function loadLegacyKG() {
  try { return fs.existsSync(legacyKnowledgePath) ? JSON.parse(fs.readFileSync(legacyKnowledgePath, 'utf8')) : {}; } catch(_) { return {}; }
}
ipcMain.handle('get-knowledge', (event, domain) => {
  const db = loadLegacyKG(); return db[domain] || { elements: {} };
});
ipcMain.handle('save-knowledge', (event, { domain, elements }) => {
  const db = loadLegacyKG();
  if (!db[domain]) db[domain] = { elements: {} };
  for (const id in elements) db[domain].elements[id] = { ...db[domain].elements[id], ...elements[id] };
  fs.writeFileSync(legacyKnowledgePath, JSON.stringify(db, null, 2), 'utf8');
  return true;
});

let visionWorker = null;
async function getVisionWorker() {
  if (!visionWorker) {
    const Tesseract = require('tesseract.js');
    visionWorker = await Tesseract.createWorker('eng');
  }
  return visionWorker;
}

// --- Phase 8: Pure Node.js Zero-Server OS Vision Pipeline ---
ipcMain.handle('get-vision-tree', async () => {
  try {
    const { screen, systemPreferences } = require('electron');
    const isMac = process.platform === 'darwin';
    if (isMac) {
      console.log("[getVisionTree] macOS Screen Recording Permission Status:", systemPreferences.getMediaAccessStatus('screen'));
    }
    
    const display = screen.getPrimaryDisplay();
    const screenBounds = display.bounds; // {width, height} in CSS pixels
    
    // We request a 1920x1080 thumbnail, but desktopCapturer maintains aspect ratio.
    const sources = await desktopCapturer.getSources({ 
      types: ['screen'], 
      thumbnailSize: { width: 1920, height: 1080 } 
    });
    console.log("[getVisionTree] Found", sources.length, "screens");
    if (sources.length === 0) return [];

    const primaryScreen = sources[0];
    const thumbSize = primaryScreen.thumbnail.getSize(); // actual dimensions captured
    const imageBuffer = primaryScreen.thumbnail.toPNG();
    console.log(`[getVisionTree] Captured thumbnail: ${thumbSize.width}x${thumbSize.height} (${imageBuffer.length} bytes)`);

    // Calculate scale factors from Thumbnail Space -> CSS Screen Space
    const scaleX = screenBounds.width / thumbSize.width;
    const scaleY = screenBounds.height / thumbSize.height;

    // Run Tesseract OCR using persistent worker to get blocks
    console.log("[getVisionTree] Running Tesseract OCR...");
    const worker = await getVisionWorker();
    const { data } = await worker.recognize(imageBuffer, {}, { blocks: true });
    
    let words = [];
    if (data && data.blocks) {
      data.blocks.forEach(block => {
        if (block.paragraphs) {
          block.paragraphs.forEach(para => {
            if (para.lines) {
              para.lines.forEach(line => {
                if (line.words) {
                  words.push(...line.words);
                }
              });
            }
          });
        }
      });
    }
    console.log("[getVisionTree] Tesseract found", words.length, "words");
    
    let elements = [];
    if (words && Array.isArray(words)) {
      words.forEach((w, i) => {
        if (w.confidence > 60 && w.text.trim().length > 0) {
          elements.push({
            id: `VIS_TXT_${i}`,
            text: w.text.trim(),
            role: 'text',
            bounds: {
              x: w.bbox.x0 * scaleX,
              y: w.bbox.y0 * scaleY,
              width: (w.bbox.x1 - w.bbox.x0) * scaleX,
              height: (w.bbox.y1 - w.bbox.y0) * scaleY
            }
          });
        }
      });
    }
    return elements;
  } catch (err) {
    console.error("Vision Error:", err);
    return [];
  }
});

ipcMain.handle('os-action', async (event, { action, x, y, text, elements }) => {
  try {
    if (action === 'show_hud') {
      if (overlayWindow) overlayWindow.show();
      return true;
    }
    if (action === 'hide_hud') {
      if (overlayWindow) overlayWindow.hide();
      return true;
    }
    if (action === 'update_hud') {
      if (overlayWindow) overlayWindow.webContents.send('update-hud', elements || []);
      return true;
    }

    if (action === 'click') {
      await mouse.setPosition(new Point(x, y));
      await mouse.leftClick();
      return true;
    } else if (action === 'type') {
      if (x !== undefined && y !== undefined) {
        await mouse.setPosition(new Point(x, y));
        await mouse.leftClick();
      }
      await keyboard.type(text);
      return true;
    } else if (action === 'press_enter') {
      await keyboard.pressKey(Key.Return);
      await keyboard.releaseKey(Key.Return);
      return true;
    }
  } catch (err) {
    console.error("OS Action Error:", err);
  }
  return false;
});

// --- Phase 7: Local LLM Integration Bridge ---
ipcMain.handle('analyze-ui-llm', async (event, graph) => {
  try {
    const result = await analyzeUIWithLLM(graph);
    return result;
  } catch (error) {
    console.error("LLM Inference Error:", error);
    return { semanticPattern: "LLM Error", predictions: {} };
  }
});

ipcMain.handle('agent-chat', async (event, { promptText, graph, previousActions, memory, conversationHistory, pageSummary, taskScratchpad, memorypad, graphQuery }) => {
  try {
    const result = await chatAgentWithLLM(
      promptText,
      graph,
      previousActions || [],
      event.sender,
      memory || '',
      conversationHistory || [],
      false,
      pageSummary || '',
      taskScratchpad || '',
      memorypad || '',
      graphQuery || null
    );
    return result;
  } catch (error) {
    console.error('Agent Chat Error:', error);
    require('fs').writeFileSync('/Users/sanjeevn/Downloads/Operator OS/last_agent_error.txt', error.stack || error.message || String(error));
    return { tool: 'reply', args: { text: `Error contacting agent: ${error.message}` }, status: 'error' };
  }
});

// --- Intent Classification ---
ipcMain.handle('classify-intent', async (event, message) => {
  return await classifyIntent(message);
});

// --- Skills Engine ---
ipcMain.handle('match-skill', async (event, goalText) => {
  return matchSkill(goalText);
});

ipcMain.handle('execute-skill', async (event, { skillId, goalText, webContentsId, currentGraph }) => {
  const skill = skills.find(s => s.id === skillId);
  if (!skill) return { success: false, error: 'Skill not found' };

  const args = extractArgs(skill, goalText);
  const wc = webContents.fromId(webContentsId);
  const delayMs = ms => new Promise(r => setTimeout(r, ms));

  // Live page state provider — reads current URL + semantic pattern
  const getPageState = async () => {
    try {
      const url = wc && !wc.isDestroyed() ? wc.getURL() : (currentGraph?.url || '');
      const graph = currentGraph || { url, elements: [] };
      const analysis = await analyzeUIWithLLM(graph);
      return { url, pageType: analysis.semanticPattern || '' };
    } catch (_) {
      return { url: '', pageType: '' };
    }
  };

  const executeAction = async (action, payload) => {
    if (!wc || wc.isDestroyed()) return;
    if (action === 'click') {
      wc.sendInputEvent({ type: 'mouseDown', x: payload.x || 0, y: payload.y || 0, button: 'left', clickCount: 1 });
      await delayMs(50);
      wc.sendInputEvent({ type: 'mouseUp', x: payload.x || 0, y: payload.y || 0, button: 'left', clickCount: 1 });
    } else if (action === 'type') {
      for (const char of (payload.text || '')) {
        wc.sendInputEvent({ type: 'char', keyCode: char });
        await delayMs(40);
      }
    }
  };

  const sendToRenderer = (channel, data) => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, data);
  };

  try {
    const result = await executeSkill(skill, args, webContentsId, executeAction, sendToRenderer, getPageState);
    return result;
  } catch (e) {
    console.error('[execute-skill] Error:', e.message);
    return { success: false, error: e.message };
  }
});

// --- Manager: Decompose Goal ---
ipcMain.handle('decompose-goal', async (event, { goal, currentUrl, pageContext }) => {
  const skillNames = skills.map(s => s.name);
  return await decomposeGoal(goal, skillNames, currentUrl, event.sender, pageContext || null);
});


// --- Episodic Memory ---
ipcMain.handle('recall-memory', async (event, { goal, url }) => {
  return recallRelevant(goal, url);
});

ipcMain.handle('record-memory', async (event, episode) => {
  recordEpisode(episode);
  return true;
});

// ── User Variables (credentials, preferences) ─────────────────────────────
ipcMain.handle('set-variable',       async (_, { key, value }) => { memory.setVariable(key, value); return true; });
ipcMain.handle('get-variable',       async (_, key)           => memory.getVariable(key));
ipcMain.handle('list-variable-keys', async ()                  => memory.listVariableKeys());
ipcMain.handle('get-all-variables',  async ()                  => memory.getAllVariables());
ipcMain.handle('clear-variable',     async (_, key)           => { memory.clearVariable(key); return true; });

// --- Headless Research Subagent ---
ipcMain.handle('start-research', async (event, query) => {
  let fullReport = '';
  await researchHeadless(query, (token) => {
    fullReport += token;
    if (!event.sender.isDestroyed()) event.sender.send('research-stream-chunk', token);
  });
  return fullReport;
});

// --- Research Skills (headless, structured output) ---
ipcMain.handle('research-leads', async (_, criteria) => {
  try { return await searchLeads(criteria); }
  catch (e) { console.error('[research-leads]', e.message); return []; }
});

ipcMain.handle('research-company', async (_, { name }) => {
  try { return await lookupCompany(name); }
  catch (e) { console.error('[research-company]', e.message); return { name, error: e.message }; }
});

ipcMain.handle('research-app', async (_, { name }) => {
  try { return await lookupApp(name); }
  catch (e) { console.error('[research-app]', e.message); return { name, error: e.message }; }
});

ipcMain.handle('research-news', async (_, { topic, days, limit }) => {
  try { return await searchNews(topic, days || 7, limit || 10); }
  catch (e) { console.error('[research-news]', e.message); return []; }
});

ipcMain.handle('research-extract', async (_, { url, schema }) => {
  try { return await extractPageData(url, schema); }
  catch (e) { console.error('[research-extract]', e.message); return {}; }
});


// --- Observer AI ---
ipcMain.handle('observe-page', async (event, { graph, lastAction, expectation, goalContext }) => {
  try {
    return await observePageState({ graph, lastAction, expectation, goalContext });
  } catch (e) {
    console.error('[observe-page] error:', e.message);
    return { state: 'error', what_changed: 'Observer failed', action_succeeded: false, blockers: [], confidence: 0, next_hint: '' };
  }
});

// --- Recovery Agent ---
ipcMain.handle('recover-element', async (event, { targetText, targetId, currentElements, goal, siteMemory }) => {
  try {
    return await recoverMissingElement({ targetText, targetId, currentElements, goal, siteMemory });
  } catch (e) {
    console.error('[recover-element] error:', e.message);
    return { found: false };
  }
});

// --- Exploration Agent ---
ipcMain.handle('explore-page', async (event, { graph, domain }) => {
  try {
    const result = await explorePage({ graph, domain });
    if (!result) return null;
    // Auto-store page knowledge in KG
    const pageKey = `${result.domain}${new URL(graph.url.startsWith('http') ? graph.url : 'https://' + graph.url).pathname.replace(/\/\d+\/?/g, '/:id/').substring(0, 60)}`;
    await kg.upsertNode('page_knowledge', pageKey, result.pageKnowledge);
    return result;
  } catch (e) {
    console.error('[explore-page] error:', e.message);
    return null;
  }
});

// --- Behavioral Learning ---
ipcMain.handle('record-behavior', async (event, params) => {
  try {
    const record = buildBehaviorRecord(params);
    const key = `${params.domain}::${params.elementId}::${params.action}`;
    await kg.upsertNode('behavior', key, record);
    return true;
  } catch (e) {
    console.error('[record-behavior] error:', e.message);
    return false;
  }
});

// --- Native Execution Engine Bridge ---
ipcMain.handle('execute-action', async (event, actionParams) => {
  const { webContentsId, action, payload } = actionParams;
  const wc = webContents.fromId(webContentsId);

  // Guard: webContents may have been destroyed if page navigated away mid-action
  if (!wc || wc.isDestroyed()) {
    console.warn('[execute-action] webContents not available (navigated away or destroyed). Skipping.');
    return false;
  }

  const safeEvent = (evt) => {
    if (!wc.isDestroyed()) wc.sendInputEvent(evt);
  };

  // Wait utility
  const delay = (ms) => new Promise(res => setTimeout(res, ms));

  if (action === 'click') {
    const { x, y, button = 'left', clicks = 1 } = payload;
    safeEvent({ type: 'mouseDown', x, y, button, clickCount: clicks });
    await delay(50);
    safeEvent({ type: 'mouseUp', x, y, button, clickCount: clicks });
    return true;
  }

  if (action === 'hover') {
    const { x, y } = payload;
    safeEvent({ type: 'mouseMove', x, y });
    return true;
  }

  if (action === 'drag') {
    const { startX, startY, endX, endY } = payload;
    safeEvent({ type: 'mouseDown', x: startX, y: startY, button: 'left', clickCount: 1 });
    safeEvent({ type: 'mouseMove', x: endX, y: endY, button: 'left', movementX: endX - startX, movementY: endY - startY });
    safeEvent({ type: 'mouseUp', x: endX, y: endY, button: 'left', clickCount: 1 });
    return true;
  }

  if (action === 'type') {
    const { text } = payload;
    for (let i = 0; i < text.length; i++) {
      if (wc.isDestroyed()) break; // Stop typing if page navigated away
      safeEvent({ type: 'char', keyCode: text[i] });
      await delay(30 + Math.random() * 70);
    }
    return true;
  }

  if (action === 'keyboard_shortcut') {
    const { modifiers = [], keyCode } = payload;
    safeEvent({ type: 'keyDown', modifiers, keyCode });
    await delay(50);
    safeEvent({ type: 'keyUp', modifiers, keyCode });
    return true;
  }

  if (action === 'scroll') {
    const { deltaY = 500 } = payload;
    wc.executeJavaScript(`
      try {
        const scroller = document.scrollingElement || document.body;
        scroller.scrollBy({ top: ${deltaY}, behavior: "smooth" });
      } catch (e) {}
    `);
    return true;
  }

  if (action === 'download_media') {
    const { url } = payload;
    wc.downloadURL(url);
    return true;
  }

  if (action === 'execute_js') {
    const { code } = payload;
    const res = await wc.executeJavaScript(code).catch(e => e.message);
    return res;
  }

  throw new Error(`Unknown action: ${action}`);
});

app.on('window-all-closed', function () {
  if (llmProcess) llmProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (llmProcess) llmProcess.kill();
});
