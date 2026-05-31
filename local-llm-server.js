const http = require('http');
const path = require('path');

let model;
let context;
let session;        // single persistent session — reset between requests
let isReady = false;

async function init() {
  console.log('[Local LLM Server] Initializing node-llama-cpp...');
  const { getLlama, LlamaChatSession } = await import('node-llama-cpp');
  const llama = await getLlama();

  const modelPath = process.env.OPERATOR_MODEL_PATH
    || path.join(__dirname, 'Operator-engine-3b.gguf');

  console.log('[Local LLM Server] Loading model from:', modelPath);
  model = await llama.loadModel({ modelPath });

  console.log('[Local LLM Server] Creating context (2048 tokens, 4 threads)...');
  context = await model.createContext({ contextSize: 2048, threads: 4 });

  // One persistent session — never disposed, history cleared per request
  const sequence = context.getSequence();
  session = new LlamaChatSession({ contextSequence: sequence });

  isReady = true;
  console.log('[Local LLM Server] Ready on port 8080!');
}

let isGenerating = false;
const requestQueue = [];

async function processQueue() {
  if (isGenerating || requestQueue.length === 0 || !isReady) return;
  isGenerating = true;

  const { res, body } = requestQueue.shift();

  try {
    const payload = JSON.parse(body);
    const messages = payload.messages || [];
    const prompt   = messages.map(m => m.content).join('\n');

    console.log(`[Local LLM Server] Received prompt (${prompt.length} chars)`);

    // Reset session history so each request is fully independent
    try { await session.setChatHistory([]); } catch (_) {}

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
      console.log(`[Local LLM Server] Non-stream response (${text.length} chars)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
    }

  } catch (err) {
    console.error('[Local LLM Server] Error during generation:', err.message);
    try { res.writeHead(500); res.end('Internal Server Error'); } catch (_) {}
  } finally {
    isGenerating = false;
    setTimeout(processQueue, 20); // small gap then process next
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
