'use strict';

// ─── SKILL SCHEMA ─────────────────────────────────────────────────────────────
//
// Each skill has:
//   id, name, triggers[], description, requiresArgs[], steps[]
//
// Step types:
//   { action: 'navigate', url }
//   { action: 'type', targetHint, text }
//   { action: 'click', targetHint }
//   { action: 'wait', ms }
//   { action: 'verify', expect }
//   { action: 'research', query }
//   { action: 'ask_user', question }  ← pauses loop, asks human
//
// Smart conditions on any step:
//   skipIf: { alreadyOnDomain: 'mail.google.com' }  ← skip if already there
//   skipIf: { pageType: 'Search Results Page' }      ← skip if page already done
//   runIf:  { pageType: 'Authentication / Sign-in Portal' }  ← only run if login wall
//   runIf:  { urlContains: 'accounts.google' }

const skills = [

  // ══════════════════════════════════════════════════════════════════════════
  // SEARCH ENGINE SKILLS
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: 'google_search',
    name: 'Google Search',
    triggers: ['search for', 'search on google', 'google search', 'look up on google', 'google for'],
    description: 'Searches Google for a query.',
    requiresArgs: ['query'],
    steps: [
      { action: 'navigate', url: 'https://www.google.com/search?q={{query}}', skipIf: { urlContains: 'google.com/search?q=' } },
      { action: 'wait', ms: 1000 },
    ],
  },

  {
    id: 'google_images',
    name: 'Google Image Search',
    triggers: ['find images of', 'image search for', 'search images of', 'google images'],
    description: 'Searches Google Images.',
    requiresArgs: ['query'],
    steps: [
      { action: 'navigate', url: 'https://www.google.com/search?tbm=isch&q={{query}}' },
      { action: 'wait', ms: 1200 },
    ],
  },

  {
    id: 'google_news',
    name: 'Google News',
    triggers: ['news about', 'latest news on', 'search news for', 'google news'],
    description: 'Searches Google News.',
    requiresArgs: ['query'],
    steps: [
      { action: 'navigate', url: 'https://news.google.com/search?q={{query}}' },
      { action: 'wait', ms: 1500 },
    ],
  },

  {
    id: 'duckduckgo_search',
    name: 'DuckDuckGo Search',
    triggers: ['duckduckgo', 'private search for', 'search privately for', 'ddg'],
    description: 'Private search using DuckDuckGo.',
    requiresArgs: ['query'],
    steps: [
      { action: 'navigate', url: 'https://duckduckgo.com/?q={{query}}' },
      { action: 'wait', ms: 1200 },
    ],
  },

  {
    id: 'youtube_search',
    name: 'YouTube Search',
    triggers: ['search youtube for', 'find on youtube', 'watch on youtube', 'youtube search'],
    description: 'Searches YouTube.',
    requiresArgs: ['query'],
    steps: [
      { action: 'navigate', url: 'https://www.youtube.com/results?search_query={{query}}' },
      { action: 'wait', ms: 1500 },
    ],
  },

  {
    id: 'wikipedia_lookup',
    name: 'Wikipedia Lookup',
    triggers: ['look up on wikipedia', 'wikipedia search', 'search wikipedia for'],
    description: 'Looks up a topic on Wikipedia.',
    requiresArgs: ['query'],
    steps: [
      { action: 'navigate', url: 'https://en.wikipedia.org/wiki/Special:Search?search={{query}}&go=Go' },
      { action: 'wait', ms: 1500 },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // GOOGLE WORKSPACE
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: 'open_gmail',
    name: 'Open Gmail',
    triggers: ['open gmail', 'go to gmail', 'check email', 'check my email', 'check inbox', 'open inbox', 'read my email'],
    description: 'Opens Gmail inbox.',
    requiresArgs: [],
    steps: [
      { action: 'navigate', url: 'https://mail.google.com/mail/u/0/#inbox', skipIf: { alreadyOnDomain: 'mail.google.com' } },
      { action: 'wait', ms: 2500 },
      // If a login wall appears, ask for credentials
      { action: 'ask_user', question: 'Gmail needs you to sign in. Please log in manually in the browser, then come back and say "done".', runIf: { pageType: 'Authentication / Sign-in Portal' } },
    ],
  },

  {
    id: 'compose_gmail',
    name: 'Compose Gmail',
    triggers: ['send an email', 'compose an email', 'write an email', 'new email', 'compose email on gmail'],
    description: 'Opens Gmail compose window.',
    requiresArgs: [],
    steps: [
      { action: 'navigate', url: 'https://mail.google.com/mail/u/0/#compose', skipIf: { alreadyOnDomain: 'mail.google.com' } },
      { action: 'wait', ms: 2500 },
      { action: 'ask_user', question: 'Gmail needs you to sign in first. Please log in, then say "done".', runIf: { pageType: 'Authentication / Sign-in Portal' } },
    ],
  },

  {
    id: 'google_drive',
    name: 'Open Google Drive',
    triggers: ['open google drive', 'go to drive', 'open my drive', 'open drive'],
    description: 'Opens Google Drive.',
    requiresArgs: [],
    steps: [
      { action: 'navigate', url: 'https://drive.google.com/drive/my-drive', skipIf: { alreadyOnDomain: 'drive.google.com' } },
      { action: 'wait', ms: 2500 },
      { action: 'ask_user', question: 'Google Drive needs sign-in. Log in then say "done".', runIf: { pageType: 'Authentication / Sign-in Portal' } },
    ],
  },

  {
    id: 'google_docs',
    name: 'New Google Doc',
    triggers: ['new google doc', 'create a google doc', 'open google docs', 'new document'],
    description: 'Creates a new Google Doc.',
    requiresArgs: [],
    steps: [
      { action: 'navigate', url: 'https://docs.google.com/document/create' },
      { action: 'wait', ms: 2500 },
      { action: 'ask_user', question: 'Google Docs needs sign-in. Log in then say "done".', runIf: { pageType: 'Authentication / Sign-in Portal' } },
    ],
  },

  {
    id: 'google_sheets',
    name: 'New Google Sheet',
    triggers: ['new google sheet', 'create a spreadsheet', 'open google sheets', 'new sheet'],
    description: 'Creates a new Google Sheet.',
    requiresArgs: [],
    steps: [
      { action: 'navigate', url: 'https://sheets.google.com/spreadsheets/create' },
      { action: 'wait', ms: 2500 },
      { action: 'ask_user', question: 'Google Sheets needs sign-in. Log in then say "done".', runIf: { pageType: 'Authentication / Sign-in Portal' } },
    ],
  },

  {
    id: 'google_calendar',
    name: 'Open Google Calendar',
    triggers: ['open google calendar', 'open my calendar', 'check calendar', 'go to calendar'],
    description: 'Opens Google Calendar.',
    requiresArgs: [],
    steps: [
      { action: 'navigate', url: 'https://calendar.google.com', skipIf: { alreadyOnDomain: 'calendar.google.com' } },
      { action: 'wait', ms: 2000 },
      { action: 'ask_user', question: 'Google Calendar needs sign-in. Log in then say "done".', runIf: { pageType: 'Authentication / Sign-in Portal' } },
    ],
  },

  {
    id: 'google_maps',
    name: 'Google Maps',
    triggers: ['open google maps', 'directions to', 'find on map', 'google maps'],
    description: 'Opens Google Maps for a location.',
    requiresArgs: ['query'],
    steps: [
      { action: 'navigate', url: 'https://www.google.com/maps/search/{{query}}' },
      { action: 'wait', ms: 2500 },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // SOCIAL MEDIA
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: 'open_twitter',
    name: 'Open Twitter/X',
    triggers: ['open twitter', 'open x', 'go to twitter', 'go to x', 'twitter home'],
    description: 'Opens Twitter/X.',
    requiresArgs: [],
    steps: [
      { action: 'navigate', url: 'https://x.com/home', skipIf: { alreadyOnDomain: 'x.com' } },
      { action: 'wait', ms: 2000 },
      { action: 'ask_user', question: 'Twitter/X needs you to log in. Please sign in, then say "done".', runIf: { pageType: 'Authentication / Sign-in Portal' } },
    ],
  },

  {
    id: 'search_twitter',
    name: 'Search Twitter/X',
    triggers: ['search twitter for', 'search on twitter', 'find on twitter', 'find tweets about'],
    description: 'Searches Twitter/X.',
    requiresArgs: ['query'],
    steps: [
      { action: 'navigate', url: 'https://x.com/search?q={{query}}&src=typed_query' },
      { action: 'wait', ms: 2000 },
    ],
  },

  {
    id: 'open_linkedin',
    name: 'Open LinkedIn',
    triggers: ['open linkedin', 'go to linkedin', 'linkedin home', 'linkedin feed'],
    description: 'Opens LinkedIn.',
    requiresArgs: [],
    steps: [
      { action: 'navigate', url: 'https://www.linkedin.com/feed/', skipIf: { alreadyOnDomain: 'linkedin.com' } },
      { action: 'wait', ms: 2500 },
      { action: 'ask_user', question: 'LinkedIn needs you to sign in. Please log in, then say "done".', runIf: { pageType: 'Authentication / Sign-in Portal' } },
    ],
  },

  {
    id: 'linkedin_jobs',
    name: 'LinkedIn Job Search',
    triggers: ['find jobs on linkedin', 'search linkedin jobs', 'linkedin job search', 'look for jobs on linkedin'],
    description: 'Searches LinkedIn jobs.',
    requiresArgs: ['query'],
    steps: [
      { action: 'navigate', url: 'https://www.linkedin.com/jobs/search/?keywords={{query}}' },
      { action: 'wait', ms: 2500 },
      { action: 'ask_user', question: 'LinkedIn needs you to sign in to see jobs. Log in then say "done".', runIf: { pageType: 'Authentication / Sign-in Portal' } },
    ],
  },

  {
    id: 'linkedin_people',
    name: 'LinkedIn People Search',
    triggers: ['find person on linkedin', 'search people on linkedin', 'linkedin profile search'],
    description: 'Searches LinkedIn for people.',
    requiresArgs: ['query'],
    steps: [
      { action: 'navigate', url: 'https://www.linkedin.com/search/results/people/?keywords={{query}}' },
      { action: 'wait', ms: 2500 },
    ],
  },

  {
    id: 'open_instagram',
    name: 'Open Instagram',
    triggers: ['open instagram', 'go to instagram', 'instagram home'],
    description: 'Opens Instagram.',
    requiresArgs: [],
    steps: [
      { action: 'navigate', url: 'https://www.instagram.com/', skipIf: { alreadyOnDomain: 'instagram.com' } },
      { action: 'wait', ms: 2500 },
      { action: 'ask_user', question: 'Instagram needs sign-in. Log in then say "done".', runIf: { pageType: 'Authentication / Sign-in Portal' } },
    ],
  },

  {
    id: 'open_reddit',
    name: 'Open Reddit',
    triggers: ['open reddit', 'go to reddit', 'reddit home'],
    description: 'Opens Reddit.',
    requiresArgs: [],
    steps: [
      { action: 'navigate', url: 'https://www.reddit.com/', skipIf: { alreadyOnDomain: 'reddit.com' } },
      { action: 'wait', ms: 2000 },
    ],
  },

  {
    id: 'search_reddit',
    name: 'Search Reddit',
    triggers: ['search reddit for', 'find on reddit', 'reddit search'],
    description: 'Searches Reddit.',
    requiresArgs: ['query'],
    steps: [
      { action: 'navigate', url: 'https://www.reddit.com/search/?q={{query}}' },
      { action: 'wait', ms: 2000 },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // DEV TOOLS
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: 'github_search',
    name: 'GitHub Repo Search',
    triggers: ['search github for', 'find on github', 'github repo', 'open github'],
    description: 'Searches GitHub.',
    requiresArgs: ['query'],
    steps: [
      { action: 'navigate', url: 'https://github.com/search?q={{query}}&type=repositories' },
      { action: 'wait', ms: 1800 },
    ],
  },

  {
    id: 'stackoverflow_search',
    name: 'Stack Overflow Search',
    triggers: ['search stackoverflow for', 'stack overflow', 'coding question about', 'stackoverflow'],
    description: 'Searches Stack Overflow.',
    requiresArgs: ['query'],
    steps: [
      { action: 'navigate', url: 'https://stackoverflow.com/search?q={{query}}' },
      { action: 'wait', ms: 1800 },
    ],
  },

  {
    id: 'npm_search',
    name: 'NPM Package Search',
    triggers: ['search npm for', 'find npm package', 'npm package'],
    description: 'Searches NPM.',
    requiresArgs: ['query'],
    steps: [
      { action: 'navigate', url: 'https://www.npmjs.com/search?q={{query}}' },
      { action: 'wait', ms: 1500 },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // SHOPPING
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: 'amazon_search',
    name: 'Amazon Search',
    triggers: ['search amazon for', 'find on amazon', 'buy on amazon', 'amazon'],
    description: 'Searches Amazon.',
    requiresArgs: ['query'],
    steps: [
      { action: 'navigate', url: 'https://www.amazon.com/s?k={{query}}' },
      { action: 'wait', ms: 2000 },
      { action: 'ask_user', question: 'Amazon needs sign-in to proceed. Log in then say "done".', runIf: { pageType: 'Authentication / Sign-in Portal' } },
    ],
  },

  {
    id: 'ebay_search',
    name: 'eBay Search',
    triggers: ['search ebay for', 'find on ebay', 'ebay'],
    description: 'Searches eBay.',
    requiresArgs: ['query'],
    steps: [
      { action: 'navigate', url: 'https://www.ebay.com/sch/i.html?_nkw={{query}}' },
      { action: 'wait', ms: 2000 },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // PRODUCTIVITY
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: 'open_notion',
    name: 'Open Notion',
    triggers: ['open notion', 'go to notion', 'notion workspace'],
    description: 'Opens Notion.',
    requiresArgs: [],
    steps: [
      { action: 'navigate', url: 'https://www.notion.so/', skipIf: { alreadyOnDomain: 'notion.so' } },
      { action: 'wait', ms: 2500 },
      { action: 'ask_user', question: 'Notion needs sign-in. Log in then say "done".', runIf: { pageType: 'Authentication / Sign-in Portal' } },
    ],
  },

  {
    id: 'open_figma',
    name: 'Open Figma',
    triggers: ['open figma', 'go to figma', 'figma design'],
    description: 'Opens Figma.',
    requiresArgs: [],
    steps: [
      { action: 'navigate', url: 'https://www.figma.com/files/recents-and-sharing', skipIf: { alreadyOnDomain: 'figma.com' } },
      { action: 'wait', ms: 2500 },
      { action: 'ask_user', question: 'Figma needs sign-in. Log in then say "done".', runIf: { pageType: 'Authentication / Sign-in Portal' } },
    ],
  },

  {
    id: 'open_chatgpt',
    name: 'Open ChatGPT',
    triggers: ['open chatgpt', 'go to chatgpt', 'use chatgpt', 'open chat gpt'],
    description: 'Opens ChatGPT.',
    requiresArgs: [],
    steps: [
      { action: 'navigate', url: 'https://chat.openai.com/', skipIf: { alreadyOnDomain: 'chat.openai.com' } },
      { action: 'wait', ms: 2500 },
      { action: 'ask_user', question: 'ChatGPT needs sign-in. Log in then say "done".', runIf: { pageType: 'Authentication / Sign-in Portal' } },
    ],
  },

  {
    id: 'open_slack',
    name: 'Open Slack',
    triggers: ['open slack', 'go to slack', 'check slack'],
    description: 'Opens Slack.',
    requiresArgs: [],
    steps: [
      { action: 'navigate', url: 'https://app.slack.com/', skipIf: { alreadyOnDomain: 'slack.com' } },
      { action: 'wait', ms: 2500 },
      { action: 'ask_user', question: 'Slack needs sign-in. Log in then say "done".', runIf: { pageType: 'Authentication / Sign-in Portal' } },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // NEWS & CONTENT
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: 'hacker_news',
    name: 'Open Hacker News',
    triggers: ['open hacker news', 'hacker news', 'hackernews', 'tech news'],
    description: 'Opens Hacker News.',
    requiresArgs: [],
    steps: [
      { action: 'navigate', url: 'https://news.ycombinator.com/', skipIf: { alreadyOnDomain: 'ycombinator.com' } },
      { action: 'wait', ms: 1500 },
    ],
  },

  {
    id: 'bbc_news',
    name: 'Open BBC News',
    triggers: ['open bbc news', 'bbc news', 'world news', 'open news'],
    description: 'Opens BBC News.',
    requiresArgs: [],
    steps: [
      { action: 'navigate', url: 'https://www.bbc.com/news', skipIf: { alreadyOnDomain: 'bbc.com' } },
      { action: 'wait', ms: 1800 },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // RESEARCH SKILLS (trigger headless research subagent)
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: 'research_person',
    name: 'Research a Person',
    triggers: ['research person', 'find info about the person', 'background on', 'who exactly is'],
    description: 'Researches a person across web sources.',
    requiresArgs: ['query'],
    steps: [
      { action: 'research', query: '{{query}} biography career background who is' },
    ],
  },

  {
    id: 'research_company',
    name: 'Research a Company',
    triggers: ['research company', 'research the company', 'find info about company', 'company background'],
    description: 'Researches a company.',
    requiresArgs: ['query'],
    steps: [
      { action: 'research', query: '{{query}} company overview revenue founded products services' },
    ],
  },

  {
    id: 'research_topic',
    name: 'Research a Topic',
    triggers: ['research topic', 'research about', 'find everything about', 'deep research on'],
    description: 'Deep headless research on any topic.',
    requiresArgs: ['query'],
    steps: [
      { action: 'research', query: '{{query}}' },
    ],
  },
];

// ─── SMART MATCHER ──────────────────────────────────────────────────────────
// Requires a minimum EXACT phrase match — not single-word overlap.
// This prevents "find" from matching "find on amazon" when user said "find me a job".

function matchSkill(goalText) {
  if (!goalText || typeof goalText !== 'string') return null;

  const lower = goalText.toLowerCase().trim();

  // Detect "on [site]" / "in [site]" / "using [site]" patterns.
  // If the user names a specific site, only allow skills for that site.
  // This prevents "search for X on Amazon" from matching google_search.
  const siteOverrideMatch = lower.match(/\b(?:on|in|using|via|at|from)\s+([a-z][a-z0-9]{2,20})\b/);
  const siteOverride = siteOverrideMatch ? siteOverrideMatch[1] : null; // e.g. "amazon", "youtube"

  let bestSkill = null;
  let bestScore = 0;

  for (const skill of skills) {
    // If user named a specific site that isn't this skill's domain, skip
    if (siteOverride && !skill.id.startsWith(siteOverride) && !skill.id.includes(siteOverride)) {
      continue;
    }

    for (const trigger of skill.triggers) {
      const triggerLower = trigger.toLowerCase();
      if (lower.startsWith(triggerLower) || lower.includes(triggerLower)) {
        // Score by phrase length — longer exact phrase = more specific = higher confidence
        const score = triggerLower.split(/\s+/).length;
        if (score > bestScore) {
          bestScore = score;
          bestSkill = skill;
        }
      }
    }
  }

  // Require at least a 2-word trigger match to avoid false positives
  return bestScore >= 2 ? bestSkill : null;
}

// ─── ARG EXTRACTOR ──────────────────────────────────────────────────────────
function extractArgs(skill, goalText) {
  if (!skill || !goalText) return {};
  if (!skill.requiresArgs || skill.requiresArgs.length === 0) return {};

  const args = {};
  if (skill.requiresArgs.includes('query')) {
    // Collect all trigger words to strip
    const triggerWords = new Set();
    for (const trigger of skill.triggers) {
      for (const word of trigger.toLowerCase().split(/\s+/)) {
        if (word.length > 0) triggerWords.add(word);
      }
    }

    let remaining = goalText;
    for (const word of triggerWords) {
      const regex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      remaining = remaining.replace(regex, ' ');
    }

    const query = remaining.replace(/\s+/g, ' ').trim();
    args.query = query.length > 0 ? query : goalText.trim();
  }

  return args;
}

module.exports = { skills, matchSkill, extractArgs };
