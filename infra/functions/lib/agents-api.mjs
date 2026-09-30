/**
 * GET /api/agents — the public, read-only view of the agents at work (feeds Agent HQ).
 * No personal data: places are city-level, groups appear only as counts, member names never.
 */
import { ROSTER, WORKERS, nextRunAt } from './agents/roster.mjs';

const WORKING_WINDOW_MS = 90_000;
const CACHE_MS = 10_000;
const round1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

// Run details are written by the agents without personal data (places are cities, plans reference
// pseudonymous ids, reviews quote generated text), so they are safe to show on the public console.
const runView = ({ at, trigger, outcome, durationMs, model, summary, inputTokens, outputTokens, toolCalls, detail }) => ({
  at, trigger, outcome, durationMs, model, summary,
  tokens: (inputTokens ?? 0) + (outputTokens ?? 0),
  tools: (toolCalls ?? []).map((t) => t.name),
  detail: detail ?? null,
});

export function createAgentsApi({ agentLog, control = null, nowMs = () => Date.now() }) {
  let cached = null;

  async function build() {
    const now = nowMs();
    const dayAgo = now - 86_400_000;
    const everyone = [...ROSTER, ...WORKERS];
    const runs = Object.fromEntries(await Promise.all(everyone.map(async (a) => [a.id, await agentLog.listRuns(a.id, a.id === 'otto' ? 100 : 40)])));
    const [sentinel, watchdog, ctl, audit, coach] = await Promise.all([
      agentLog.getState('sol', 'latest'), agentLog.getState('otto', 'latest'), control ? control.load() : null,
      agentLog.getState('quinn', 'latest'), agentLog.getState('iris', 'latest'),
    ]);
    // A few entries of each non-empty word list (vocabulary only; nothing personal).
    const wordLists = Object.fromEntries(await Promise.all(Object.keys(coach?.sizes ?? {}).map(async (lang) => {
      const g = await agentLog.getState('iris', `glossary#${lang}`).catch(() => null);
      return [lang, (g?.entries ?? []).slice(0, 3).map(({ wrong, use, meaning }) => ({ wrong, use, meaning }))];
    })));
    const paused = ctl?.settings.paused ?? {};
    const aiPaused = Boolean(ctl && (ctl.settings.aiPaused || control.budgetTripped(ctl.budget)));

    const status = (id) => {
      if (paused[id]) return 'paused';
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
      // Operator state, without the budget figures (those stay in the admin console).
      control: { paused: Object.keys(paused).filter((k) => paused[k]), aiPaused },
      agents: ROSTER.map(summarize),
      workers: WORKERS.map(summarize),
      // City-level only: no head counts, coordinates rounded to ~11 km.
      sentinel: sentinel
        ? {
            generatedAt: sentinel.updatedAt,
            briefedAt: sentinel.briefedAt ?? null,
            briefing: sentinel.briefing,
            areasScanned: sentinel.areasScanned,
            events: (sentinel.events ?? []).map(({ place, level, trend, headline, reason, ehfWorst, lat, lon, stale, chance, chanceOf, confidence }) => ({ place, level, trend, headline, reason, ehfWorst, lat: round1(lat), lon: round1(lon), stale: Boolean(stale), chance: chance ?? null, chanceOf: chanceOf ?? null, confidence: confidence ?? null })),
            areas: (sentinel.areas ?? []).map(({ place, ceiling, ehfWorst, worstTier, lat, lon, climatePending, stale, asOf, chanceOfDanger }) => ({ place, ceiling, ehfWorst, worstTier, lat: round1(lat), lon: round1(lon), climatePending: Boolean(climatePending), stale: Boolean(stale), asOf: asOf ?? null, chanceOfDanger: chanceOfDanger ?? null })),
          }
        : null,
      watchdog: watchdog
        ? {
            checkedAt: watchdog.updatedAt,
            status: watchdog.status,
            probes: watchdog.probes,
            heartbeats: watchdog.heartbeats,
            issues: watchdog.issues,
            uptime: watchdog.uptime ?? null,
            remediations: watchdog.remediations ?? [],
            incident: watchdog.incident ? { title: watchdog.incident.title, severity: watchdog.incident.severity, summary: watchdog.incident.summary, likelyCause: watchdog.incident.likelyCause, recommendedAction: watchdog.incident.recommendedAction, at: watchdog.incident.updatedAt } : null,
          }
        : null,
      auditor: audit
        ? {
            generatedAt: audit.generatedAt, windowDays: audit.windowDays, reference: audit.reference, note: audit.note, noteBy: audit.noteBy,
            overall: audit.overall, cities: (audit.cities ?? []).map(({ place, lead1, lead3, danger }) => ({ place, lead1, lead3, danger })),
          }
        : null,
      coach: coach ? { generatedAt: coach.generatedAt, reviewed: coach.reviewed, added: coach.added, rejected: coach.rejected, sizes: coach.sizes, samples: wordLists } : null,
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
