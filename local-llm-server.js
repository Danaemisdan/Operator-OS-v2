const http = require('http');
const path = require('path');

let model;       // loaded once, never disposed
let LlamaChatSession;
let isReady = false;

async function init() {
  console.log('[Local LLM Server] Initializing node-llama-cpp...');
  const mod = await import('node-llama-cpp');
  const llama = await mod.getLlama();
  LlamaChatSession = mod.LlamaChatSession;

  const modelPath = process.env.OPERATOR_MODEL_PATH
    || path.join(__dirname, 'Operator-engine-3b.gguf');

  console.log('[Local LLM Server] Loading model from:', modelPath);
  model = await llama.loadModel({ modelPath });

  isReady = true;
  console.log('[Local LLM Server] Ready on port 8080!');
}

let isGenerating = false;
const requestQueue = [];

async function processQueue() {
  if (isGenerating || requestQueue.length === 0 || !isReady) return;
  isGenerating = true;

  const { res, body } = requestQueue.shift();
  let reqContext = null;

  try {
    const payload = JSON.parse(body);
    const messages = payload.messages || [];
    const prompt   = messages.map(m => m.content).join('\n');

    console.log(`[Local LLM Server] Received prompt (${prompt.length} chars)`);

    // Fresh context + session for every request — guarantees clean KV cache
    // Model stays loaded; only the KV cache buffer is recreated (~0.3s overhead)
    reqContext = await model.createContext({ contextSize: 2048, threads: 4 });
    const sequence = reqContext.getSequence();
    const session  = new LlamaChatSession({ contextSequence: sequence });

    const opts = {
      temperature: payload.temperature ?? 0.1,
      maxTokens:   payload.max_tokens  || 512,
    };

    if (payload.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':   'keep-alive',
      });

      await session.prompt(prompt, {
        ...opts,
        onTextChunk: (chunk) => {
          try {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
          } catch (_) {}
        },
      });

      res.write('data: [DONE]\n\n');
      res.end();
      console.log('[Local LLM Server] Streamed response completed');

    } else {
      const text = await session.prompt(prompt, opts);
      console.log(`[Local LLM Server] Response (${text.length} chars)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
    }

  } catch (err) {
    console.error('[Local LLM Server] Error:', err.message);
    try { res.writeHead(500); res.end('Internal Server Error'); } catch (_) {}
  } finally {
    // Dispose the per-request context to free KV cache memory
    if (reqContext) {
      try { await reqContext.dispose(); } catch (_) {}
    }
    isGenerating = false;
    setTimeout(processQueue, 20);
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
