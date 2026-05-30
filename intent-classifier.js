'use strict';

// ─── TASK IMPERATIVE VERBS ─────────────────────────────────────────────────
// If a message STARTS with one of these, it's a browser task.
const TASK_VERBS = new Set([
  'open', 'go to', 'go', 'navigate', 'navigate to',
  'search', 'search for', 'look up', 'find', 'find me',
  'click', 'type', 'press', 'scroll', 'tap',
  'download', 'upload', 'save',
  'send', 'compose', 'write an email', 'email',
  'create', 'make', 'build', 'new',
  'delete', 'remove', 'close', 'clear',
  'login', 'log in', 'sign in', 'sign out', 'logout', 'log out',
  'buy', 'order', 'book', 'purchase', 'add to cart',
  'play', 'watch', 'listen to', 'stream',
  'show me', 'display', 'get me', 'bring up',
  'check', 'apply', 'fill', 'submit', 'enter',
  'switch', 'change', 'update', 'refresh', 'reload',
  'share', 'copy', 'paste', 'print', 'export',
  'sort', 'filter', 'select', 'choose', 'pick',
  'read', 'check my', 'open my', 'show my',
  'message', 'send a message', 'dm', 'reply to',
  'schedule', 'set a', 'add a', 'create a',
  'join', 'leave', 'follow', 'unfollow', 'connect',
  'upload a', 'post a', 'tweet', 'like', 'comment',
  'apply for', 'apply to', 'register for', 'sign up for',
]);

// Task phrases are fully covered by TASK_VERBS above.
// Any action verb followed by a destination, platform, or object = task.
// No hardcoded phrase list needed — verb detection handles all cases.
const TASK_PHRASES = [];


// Prefixes that redirect to underlying intent ('can you open gmail' → task)
const REDIRECT_PREFIXES = [
  'can you ', 'could you ', 'please ', 'would you ',
  'help me ', 'i want to ', 'i need to ', 'i want you to ',
  'i need you to ', 'let\'s ', "let's ",
];

// ─── RESEARCH TRIGGERS ─────────────────────────────────────────────────────
// These override task if present — they need the research subagent
const RESEARCH_STARTERS = [
  'research ', 'deep dive ', 'investigate ', 'find out everything',
  'give me a full report', 'analyse ', 'analyze ', 'summarise ', 'summarize ',
  'compile info', 'write a report on',
];

// ─── CONTINUOUS TRIGGERS ───────────────────────────────────────────────────
const CONTINUOUS_TRIGGERS = [
  'keep doing', 'continuously', 'keep applying', 'keep checking',
  'monitor ', 'watch for ', 'repeatedly ', 'every minute',
  'every hour', 'loop through', 'until done', 'apply to all',
  'find and apply to', 'keep running',
];

// ─── CLASSIFIER ───────────────────────────────────────────────────
async function classifyIntent(message) {
  if (!message || typeof message !== 'string') {
    return { intent: 'chat', confidence: 0.5 };
  }

  const lower = message.toLowerCase().trim();

  // 1. Research overrides everything
  for (const starter of RESEARCH_STARTERS) {
    if (lower.startsWith(starter) || lower.includes(starter)) {
      return { intent: 'research_for_me', confidence: 0.92 };
    }
  }

  // 2. Continuous task loop
  for (const trigger of CONTINUOUS_TRIGGERS) {
    if (lower.includes(trigger)) {
      return { intent: 'continuous', confidence: 0.88 };
    }
  }

  // 3. Task phrases anywhere in message
  for (const phrase of TASK_PHRASES) {
    if (lower.includes(phrase)) {
      return { intent: 'task', confidence: 0.9 };
    }
  }

  // 4. Strip redirect prefixes and re-check task verbs
  // e.g. "can you send a message on linkedin?" → "send a message on linkedin?" → task
  let checkStr = lower;
  for (const prefix of REDIRECT_PREFIXES) {
    if (lower.startsWith(prefix)) {
      checkStr = lower.slice(prefix.length).trim();
      break;
    }
  }
  // Remove trailing question mark for cleaner matching
  checkStr = checkStr.replace(/\?$/, '').trim();

  // 5. Check task verbs on original OR stripped string
  for (const str of [lower, checkStr]) {
    for (const verb of TASK_VERBS) {
      if (str === verb || str.startsWith(verb + ' ') || str.startsWith(verb + ',')) {
        return { intent: 'task', confidence: 0.92 };
      }
    }
  }

  // 6. Named-service escalation — if a message contains an action word AND what
  //    looks like a named service or app (a word that isn't a common English word),
  //    treat it as a task. Works for any app/site, not just a hardcoded list.
  //    e.g. "find me sales leads on LinkedIn" / "open Notion" / "check Slack"
  const COMMON_WORDS = new Set([
    'the','a','an','and','or','but','in','on','at','to','for','of','with',
    'it','is','was','be','do','as','we','me','my','you','your','he','she',
    'what','how','why','when','where','who','that','this','these','those',
    'get','set','see','use','let','has','had','can','may','not','all','any',
    'new','one','two','out','now','just','more','also','like','here','there',
    'best','good','help','need','want','make','find','show','tell','know',
    'go','do','up','down','back','look','some','from','than','then','they',
    'him','her','its','our','us','am','are','will','would','could','should',
  ]);
  const words = lower.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length >= 3);
  // A "named service" word: not a common English word, looks like a brand name (short, no spaces)
  const hasNamedService = words.some(w => !COMMON_WORDS.has(w) && /^[a-z][a-z0-9]{2,}$/.test(w) && words.length <= 8);
  // Action detected using same TASK_VERBS set already defined above
  const hasAction = [...TASK_VERBS].some(v => lower.includes(v));
  if (hasNamedService && hasAction) {
    return { intent: 'task', confidence: 0.85 };
  }
  // Short message that looks like a navigation intent (just a name + maybe "open/go")
  if (hasNamedService && lower.split(/\s+/).length <= 4) {
    return { intent: 'task', confidence: 0.80 };
  }


  // 7. Everything else is conversation
  return { intent: 'chat', confidence: 0.85 };
}

module.exports = { classifyIntent };
