/**
 * GET /api/agents — the public, read-only view of the agents at work (feeds Agent HQ).
 * No personal data: places are city-level, groups appear only as counts, member names never.
 */
import { ROSTER, WORKERS, nextRunAt } from './agents/roster.mjs';

const WORKING_WINDOW_MS = 90_000;
const CACHE_MS = 10_000;
const round1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

const runView = ({ at, trigger, outcome, durationMs, model, summary, inputTokens, outputTokens, toolCalls }) => ({
  at, trigger, outcome, durationMs, model, summary,
  tokens: (inputTokens ?? 0) + (outputTokens ?? 0),
  tools: (toolCalls ?? []).map((t) => t.name),
});

export function createAgentsApi({ agentLog, nowMs = () => Date.now() }) {
  let cached = null;

  async function build() {
    const now = nowMs();
    const dayAgo = now - 86_400_000;
    const everyone = [...ROSTER, ...WORKERS];
    const runs = Object.fromEntries(await Promise.all(everyone.map(async (a) => [a.id, await agentLog.listRuns(a.id, a.id === 'otto' ? 100 : 40)])));
    const [sentinel, watchdog] = await Promise.all([agentLog.getState('sol', 'latest'), agentLog.getState('otto', 'latest')]);

    const status = (id) => {
      const [last] = runs[id];
      if (!last) return 'waiting';
      if (last.outcome === 'error') return 'error';
      return now - Date.parse(last.at) < WORKING_WINDOW_MS ? 'working' : 'idle';
    };
    const summarize = (a) => {
      const recent = runs[a.id];
      const today = recent.filter((r) => Date.parse(r.at) > dayAgo);
      return {
        ...a,
        status: status(a.id),
        lastRun: recent[0] ? runView(recent[0]) : null,
        nextRunAt: nextRunAt(a.schedule, now),
        runs24h: today.length,
        tokens24h: today.reduce((s, r) => s + (r.inputTokens ?? 0) + (r.outputTokens ?? 0), 0),
        recent: recent.slice(0, 6).map(runView),
      };
    };

    const reviews = [...runs.lexi, ...runs.vera]
      .filter((r) => r.detail?.verdict)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 8)
      .map((r) => ({
        agent: r.agent, at: r.at, language: r.detail.language, verdict: r.detail.verdict, method: r.detail.method,
        issues: (r.detail.issues ?? []).slice(0, 3), backTranslationHeadline: r.detail.backTranslationHeadline ?? null,
      }));
    const reviewed = [...runs.lexi, ...runs.vera].filter((r) => r.detail?.verdict && Date.parse(r.at) > dayAgo);

    return {
      generatedAt: new Date(now).toISOString(),
      agents: ROSTER.map(summarize),
      workers: WORKERS.map(summarize),
      // City-level only: no head counts, coordinates rounded to ~11 km.
      sentinel: sentinel
        ? {
            generatedAt: sentinel.updatedAt,
            briefing: sentinel.briefing,
            areasScanned: sentinel.areasScanned,
            events: (sentinel.events ?? []).map(({ place, level, trend, headline, reason, ehfWorst, lat, lon }) => ({ place, level, trend, headline, reason, ehfWorst, lat: round1(lat), lon: round1(lon) })),
            areas: (sentinel.areas ?? []).map(({ place, ceiling, ehfWorst, worstTier, lat, lon, climatePending }) => ({ place, ceiling, ehfWorst, worstTier, lat: round1(lat), lon: round1(lon), climatePending: Boolean(climatePending) })),
          }
        : null,
      watchdog: watchdog
        ? {
            checkedAt: watchdog.updatedAt,
            status: watchdog.status,
            probes: watchdog.probes,
            heartbeats: watchdog.heartbeats,
            issues: watchdog.issues,
            incident: watchdog.incident ? { title: watchdog.incident.title, severity: watchdog.incident.severity, summary: watchdog.incident.summary, likelyCause: watchdog.incident.likelyCause, recommendedAction: watchdog.incident.recommendedAction, at: watchdog.incident.updatedAt } : null,
          }
        : null,
      reviews,
      reviewStats24h: {
        total: reviewed.length,
        approved: reviewed.filter((r) => r.detail.verdict === 'approve').length,
        sentBack: reviewed.filter((r) => r.detail.verdict === 'revise').length,
      },
    };
  }

  return {
    async get() {
      if (cached && nowMs() - cached.at < CACHE_MS) return cached.value;
      const value = await build();
      cached = { at: nowMs(), value };
      return value;
    },
  };
}
