'use strict';
/**
 * KNOWLEDGE GRAPH — Persistent node-edge store for the Operator agent.
 *
 * Node types:
 *   person   — { name, platforms, notes, tags }
 *   task     — { goal, status, steps, outcome, date }
 *   message  — { to, from, content, platform, date }
 *   note     — { text, context, date }
 *   url      — { url, title, type, visited, notes }
 *   entity   — generic catch-all (product, company, event, etc.)
 *
 * Edges connect nodes: { from, to, rel }
 * rel examples: 'sent_to', 'about', 'involved', 'references', 'completed'
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const KG_DIR  = path.join(os.homedir(), '.operator');
const KG_FILE = path.join(KG_DIR, 'knowledge-graph.json');

// ── Ensure storage directory exists ──────────────────────────────────────────
if (!fs.existsSync(KG_DIR)) fs.mkdirSync(KG_DIR, { recursive: true });

// ── Load or create the graph ──────────────────────────────────────────────────
function loadGraph() {
  try {
    if (fs.existsSync(KG_FILE)) {
      return JSON.parse(fs.readFileSync(KG_FILE, 'utf8'));
    }
  } catch (_) {}
  return { nodes: {}, edges: [] };
}

function saveGraph(graph) {
  fs.writeFileSync(KG_FILE, JSON.stringify(graph, null, 2), 'utf8');
}

// ── Generate a stable ID from type + name ────────────────────────────────────
function makeId(type, name) {
  const clean = String(name).toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 40);
  return `${type}_${clean}_${Date.now().toString(36)}`;
}

// ─── API ──────────────────────────────────────────────────────────────────────

/**
 * Add or update a node.
 * If a node with same type+name already exists, merges data into it.
 */
function upsertNode(type, name, data = {}) {
  const graph = loadGraph();

  // Find existing node by type + name (case-insensitive)
  let existingId = null;
  for (const [id, node] of Object.entries(graph.nodes)) {
    if (node.type === type && node.name && node.name.toLowerCase() === String(name).toLowerCase()) {
      existingId = id;
      break;
    }
  }

  if (existingId) {
    // Merge: deep-merge arrays, overwrite scalars
    const existing = graph.nodes[existingId];
    for (const [k, v] of Object.entries(data)) {
      if (Array.isArray(existing[k]) && Array.isArray(v)) {
        existing[k] = [...new Set([...existing[k], ...v])];
      } else {
        existing[k] = v;
      }
    }
    existing.updatedAt = new Date().toISOString();
    saveGraph(graph);
    return existingId;
  }

  const id = makeId(type, name);
  graph.nodes[id] = {
    id,
    type,
    name,
    ...data,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveGraph(graph);
  return id;
}

/**
 * Add an edge between two node IDs.
 */
function addEdge(fromId, toId, rel) {
  const graph = loadGraph();
  // Deduplicate edges
  const exists = graph.edges.some(e => e.from === fromId && e.to === toId && e.rel === rel);
  if (!exists) {
    graph.edges.push({ from: fromId, to: toId, rel, at: new Date().toISOString() });
    saveGraph(graph);
  }
}

/**
 * Query nodes by type, optional text search on name/notes.
 */
function queryNodes(type = null, search = null, limit = 50) {
  const graph = loadGraph();
  let results = Object.values(graph.nodes);

  if (type) results = results.filter(n => n.type === type);

  if (search) {
    const q = search.toLowerCase();
    results = results.filter(n => {
      const hay = [n.name, n.text, n.goal, n.content, n.url, ...(n.notes || [])]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  return results
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .slice(0, limit);
}

/**
 * Get a node and all its edges.
 */
function getNode(id) {
  const graph = loadGraph();
  const node = graph.nodes[id];
  if (!node) return null;
  const edges = graph.edges.filter(e => e.from === id || e.to === id);
  return { ...node, edges };
}

/**
 * Delete a node and its edges.
 */
function deleteNode(id) {
  const graph = loadGraph();
  delete graph.nodes[id];
  graph.edges = graph.edges.filter(e => e.from !== id && e.to !== id);
  saveGraph(graph);
}

/**
 * Get full graph summary (counts + recent nodes).
 */
function getGraphSummary() {
  const graph = loadGraph();
  const nodes = Object.values(graph.nodes);
  const byType = {};
  for (const n of nodes) byType[n.type] = (byType[n.type] || 0) + 1;
  return {
    totalNodes: nodes.length,
    totalEdges: graph.edges.length,
    byType,
    recent: nodes
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
      .slice(0, 10)
      .map(n => ({ id: n.id, type: n.type, name: n.name, updatedAt: n.updatedAt })),
  };
}

/**
 * Agent shortcut: store a completed task + any people/entities mentioned.
 */
function recordTaskResult({ goal, outcome, status = 'complete', entities = [], url = '' }) {
  const taskId = upsertNode('task', goal, { goal, outcome, status, url });

  for (const entity of entities) {
    if (!entity.name) continue;
    const entId = upsertNode(entity.type || 'entity', entity.name, entity.data || {});
    addEdge(taskId, entId, entity.rel || 'involved');
  }

  return taskId;
}

module.exports = {
  upsertNode,
  addEdge,
  queryNodes,
  getNode,
  deleteNode,
  getGraphSummary,
  recordTaskResult,
  loadGraph,
};
