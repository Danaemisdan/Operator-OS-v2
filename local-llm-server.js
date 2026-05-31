'use strict';
const http = require('http');
const path = require('path');

let model, LlamaChatSession, session;
let isReady = false;
let isGenerating = false;
const requestQueue = [];

async function init() {
  console.log('[Local LLM Server] Initializing node-llama-cpp...');
  const mod = await import('node-llama-cpp');
  const llama = await mod.getLlama();
  LlamaChatSession = mod.LlamaChatSession;

  const modelPath = process.env.OPERATOR_MODEL_PATH
    || path.join(__dirname, 'Operator-engine-3b.gguf');

  console.log('[Local LLM Server] Loading model from:', modelPath);
  model = await llama.loadModel({ modelPath });

  // One context, one sequence — shared across all requests.
  // clearHistory() before each request resets the KV cache without re-allocating.
  console.log('[Local LLM Server] Creating context (4096 tokens, 4 threads)...');
  const context = await model.createContext({ contextSize: 4096, threads: 4 });
  session = new LlamaChatSession({ contextSequence: context.getSequence() });

  isReady = true;
  console.log('[Local LLM Server] Ready on port 8080!');
}

async function handleRequest(res, body) {
  // Reset session state — clears KV cache so each request gets a clean slate
  try { await session.clearHistory(); } catch (_) {
    try { session.clearHistory(); } catch (_2) {}
  }

  const payload  = JSON.parse(body);
  const messages = payload.messages || [];
  const prompt   = messages.map(m => m.content).join('\n');

  console.log(`[Local LLM Server] Received prompt (${prompt.length} chars)`);

  const opts = {
    temperature: payload.temperature ?? 0.1,
    maxTokens:   payload.max_tokens  || 512,
  };

  let outputLen = 0;

  if (payload.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':   'keep-alive',
    });

    await session.prompt(prompt, {
      ...opts,
      onTextChunk: (chunk) => {
        outputLen += chunk.length;
        try {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
        } catch (_) {}
      },
    });

    console.log(`[Local LLM Server] Streamed response completed (${outputLen} chars)`);
    res.write('data: [DONE]\n\n');
    res.end();

  } else {
    const text = await session.prompt(prompt, opts);
    console.log(`[Local LLM Server] Response (${text.length} chars)`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
  }
}

async function processQueue() {
  if (isGenerating || requestQueue.length === 0 || !isReady) return;
  isGenerating = true;

  const { res, body } = requestQueue.shift();

  try {
    await handleRequest(res, body);
  } catch (err) {
    console.error('[Local LLM Server] Error:', err.message);
    try { res.writeHead(500); res.end('Internal Server Error'); } catch (_) {}
  } finally {
    isGenerating = false;
    setImmediate(processQueue); // process next as soon as event loop is free
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      requestQueue.push({ res, body });
      processQueue();
    });
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: isReady ? 'ready' : 'loading', queue: requestQueue.length }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

init()
  .then(() => server.listen(8080, '127.0.0.1'))
  .catch(err => {
    console.error('[Local LLM Server] Fatal init error:', err);
    process.exit(1);
  });
