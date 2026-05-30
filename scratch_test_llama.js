const path = require('path');

async function test() {
  console.log("Loading llama...");
  const { getLlama, LlamaChatSession } = await import('node-llama-cpp');
  const llama = await getLlama();
  
  console.log("Loading model...");
  const model = await llama.loadModel({
    modelPath: path.join(__dirname, 'Operator-engine-3b.gguf')
  });
  
  console.log("Creating context...");
  const context = await model.createContext({
    contextSize: 2048,
    threads: 4
  });
  
  const session = new LlamaChatSession({
    contextSequence: context.getSequence()
  });

  console.log("Prompting...");
  const q1 = "Hi, can you reply with a short test message?";
  console.log("User: " + q1);
  const a1 = await session.prompt(q1);
  console.log("AI: " + a1);
}

test().catch(console.error);
