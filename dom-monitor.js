/**
 * DOM MONITOR — injected into every webview via <script> tag
 * Watches for: notifications, new messages, badge counts, dynamic DOM changes
 * Sends structured events to renderer via ipcRenderer.sendToHost()
 *
 * This is a pure browser-context script (no Node.js APIs).
 */
(function() {
  'use strict';

  if (window.__operatorMonitorActive) return;
  window.__operatorMonitorActive = true;

  // ── Helpers ───────────────────────────────────────────────────────────────

  function sendEvent(type, payload) {
    try {
      window.ipcRenderer && window.ipcRenderer.sendToHost('dom-event', JSON.stringify({ type, payload, url: location.href, ts: Date.now() }));
    } catch (_) {}
  }

  function extractText(el) {
    return (el ? el.innerText || el.textContent || '' : '').replace(/\s+/g, ' ').trim().substring(0, 300);
  }

  function matchesAny(el, patterns) {
    if (!el) return false;
    const str = [el.className, el.getAttribute('aria-label'), el.getAttribute('data-testid'), el.id, extractText(el)].join(' ').toLowerCase();
    return patterns.some(p => str.includes(p));
  }

  // ── Notification / badge detector ────────────────────────────────────────

  const BADGE_PATTERNS = ['notification', 'badge', 'unread', 'count', 'indicator', 'alert', 'bell', 'dot'];
  const MESSAGE_PATTERNS = ['message', 'chat', 'conversation', 'inbox', 'msg', 'dm'];
  const TOAST_PATTERNS  = ['toast', 'snackbar', 'alert', 'banner', 'notice', 'popup'];

  function classifyChange(el) {
    if (!el || !el.tagName) return null;
    const text = extractText(el);
    if (!text && !el.getAttribute('aria-label')) return null;

    if (matchesAny(el, TOAST_PATTERNS)) return { kind: 'toast', text };
    if (matchesAny(el, BADGE_PATTERNS)) {
      const num = parseInt(text, 10);
      return { kind: 'badge', count: isNaN(num) ? null : num, text };
    }
    if (matchesAny(el, MESSAGE_PATTERNS)) return { kind: 'new_message', text };
    // Text-based: "You have X new messages" etc.
    if (/you have \d+ new|new message|new notification|\d+ unread/i.test(text)) {
      return { kind: 'notification_text', text };
    }
    return null;
  }

  // ── MutationObserver — watch entire document for added nodes ─────────────

  let debounceTimer = null;
  const pendingChanges = [];

  const observer = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== 1) continue; // elements only
        const classified = classifyChange(node);
        if (classified) pendingChanges.push(classified);
        // Also check children
        const children = node.querySelectorAll ? node.querySelectorAll('*') : [];
        for (const child of children) {
          const cc = classifyChange(child);
          if (cc) pendingChanges.push(cc);
        }
      }
      // Watch text changes too (badge count going from 0 to 5)
      if (mut.type === 'characterData' && mut.target.parentElement) {
        const cc = classifyChange(mut.target.parentElement);
        if (cc) pendingChanges.push(cc);
      }
    }

    if (pendingChanges.length === 0) return;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      // De-duplicate by kind+text
      const seen = new Set();
      const unique = pendingChanges.filter(c => {
        const key = `${c.kind}:${c.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      pendingChanges.length = 0;

      for (const change of unique.slice(0, 5)) {
        sendEvent('dom_change', change);
      }
    }, 800);
  });

  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: false,
  });

  // ── Page-level snapshot on load ──────────────────────────────────────────
  // Sends a summary of what's on the page right now (notification counts etc.)

  function snapshotPage() {
    const summary = {
      title: document.title,
      url: location.href,
      notifications: [],
      messageThreads: [],
    };

    // Find all badge-like elements
    document.querySelectorAll('[aria-label*="notification"],[aria-label*="message"],[class*="badge"],[class*="unread"],[class*="count"]').forEach(el => {
      const text = extractText(el);
      if (text && text.length < 30) {
        summary.notifications.push({ text, label: el.getAttribute('aria-label') || '' });
      }
    });

    // Message threads (LinkedIn, Gmail-style)
    document.querySelectorAll('[data-testid*="message"],[class*="conversation"],[class*="thread"],[class*="message-item"]').forEach(el => {
      const text = extractText(el);
      if (text && text.length > 5 && text.length < 200) {
        summary.messageThreads.push(text.substring(0, 100));
      }
    });

    if (summary.notifications.length > 0 || summary.messageThreads.length > 0) {
      sendEvent('page_snapshot', summary);
    }
  }

  if (document.readyState === 'complete') snapshotPage();
  else window.addEventListener('load', snapshotPage, { once: true });

  // ── Periodic heartbeat with scroll position + page state ─────────────────
  // Every 5 seconds, send a lightweight heartbeat so the agent stays aware
  let heartbeatInterval = setInterval(() => {
    sendEvent('heartbeat', {
      url: location.href,
      title: document.title,
      scrollY: window.scrollY,
      scrollMax: document.body ? document.body.scrollHeight : 0,
    });
  }, 5000);

  // Clean up on navigate
  window.addEventListener('beforeunload', () => {
    clearInterval(heartbeatInterval);
    observer.disconnect();
    window.__operatorMonitorActive = false;
  });

})();
