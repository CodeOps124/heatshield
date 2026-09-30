/**
 * Admin console API (/api/admin/*). API Gateway's JWT authorizer has already verified the Amazon
 * Cognito token's signature, expiry, issuer and audience; this code additionally requires an ID
 * token of a member of the "admins" group, and records every change in an audit log (90 days).
 *   GET    /api/admin/overview              status, spend, quality, alarms, agents, audit
 *   PUT    /api/admin/settings              pauses, AI pause, daily budget, site notice
 *   POST   /api/admin/agents/{agentId}/run  run an agent now (overrides a pause)
 *   GET    /api/admin/plans                 recent plans and their outcomes
 *   DELETE /api/admin/plans/{cacheKey}      recall a cached plan (the next request writes a new one)
 *   GET    /api/admin/failed-runs           scheduled runs in the dead-letter queue
 *   DELETE /api/admin/failed-runs           clear the dead-letter queue
 */
import { HttpError, json, parseBody, router } from './http.mjs';
import { normalizeSettings, utcDay, PAUSABLE } from './control.mjs';
import { runCost, SPEND_SOURCES } from './spend.mjs';

export const RUNNABLE = Object.freeze(['sol', 'kai', 'otto', 'dispatch', 'quinn', 'iris']);
const AUDIT_TTL_DAYS = 90;

/** "cognito:groups" arrives as a JSON array, a "[a b]" string, or a plain string depending on the path. */
export function groupsOf(claims) {
  const raw = claims?.['cognito:groups'];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== 'string') return [];
  const s = raw.trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    try { return JSON.parse(s).map(String); } catch { return s.slice(1, -1).split(/[\s,]+/).filter(Boolean); }
  }
  return s ? [s] : [];
}

export function requireAdmin(event) {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  if (!claims) throw new HttpError(401, 'unauthorized', 'Sign in to the admin console first.');
  if (claims.token_use !== 'id') throw new HttpError(401, 'unauthorized', 'Send the ID token from the admin sign-in.');
  if (!groupsOf(claims).includes('admins')) throw new HttpError(403, 'forbidden', 'This account is not a HeatShield administrator.');
  return { email: claims.email ?? claims['cognito:username'] ?? claims.sub, sub: claims.sub };
}

export function createAdminApi({ agentLog, control, cache, agentsApi, invokeAgent, failedRuns, alarms, nowMs = () => Date.now() }) {
  const audit = (actor, action, detail) => agentLog.recordRun('admin', {
    trigger: 'admin', outcome: action, actor: actor.email, summary: `${actor.email}: ${action}`, detail,
  }, { ttlDays: AUDIT_TTL_DAYS });

  /** AI spend per UTC day for the last 7 days, from the agent log. */
  async function spendByDay() {
    const days = Array.from({ length: 7 }, (_, i) => utcDay(nowMs() - (6 - i) * 86_400_000));
    const totals = Object.fromEntries(days.map((d) => [d, 0]));
    const lists = await Promise.all(SPEND_SOURCES.map((a) => agentLog.listRunsSince(a, `${days[0]}T00:00:00.000Z`)));
    for (const r of lists.flat()) {
      const usd = runCost(r);
      if (usd && Object.hasOwn(totals, r.at.slice(0, 10))) totals[r.at.slice(0, 10)] += usd;
    }
    return days.map((day) => ({ day, usd: Math.round(totals[day] * 10_000) / 10_000 }));
  }

  /** What happened to the plans people asked for: published by the AI, or pre-written advice (and why). */
  async function quality() {
    const plans = await agentLog.listRunsSince('plans', new Date(nowMs() - 7 * 86_400_000).toISOString());
    const dayAgo = nowMs() - 86_400_000;
    const tally = (list) => {
      const out = { total: list.length, published: 0, fallback: 0, unreviewed: 0, byLanguage: {}, reasons: {} };
      for (const p of list) {
        out[p.outcome] = (out[p.outcome] ?? 0) + 1;
        const lang = p.detail?.language ?? '?';
        const l = out.byLanguage[lang] ?? { total: 0, published: 0 };
        l.total += 1;
        if (p.outcome === 'published') l.published += 1;
        out.byLanguage[lang] = l;
        if (p.outcome === 'fallback') out.reasons[p.detail?.reason ?? 'unknown'] = (out.reasons[p.detail?.reason ?? 'unknown'] ?? 0) + 1;
      }
      return out;
    };
    return { last24h: tally(plans.filter((p) => Date.parse(p.at) > dayAgo)), last7d: tally(plans) };
  }

  const routes = {
    'GET /api/admin/overview': async (event, me) => {
      const [ctl, watchdog, agents, spend7d, q, alarmStates, failed, auditLog] = await Promise.all([
        control.load(),
        agentLog.getState('otto', 'latest'),
        agentsApi.get(),
        spendByDay(),
        quality(),
        alarms ? alarms().catch(() => null) : null,
        failedRuns ? failedRuns.count().catch(() => null) : null,
        agentLog.listRuns('admin', 30),
      ]);
      const budget = ctl.budget && ctl.budget.day === utcDay(nowMs()) ? ctl.budget : { day: utcDay(nowMs()), spentUsd: 0, tripped: false, byAgent: {}, byModel: {} };
      return json(200, {
        me,
        settings: ctl.settings,
        budget: { ...budget, budgetUsd: ctl.settings.budgetUsd },
        spend7d,
        quality: q,
        watchdog: watchdog ? { status: watchdog.status, checkedAt: watchdog.updatedAt, issues: watchdog.issues, uptime: watchdog.uptime ?? null, incident: watchdog.incident ?? null, remediations: watchdog.remediations ?? [] } : null,
        alarms: alarmStates,
        failedRuns: failed,
        agents: [...agents.agents, ...agents.workers].map((a) => ({
          id: a.id, name: a.name, role: a.role, status: a.status, lastRun: a.lastRun, nextRunAt: a.nextRunAt, runs24h: a.runs24h,
          pausable: PAUSABLE.includes(a.id), runnable: RUNNABLE.includes(a.id),
        })),
        audit: auditLog.map((r) => ({ at: r.at, actor: r.actor, action: r.outcome, detail: r.detail ?? null })),
      });
    },

    'PUT /api/admin/settings': async (event, me) => {
      const body = parseBody(event);
      const current = (await control.load()).settings;
      const next = normalizeSettings({
        ...current,
        ...(body.paused ? { paused: { ...current.paused, ...body.paused } } : {}),
        ...(typeof body.aiPaused === 'boolean' ? { aiPaused: body.aiPaused } : {}),
        ...(body.budgetUsd !== undefined ? { budgetUsd: body.budgetUsd } : {}),
        ...(body.notice !== undefined ? { notice: body.notice } : {}),
      });
      await agentLog.putState('admin', 'settings', next);
      // Raising the budget above today's spend releases Otto's brake at once, not at his next check.
      const budget = await agentLog.getState('admin', 'budget').catch(() => null);
      if (budget?.tripped && budget.day === utcDay(nowMs()) && next.budgetUsd > budget.spentUsd) {
        await agentLog.putState('admin', 'budget', { ...budget, budgetUsd: next.budgetUsd, tripped: false, trippedAt: null });
      }
      control.invalidate();
      const changed = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(current[k]));
      if (changed.length) await audit(me, `settings: ${changed.join(', ')}`, Object.fromEntries(changed.map((k) => [k, next[k]])));
      return json(200, { settings: next });
    },

    'POST /api/admin/agents/{agentId}/run': async (event, me) => {
      const agentId = event.pathParameters?.agentId;
      if (!RUNNABLE.includes(agentId)) throw new HttpError(404, 'not_found', 'No such agent.');
      await audit(me, `ran ${agentId}`, null);
      if (agentId === 'dispatch') {
        // The alert run can take minutes: started in the background.
        await invokeAgent(agentId, { trigger: 'admin' }, { wait: false });
        return json(202, { agent: agentId, started: true });
      }
      const result = await invokeAgent(agentId, { trigger: 'admin', budgetMs: 22_000 }, { wait: true });
      return json(200, { agent: agentId, result });
    },

    'GET /api/admin/plans': async () => {
      const plans = await agentLog.listRuns('plans', 50);
      return json(200, {
        plans: plans.map((p) => ({
          at: p.at, outcome: p.outcome, language: p.detail?.language, profile: p.detail?.profile, tier: p.detail?.tier,
          reason: p.detail?.reason ?? null, revisions: p.detail?.revisions ?? 0, cacheKey: p.detail?.cacheKey ?? null,
          headline: p.detail?.headline ?? null, model: p.detail?.model ?? null,
        })),
      });
    },

    'DELETE /api/admin/plans/{cacheKey}': async (event, me) => {
      const key = event.pathParameters?.cacheKey ?? '';
      if (!/^[0-9a-f]{64}$/.test(key)) throw new HttpError(400, 'invalid_input', 'Not a plan key.');
      const hit = await cache.get(key);
      if (!hit) throw new HttpError(404, 'not_found', 'That plan is no longer cached.');
      await cache.delete(key);
      await audit(me, 'recalled a plan', { cacheKey: key, headline: hit.guidance?.headline ?? null });
      return json(200, { recalled: true });
    },

    'GET /api/admin/failed-runs': async () => json(200, { runs: failedRuns ? await failedRuns.peek(10) : [] }),

    'DELETE /api/admin/failed-runs': async (event, me) => {
      if (failedRuns) await failedRuns.purge();
      await audit(me, 'cleared the failed-runs queue', null);
      return json(200, { cleared: true });
    },
  };

  // Every route requires an administrator; the identity is passed to the handler for the audit log.
  return router(Object.fromEntries(Object.entries(routes).map(([key, fn]) => [key, (event) => fn(event, requireAdmin(event))])));
}
