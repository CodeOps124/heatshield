/**
 * Operator controls. The admin console writes them; every function reads them (cached for 30 s).
 *   state#admin/settings  { paused: {agent: bool}, aiPaused, budgetUsd, notice }   owned by the operator
 *   state#admin/budget    { day, spentUsd, budgetUsd, tripped, ... }               owned by Otto (every 15 min)
 * Two safety rules are built in: the Dispatcher (heat alerts) cannot be paused, and pausing the AI
 * never stops alerts — they go out with cached or pre-written advice.
 */
import { cleanText } from './util.mjs';

export const PAUSABLE = Object.freeze(['sol', 'mira', 'kai', 'otto', 'quinn', 'iris']);
export const NOTICE_LEVELS = Object.freeze(['info', 'warning', 'danger']);
export const DEFAULT_BUDGET_USD = 5;
export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Validates whatever is stored (or sent by the admin console) into a complete, safe settings object. */
export function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const paused = Object.fromEntries(PAUSABLE.map((id) => [id, Boolean(s.paused?.[id])]));
  const budget = Number(s.budgetUsd);
  const budgetUsd = Number.isFinite(budget) ? Math.min(100, Math.max(0.5, Math.round(budget * 100) / 100)) : DEFAULT_BUDGET_USD;
  let notice = null;
  // Tags are removed whole (the notice is shown as plain text either way).
  const text = typeof s.notice?.text === 'string' ? cleanText(s.notice.text.replace(/<[^>]*>/g, ''), 280) : '';
  if (text) {
    const until = s.notice.until && !Number.isNaN(Date.parse(s.notice.until)) ? new Date(s.notice.until).toISOString() : null;
    notice = { text, level: NOTICE_LEVELS.includes(s.notice.level) ? s.notice.level : 'info', until };
  }
  return { paused, aiPaused: Boolean(s.aiPaused), budgetUsd, notice };
}

export function createControl({ agentLog, nowMs = () => Date.now(), ttlMs = 30_000 }) {
  let cache = null;

  async function load() {
    if (cache && nowMs() - cache.at < ttlMs) return cache.value;
    const [settings, budget] = await Promise.all([
      agentLog.getState('admin', 'settings').catch(() => null),
      agentLog.getState('admin', 'budget').catch(() => null),
    ]);
    const value = { settings: normalizeSettings(settings), budget: budget ?? null };
    cache = { at: nowMs(), value };
    return value;
  }

  // Otto's automatic brake only holds for the UTC day it tripped on.
  const budgetTripped = (budget) => Boolean(budget?.tripped && budget.day === utcDay(nowMs()));

  return {
    load,
    invalidate() { cache = null; },
    budgetTripped,
    async isPaused(agent) {
      return Boolean((await load()).settings.paused[agent]);
    },
    /** May `agent` call a model for new work right now? */
    async generation(agent) {
      const { settings, budget } = await load();
      if (settings.paused[agent]) return { ok: false, reason: 'paused' };
      if (settings.aiPaused) return { ok: false, reason: 'ai_paused' };
      if (budgetTripped(budget)) return { ok: false, reason: 'budget_paused' };
      return { ok: true };
    },
    /** The site-wide notice, if one is set and not expired. */
    async notice() {
      const { notice } = (await load()).settings;
      if (!notice || (notice.until && Date.parse(notice.until) < nowMs())) return null;
      return notice;
    },
  };
}

/**
 * Runs `work` unless the operator paused this agent. A skipped run is still recorded, so Agent HQ
 * shows "paused" and Otto does not mistake a paused agent for a dead one. The admin console's
 * "Run now" (trigger "admin") overrides a pause.
 */
export async function runUnlessPaused({ control, agentLog, agent, trigger, work }) {
  if (trigger !== 'admin' && await control.isPaused(agent)) {
    const run = { outcome: 'paused', summary: 'Paused by the operator; this run was skipped.' };
    await agentLog.recordRun(agent, { trigger, ...run }).catch(() => {});
    return run;
  }
  return work();
}
