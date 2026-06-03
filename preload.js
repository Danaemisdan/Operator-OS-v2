const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Browser
  getWebviews:    () => ipcRenderer.invoke('get-webviews'),
  executeAction:  (p) => ipcRenderer.invoke('execute-action', p),
  extractText:    (p) => ipcRenderer.invoke('extract-text', p),
  analyzeUI:      (g) => ipcRenderer.invoke('analyze-ui-llm', g),

  // Agent
  agentChat:      (prompt, graph, prev, memory, hist, scratchpad, memorypad, query) => ipcRenderer.invoke('agent-chat', { promptText: prompt, graph, previousActions: prev, memory, conversationHistory: hist, taskScratchpad: scratchpad, memorypad, graphQuery: query }),

  // Streams
  onAgentStream:    (cb) => ipcRenderer.on('agent-stream-chunk',   (_, t) => cb(t)),
  onResearchStream: (cb) => ipcRenderer.on('research-stream-chunk', (_, t) => cb(t)),
  onSkillAskUser:   (cb) => ipcRenderer.on('skill-ask-user',        (_, d) => cb(d)),

  // Intent + Skills
  classifyIntent: (msg)                        => ipcRenderer.invoke('classify-intent', msg),
  matchSkill:     (goal)                       => ipcRenderer.invoke('match-skill', goal),
  executeSkill:   (id, goal, wcId, graph)      => ipcRenderer.invoke('execute-skill', { skillId: id, goalText: goal, webContentsId: wcId, currentGraph: graph }),
  decomposeGoal:  (goal, url, pageContext)      => ipcRenderer.invoke('decompose-goal', { goal, currentUrl: url, pageContext }),


  // Episodic memory
  recallMemory: (goal, url) => ipcRenderer.invoke('recall-memory', { goal, url }),
  recordMemory: (ep)        => ipcRenderer.invoke('record-memory', ep),

  // User variables (credentials, preferences — persisted across sessions)
  setVariable:      (key, value) => ipcRenderer.invoke('set-variable', { key, value }),
  getVariable:      (key)        => ipcRenderer.invoke('get-variable', key),
  listVariableKeys: ()           => ipcRenderer.invoke('list-variable-keys'),
  getAllVariables:   ()           => ipcRenderer.invoke('get-all-variables'),
  clearVariable:    (key)        => ipcRenderer.invoke('clear-variable', key),

  // Research (streaming)
  startResearch: (q) => ipcRenderer.invoke('start-research', q),

  // Research Skills (headless, structured output)
  researchLeads:   (criteria) => ipcRenderer.invoke('research-leads', criteria),
  researchCompany: (name)     => ipcRenderer.invoke('research-company', { name }),
  researchApp:     (name)     => ipcRenderer.invoke('research-app', { name }),
  researchNews:    (topic, days, limit) => ipcRenderer.invoke('research-news', { topic, days, limit }),
  researchExtract: (url, schema) => ipcRenderer.invoke('research-extract', { url, schema }),

  // Legacy domain knowledge (UI scan)
  getKnowledge:  (d) => ipcRenderer.invoke('get-knowledge', d),
  saveKnowledge: (d) => ipcRenderer.invoke('save-knowledge', d),

  // ── Knowledge Graph (rich node-edge store) ──────────────────────────────
  kgUpsert:      (type, name, data) => ipcRenderer.invoke('kg-upsert', { type, name, data }),
  kgQuery:       (type, search, limit) => ipcRenderer.invoke('kg-query', { type, search, limit }),
  kgGet:         (id)   => ipcRenderer.invoke('kg-get', id),
  kgEdge:        (from, to, rel) => ipcRenderer.invoke('kg-edge', { from, to, rel }),
  kgSummary:     ()     => ipcRenderer.invoke('kg-summary'),
  kgRecordTask:  (p)    => ipcRenderer.invoke('kg-record-task', p),

  // ── Observer AI + Recovery Agent ────────────────────────────────────────────
  observePage:     (p) => ipcRenderer.invoke('observe-page', p),
  recoverElement:  (p) => ipcRenderer.invoke('recover-element', p),

  // ── Exploration Agent + Behavioral Learning ──────────────────────────────
  explorePage:     (p) => ipcRenderer.invoke('explore-page', p),
  recordBehavior:  (p) => ipcRenderer.invoke('record-behavior', p),

  // ── Pure Node Computer Vision & OS Control ─────────────────────────────
  getVisionTree:   ()  => ipcRenderer.invoke('get-vision-tree'),
  osAction:        (p) => ipcRenderer.invoke('os-action', p),
});
