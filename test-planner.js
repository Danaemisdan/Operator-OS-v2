const { decomposeGoal } = require('./manager-agent.js');
async function run() {
  const res = await decomposeGoal("Find 500 AI startups and contact founders", ["navigate", "click", "type"], "https://google.com", null);
  console.log(JSON.stringify(res, null, 2));
}
run();
