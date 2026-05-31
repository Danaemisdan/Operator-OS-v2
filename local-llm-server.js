const http = require('http');
const path = require('path');

let llama;
let model;
let context;

async function init() {
  console.log("[Local LLM Server] Initializing node-llama-cpp...");
  const { getLlama, LlamaChatSession } = await import('node-llama-cpp');
  llama = await getLlama();

  // Use env var set by main.js (works in packaged builds on all platforms)
  // Falls back to __dirname for dev mode
  const modelPath = process.env.OPERATOR_MODEL_PATH
    || path.join(__dirname, 'Operator-engine-3b.gguf');

  console.log("[Local LLM Server] Loading model from:", modelPath);
  model = await llama.loadModel({ modelPath });
  
  console.log("[Local LLM Server] Creating context (2048 tokens, 4 threads)...");
  context = await model.createContext({
    contextSize: 2048,
    threads: 4
  });
  
  console.log("[Local LLM Server] Ready on port 8080!");
}

let isGenerating = false;
const requestQueue = [];

async function processQueue() {
  if (isGenerating || requestQueue.length === 0) return;
  isGenerating = true;
  const { req, res, body } = requestQueue.shift();
  
  let sequence = null;

  try {
    const payload = JSON.parse(body);
    const messages = payload.messages || [];
    const prompt = messages.map(m => m.content).join('\n');
    
    console.log(`[Local LLM Server] Received prompt (${prompt.length} chars)`);
    
    sequence = context.getSequence();
    const { LlamaChatSession } = await import('node-llama-cpp');
    const session = new LlamaChatSession({
      contextSequence: sequence
    });
    
    if (payload.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      
      await session.prompt(prompt, {
         temperature: payload.temperature || 0.1,
         onTextChunk: (chunk) => {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
         }
      });
      
      res.write('data: [DONE]\n\n');
      res.end();
      console.log(`[Local LLM Server] Streamed response completed`);
    } else {
      const responseText = await session.prompt(prompt, {
         temperature: payload.temperature || 0.1
      });
      
      console.log(`[Local LLM Server] Generated response (${responseText.length} chars)`);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: { content: responseText }
        }]
      }));
    }
  } catch (err) {
    console.error("[Local LLM Server] Error handling request:", err);
    res.writeHead(500);
    res.end("Internal Server Error");
  } finally {
    if (sequence) {
      try { sequence.dispose(); } catch (e) {}
    }
    isGenerating = false;
    processQueue();
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      requestQueue.push({ req, res, body });
      processQueue();
    });
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

init().then(() => {
  server.listen(8080, '127.0.0.1');
}).catch(console.error);
