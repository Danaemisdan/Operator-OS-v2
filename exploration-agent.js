'use strict';
const http = require('http');

/**
 * EXPLORATION AGENT — ARCHITECTURE.md
 *
 * When Operator visits a site it hasn't mapped before:
 *   Scan pages → Open menus → Inspect forms → Build graph
 *
 * The result is a Site Knowledge Graph stored under the domain.
 * Every future task on this site uses the graph — no blind clicking.
 *
 * Output shape:
 * {
 *   domain: "linkedin.com",
 *   mapped_at: "...",
 *   pages: {
 *     "/jobs": {
 *       purpose: "Job search",
 *       inputs: ["search_keywords", "location"],
 *       actions: ["search", "easy_apply"],
 *       known_flows: { easy_apply: ["click BTN_Easy_Apply", "fill form", "submit"] }
 *     }
 *   },
 *   elements: { "BTN_EasyApply": { purpose: "Opens job application form" } },
 *   flows: { apply_job: [...steps] }
 * }
 */

// ── Element purpose classifier (heuristic, zero LLM) ─────────────────────────
// Given an element from the DOM graph, classify what it does.
function classifyElementPurpose(el) {
  const t   = (el.text || '').toLowerCase().trim();
  const id  = (el.id  || '').toLowerCase();
  const tag = (el.tag || '').toLowerCase();
  const ph  = (el.placeholder || '').toLowerCase();

  if (!t && !ph) return null;

  const combined = t + ' ' + ph;

  // Navigation
  if (['home','feed','discover','explore','notifications','profile','settings','logout','sign out','log out'].some(k => t === k)) {
    return { category: 'navigation', purpose: `Navigates to ${t} section`, confidence: 0.95 };
  }

  // Search inputs
  if (ph.includes('search') || t.includes('search') || ph.includes('find') || id.includes('search')) {
    return { category: 'search_input', purpose: 'Primary search box — type query here', confidence: 0.97 };
  }

  // Apply / CTA buttons
  if (['apply now','easy apply','apply','apply here','quick apply','1-click apply'].includes(t)) {
    return { category: 'apply_button', purpose: 'Opens job application flow', confidence: 0.99 };
  }

  // Submit / confirm
  if (['submit','submit application','send','confirm','done','finish','complete'].includes(t)) {
    return { category: 'submit', purpose: 'Submits or confirms the current form', confidence: 0.98 };
  }

  // Auth
  if (['sign in','log in','login','sign up','create account','join now'].includes(t)) {
    return { category: 'auth', purpose: t.includes('in') || t.includes('log') ? 'Opens login form' : 'Opens signup form', confidence: 0.98 };
  }

  // Filters / sorting
  if (['filter','sort','date posted','experience level','remote','on-site','full-time','part-time','salary'].some(k => combined.includes(k))) {
    return { category: 'filter', purpose: `Filter or sort control: "${t || ph}"`, confidence: 0.92 };
  }

  // Close / dismiss
  if (['close','dismiss','skip','×','✕','not now','maybe later','no thanks'].includes(t)) {
    return { category: 'dismiss', purpose: 'Closes or dismisses a popup/modal', confidence: 0.97 };
  }

  // Form inputs
  if (tag === 'input' || tag === 'textarea') {
    if (ph.includes('name') || ph.includes('email') || ph.includes('phone') || ph.includes('resume') || ph.includes('message')) {
      return { category: 'form_input', purpose: `Form field: "${ph || t}"`, confidence: 0.95 };
    }
    return { category: 'form_input', purpose: `Input field: "${ph || t}"`, confidence: 0.8 };
  }

  // Generic button with text
  if (el.id && el.id.startsWith('BTN') && t.length > 1) {
    return { category: 'action_button', purpose: `Triggers "${t}" action`, confidence: 0.75 };
  }

  // Links with meaningful text
  if (el.id && el.id.startsWith('LNK') && t.length > 1 && t.length < 60) {
    return { category: 'link', purpose: `Navigates to "${t}"`, confidence: 0.75 };
  }

  return null;
}

// ── Detect page purpose from URL + visible elements ──────────────────────────
function classifyPagePurpose(url, title, elements) {
  const u = url.toLowerCase();
  const t = (title || '').toLowerCase();
  const texts = elements.map(e => (e.text || '').toLowerCase()).join(' ');

  if (u.includes('/jobs') || texts.includes('easy apply') || texts.includes('job description')) {
    return 'job_listing_or_search';
  }
  if (u.includes('/messaging') || u.includes('/messages') || texts.includes('compose') || texts.includes('type a message')) {
    return 'messaging';
  }
  if (u.includes('/search') || texts.includes('results for') || texts.includes('filters')) {
    return 'search_results';
  }
  if (u.includes('/feed') || u.includes('/home') || texts.includes('share a post') || texts.includes('start a post')) {
    return 'social_feed';
  }
  if (u.includes('/login') || u.includes('/signin') || u.includes('/signup') || texts.includes('sign in') || texts.includes('create account')) {
    return 'auth';
  }
  if (u.includes('/apply') || texts.includes('submit application') || texts.includes('application submitted')) {
    return 'application_form';
  }
  if (u.includes('/profile') || u.includes('/in/') || texts.includes('connect') || texts.includes('follow')) {
    return 'user_profile';
  }
  if (u.includes('/company') || texts.includes('about') && texts.includes('employees')) {
    return 'company_page';
  }
  if (texts.includes('add to cart') || texts.includes('buy now') || texts.includes('checkout')) {
    return 'ecommerce';
  }
  return 'general';
}

// ── Detect what flows exist on a page ────────────────────────────────────────
function detectFlows(elements) {
  const flows = {};
  const hasPurpose = (cat) => elements.some(e => e._exploration?.category === cat);

  if (hasPurpose('apply_button') && hasPurpose('form_input')) {
    flows.apply_job = ['click apply_button', 'fill form_inputs', 'click submit'];
  }
  if (hasPurpose('search_input')) {
    flows.search = ['type in search_input', 'press_enter or click search button', 'read results'];
  }
  if (hasPurpose('auth')) {
    flows.login = ['click auth button', 'fill email + password', 'submit'];
  }
  if (hasPurpose('filter')) {
    flows.filter_results = ['click filter control', 'select option', 'observe updated results'];
  }
  if (hasPurpose('dismiss')) {
    flows.dismiss_popup = ['click dismiss button'];
  }

  return flows;
}

// ── Main exploration function ────────────────────────────────────────────────
/**
 * Explore a page represented by a DOM graph.
 * Returns enriched graph with element purposes + page knowledge.
 * Pure heuristic — zero LLM calls. Fast.
 */
async function explorePage({ graph, domain }) {
  if (!graph || !graph.elements) return null;

  const url   = graph.url   || '';
  const title = graph.title || '';

  // 1. Classify every interactive element
  const enrichedElements = (graph.elements || []).map(el => {
    const purpose = classifyElementPurpose(el);
    if (purpose) return { ...el, _exploration: purpose };
    return el;
  });

  // 2. Classify the page itself
  const pagePurpose = classifyPagePurpose(url, title, enrichedElements);

  // 3. Detect known flows
  const flows = detectFlows(enrichedElements);

  // 4. Extract structured element groups
  const searchInputs  = enrichedElements.filter(e => e._exploration?.category === 'search_input');
  const applyButtons  = enrichedElements.filter(e => e._exploration?.category === 'apply_button');
  const formInputs    = enrichedElements.filter(e => e._exploration?.category === 'form_input');
  const dismissBtns   = enrichedElements.filter(e => e._exploration?.category === 'dismiss');
  const filterCtrls   = enrichedElements.filter(e => e._exploration?.category === 'filter');
  const authBtns      = enrichedElements.filter(e => e._exploration?.category === 'auth');
  const navLinks      = enrichedElements.filter(e => e._exploration?.category === 'navigation');
  const submitBtns    = enrichedElements.filter(e => e._exploration?.category === 'submit');

  // 5. Build the page knowledge record
  const pageKnowledge = {
    url,
    title,
    purpose: pagePurpose,
    mapped_at: new Date().toISOString(),
    element_counts: {
      total: enrichedElements.length,
      search_inputs: searchInputs.length,
      apply_buttons: applyButtons.length,
      form_inputs:   formInputs.length,
      dismiss_btns:  dismissBtns.length,
      filter_ctrls:  filterCtrls.length,
      auth_buttons:  authBtns.length,
    },
    key_elements: {
      search_inputs:  searchInputs.map(e  => ({ id: e.id, text: e.text, placeholder: e.placeholder })),
      apply_buttons:  applyButtons.map(e  => ({ id: e.id, text: e.text })),
      dismiss_buttons:dismissBtns.map(e   => ({ id: e.id, text: e.text })),
      form_inputs:    formInputs.map(e    => ({ id: e.id, placeholder: e.placeholder, text: e.text })),
      submit_buttons: submitBtns.map(e    => ({ id: e.id, text: e.text })),
      auth_buttons:   authBtns.map(e      => ({ id: e.id, text: e.text })),
      filters:        filterCtrls.map(e   => ({ id: e.id, text: e.text })),
    },
    flows,
    blockers: {
      has_login_wall:    authBtns.length > 0 && (url.includes('login') || url.includes('signin')),
      has_cookie_banner: dismissBtns.some(e => (e.text || '').toLowerCase().includes('accept') || (e.text || '').toLowerCase().includes('cookie')),
      has_popup:         dismissBtns.length > 0,
    },
  };

  return {
    pageKnowledge,
    enrichedElements,
    domain: domain || new URL(url.startsWith('http') ? url : 'https://' + url).hostname,
  };
}

// ── Behavioral Learning: record what happened after each action ───────────────
/**
 * Called after every action in the executor.
 * Records: element → what happened → what appeared.
 * Builds up: "on linkedin.com, BTN Easy Apply always opens application modal"
 */
function buildBehaviorRecord({ domain, url, elementId, elementText, elementCategory, action, resultUrl, resultPagePurpose, resultElementsAppeared }) {
  return {
    domain,
    url_pattern: url.replace(/\/\d+\/?/g, '/:id/').replace(/[?#].*$/, ''), // normalize IDs and query strings
    element: { id: elementId, text: elementText, category: elementCategory },
    action,
    result: {
      url_changed:      resultUrl !== url,
      result_url:       resultUrl,
      result_purpose:   resultPagePurpose,
      appeared:         resultElementsAppeared.slice(0, 8).map(e => ({ id: e.id, text: e.text, category: e._exploration?.category })),
    },
    recorded_at: new Date().toISOString(),
  };
}

module.exports = { explorePage, classifyElementPurpose, classifyPagePurpose, detectFlows, buildBehaviorRecord };
