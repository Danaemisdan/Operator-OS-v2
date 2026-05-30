const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Browser
  getWebviews:    () => ipcRenderer.invoke('get-webviews'),
  executeAction:  (p) => ipcRenderer.invoke('execute-action', p),
  extractText:    (p) => ipcRenderer.invoke('extract-text', p),
  analyzeUI:      (g) => ipcRenderer.invoke('analyze-ui-llm', g),

  // Agent
  agentChat: (prompt, graph, prev, memory, history, silent) =>
    ipcRenderer.invoke('agent-chat', { prompt, graph, previousActions: prev, memory, conversationHistory: history, silent }),

  // Streams
  onAgentStream:    (cb) => ipcRenderer.on('agent-stream-chunk',   (_, t) => cb(t)),
  onResearchStream: (cb) => ipcRenderer.on('research-stream-chunk', (_, t) => cb(t)),
  onSkillAskUser:   (cb) => ipcRenderer.on('skill-ask-user',        (_, d) => cb(d)),

  // Intent + Skills
  classifyIntent: (msg)                        => ipcRenderer.invoke('classify-intent', msg),
  matchSkill:     (goal)                       => ipcRenderer.invoke('match-skill', goal),
  executeSkill:   (id, goal, wcId, graph)      => ipcRenderer.invoke('execute-skill', { skillId: id, goalText: goal, webContentsId: wcId, currentGraph: graph }),
  decomposeGoal:  (goal, url)                  => ipcRenderer.invoke('decompose-goal', { goal, currentUrl: url }),
  pruneGraph:     (graph, goal)                => ipcRenderer.invoke('prune-graph', { graph, goalText: goal }),

  // Episodic memory
  recallMemory: (goal, url) => ipcRenderer.invoke('recall-memory', { goal, url }),
  recordMemory: (ep)        => ipcRenderer.invoke('record-memory', ep),

  // Research
  startResearch: (q) => ipcRenderer.invoke('start-research', q),

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
});
