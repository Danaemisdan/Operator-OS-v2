'use strict';

const { webContents } = require('electron');

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Replace {{key}} placeholders in a string with args values.
 * URL fields get encodeURIComponent, everything else is raw.
 */
function interpolate(str, args, isUrl = false) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!Object.prototype.hasOwnProperty.call(args, key)) return '';
    return isUrl ? encodeURIComponent(args[key]) : args[key];
  });
}

function interpolateStep(step, args) {
  const out = {};
  for (const [k, v] of Object.entries(step)) {
    if (typeof v === 'string') {
      out[k] = interpolate(v, args, k === 'url');
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Evaluate a skipIf or runIf condition against live page state.
 *
 * @param {object} condition  — the condition descriptor from the skill step
 * @param {object} pageState  — { url, pageType }
 * @returns {boolean}         — true if the condition is MET
 */
function evalCondition(condition, pageState) {
  if (!condition) return false;
  const { url = '', pageType = '' } = pageState;

  if (condition.alreadyOnDomain) {
    try {
      const host = new URL(url).hostname.replace('www.', '');
      const target = condition.alreadyOnDomain.replace('www.', '');
      if (host.includes(target) || target.includes(host)) return true;
    } catch (_) {}
  }

  if (condition.urlContains) {
    if (url.includes(condition.urlContains)) return true;
  }

  if (condition.pageType) {
    if (pageType.toLowerCase().includes(condition.pageType.toLowerCase())) return true;
  }

  return false;
}

/**
 * Execute a skill step by step.
 *
 * @param {object}   skill
 * @param {object}   args           — e.g. { query: 'cats' }
 * @param {number}   webContentsId
 * @param {Function} executeAction  — async (action, payload) => any
 * @param {Function} sendToRenderer — (channel, data) => void
 * @param {Function} getPageState   — async () => { url, pageType }
 */
async function executeSkill(skill, args, webContentsId, executeAction, sendToRenderer, getPageState) {
  const wc = webContents.fromId(webContentsId);
  if (!wc) {
    sendToRenderer?.('skill-error', { skillId: skill.id, error: `No webContents for id=${webContentsId}` });
    return { success: false, error: 'No webContents' };
  }

  const results = [];
  console.log(`[SkillExecutor] Running "${skill.id}" with args:`, args);

  for (let i = 0; i < skill.steps.length; i++) {
    const raw = skill.steps[i];
    const step = interpolateStep(raw, args);

    // ── Resolve live page state for conditions ──────────────────────────
    const pageState = getPageState ? await getPageState() : { url: wc.getURL?.() || '', pageType: '' };

    // ── skipIf: skip this step if condition is MET ──────────────────────
    if (step.skipIf && evalCondition(step.skipIf, pageState)) {
      console.log(`[SkillExecutor] Step ${i + 1} SKIPPED (skipIf met):`, step.action);
      results.push({ step: i, action: step.action, status: 'skipped' });
      continue;
    }

    // ── runIf: only run this step if condition is MET ───────────────────
    if (step.runIf && !evalCondition(step.runIf, pageState)) {
      console.log(`[SkillExecutor] Step ${i + 1} SKIPPED (runIf not met):`, step.action);
      results.push({ step: i, action: step.action, status: 'condition_not_met' });
      continue;
    }

    console.log(`[SkillExecutor] Step ${i + 1}/${skill.steps.length}: ${step.action}`, step.url || step.text || step.question || '');

    try {
      switch (step.action) {

        case 'navigate': {
          if (!step.url) throw new Error('navigate step missing url');
          // Validate URL before loading
          new URL(step.url); // throws if invalid
          await wc.loadURL(step.url);
          // Wait for page to stop loading
          await new Promise((resolve) => {
            const timeout = setTimeout(resolve, 8000);
            wc.once('did-stop-loading', () => { clearTimeout(timeout); resolve(); });
          });
          results.push({ step: i, action: 'navigate', url: step.url, status: 'ok' });
          break;
        }

        case 'wait': {
          await delay(typeof step.ms === 'number' ? step.ms : 1000);
          results.push({ step: i, action: 'wait', status: 'ok' });
          break;
        }

        case 'type': {
          await executeAction('type', { targetHint: step.targetHint || '', text: step.text || '', webContentsId });
          results.push({ step: i, action: 'type', status: 'ok' });
          break;
        }

        case 'click': {
          await executeAction('click', { targetHint: step.targetHint || '', webContentsId });
          results.push({ step: i, action: 'click', status: 'ok' });
          break;
        }

        case 'verify': {
          await delay(800);
          results.push({ step: i, action: 'verify', verified: !wc.isDestroyed(), status: 'ok' });
          break;
        }

        case 'research': {
          const query = step.query || args.query || '';
          sendToRenderer?.('agent-research-needed', { query, skillId: skill.id });
          results.push({ step: i, action: 'research', query, status: 'dispatched' });
          break;
        }

        case 'ask_user': {
          // Signal renderer to pause and prompt the user
          sendToRenderer?.('skill-ask-user', { question: step.question || 'I need your help to continue.', skillId: skill.id });
          // Wait for renderer to reply via 'skill-user-reply' — handled in main.js
          results.push({ step: i, action: 'ask_user', status: 'prompted' });
          break;
        }

        default: {
          console.warn(`[SkillExecutor] Unknown action: "${step.action}" — skipping`);
          results.push({ step: i, action: step.action, status: 'unknown' });
        }
      }
    } catch (err) {
      const msg = err?.message || String(err);
      console.error(`[SkillExecutor] Step ${i + 1} failed:`, msg);
      sendToRenderer?.('skill-step-error', { skillId: skill.id, stepIndex: i, action: step.action, error: msg });
      results.push({ step: i, action: step.action, status: 'error', error: msg });
      return { success: false, steps: results, error: msg };
    }
  }

  sendToRenderer?.('skill-complete', { skillId: skill.id, steps: results });
  return { success: true, steps: results };
}

module.exports = { executeSkill, interpolate };
