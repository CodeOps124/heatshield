/**
 * OTTO — Ops Watchdog agent (every 15 minutes). Guards the hackathon's pass/fail ship gate.
 * Expertise encoded: site reliability engineering.
 * Algorithms:
 *   - synthetic probes of the PUBLIC URL (what judges hit), not the raw API
 *   - EWMA control chart per probe (mean + 3σ, persisted between runs) to flag abnormal latency
 *   - heartbeat checks: each scheduled agent must have run within 2× its interval
 *   - CloudWatch Logs error / timeout / primary-model-failure counts
 * Deterministic triage decides healthy / degraded / down. Only when something is wrong AND new
 * (fingerprint changed, or >6 h since the last write-up) does the model investigate with tools
 * and write an incident report, which is published to the Ops SNS topic.
 * Operations duties (runbook, not improvisation):
 *   - measures today's AI spend from the agent log and trips the budget brake at the operator's limit
 *   - re-runs a scheduled agent that missed its slot (once per agent per 2 h; never a paused one)
 *   - reports scheduled runs that failed twice (the dead-letter queue)
 *   - keeps per-day availability from his own checks (the public uptime figure)
 */
import { createHash } from 'node:crypto';
import { runAgent, extractJson } from '../agent-runtime.mjs';
import { ewmaUpdate, ewmaAnomaly } from '../algorithms/stats.mjs';
import { measureSpend } from '../spend.mjs';
import { utcDay } from '../control.mjs';

// `floor`: excess latency (ms) below which a control-chart signal is ignored. Probes that run
// through Lambda + Open-Meteo see normal cold starts of 1-2 s; the first live incident (a 2.6 s
// risk probe, 06:00 UTC 2026-09-29) was exactly that, so their floors are higher.
export const PROBES = [
  { id: 'site', path: '/', floor: 800, check: (status, body) => status === 200 && body.includes('HeatShield') },
  { id: 'health', path: '/api/health', floor: 1500, check: (status, body) => status === 200 && body.includes('"ok":true') },
  { id: 'risk', path: '/api/risk?lat=25.2&lon=55.27&profile=general', floor: 2500, check: (status, body) => status === 200 && body.includes('"risk"') },
  { id: 'agents', path: '/api/agents', floor: 2500, check: (status, body) => status === 200 && body.includes('"agents"') },
  // Dependency probe: the weather provider itself, bypassing HeatShield. Lets triage tell
  // "our code is slow/broken" apart from "the upstream API is slow/broken".
  { id: 'openmeteo', url: 'https://api.open-meteo.com/v1/forecast?latitude=25.2&longitude=55.27&current=temperature_2m', floor: 1500, upstream: true, check: (status, body) => status === 200 && body.includes('temperature_2m') },
];

// How often each scheduled agent/worker must check in (minutes).
export const HEARTBEATS = { sol: 60, kai: 180, dispatch: 60 };

const clean = (s, n) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');

async function probe(fetchImpl, siteUrl, p, nowMs) {
  const started = nowMs();
  try {
    const res = await fetchImpl(p.url ?? `${siteUrl}${p.path}`, { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'HeatShield-Otto-Watchdog/1.0' } });
    const body = await res.text();
    return { id: p.id, ok: p.check(res.status, body), status: res.status, ms: nowMs() - started };
  } catch (err) {
    return { id: p.id, ok: false, status: 0, ms: nowMs() - started, error: err.name };
  }
}

// A model that is not enabled on the account (Bedrock access or Anthropic use-case form) is a setup
// state with the fallback serving, not an outage; any other failure still counts.
const SETUP_ERROR = /AccessDenied|ResourceNotFound|use case details|not authorized|don't have access|do not have access/i;

/** Deterministic triage: the facts the watchdog acts on. Issues with severity "info" do not degrade. */
export function triage({ probes, ewma, heartbeats, errors, modelFailures, modelSetup = null, failedRuns = 0, notes = [] }) {
  const issues = [];
  const upstream = probes.find((p) => p.id === 'openmeteo');
  const upstreamTrouble = upstream && (!upstream.ok || ewma.openmeteo?.anomaly);
  for (const p of probes) {
    if (p.id === 'openmeteo') {
      if (!p.ok) issues.push({ code: 'upstream_failing', severity: 'medium', detail: `Weather provider Open-Meteo failed (HTTP ${p.status}${p.error ? `, ${p.error}` : ''}); weather-dependent pages will degrade` });
      else if (ewma.openmeteo?.anomaly) issues.push({ code: 'upstream_slow', severity: 'low', detail: `Weather provider Open-Meteo took ${p.ms} ms, ${ewma.openmeteo.z}σ above its moving average` });
      continue;
    }
    // A weather-dependent probe that is slow while the provider is also slow is attributed upstream.
    const weatherDependent = p.id === 'risk';
    if (!p.ok) issues.push({ code: `${p.id}_failing`, severity: p.id === 'site' || p.id === 'health' ? 'high' : 'medium', detail: `Probe ${p.id} failed (HTTP ${p.status}${p.error ? `, ${p.error}` : ''})${weatherDependent && upstreamTrouble ? ' while Open-Meteo is also degraded' : ''}` });
    else if (ewma[p.id]?.anomaly && !(weatherDependent && upstreamTrouble)) issues.push({ code: `${p.id}_slow`, severity: 'low', detail: `Probe ${p.id} took ${p.ms} ms, ${ewma[p.id].z}σ above its moving average` });
  }
  for (const h of heartbeats) if (h.overdue) issues.push({ code: `${h.agent}_overdue`, severity: 'medium', detail: `${h.agent} last ran ${h.minutesAgo ?? 'never'} min ago (expected every ${h.everyMin} min)` });
  for (const e of errors) if (e.count > 0) issues.push({ code: `${e.fn}_errors`, severity: 'medium', detail: `${e.count} error/timeout log line(s) in ${e.fn} in the last 15 min` });
  if (modelFailures > 0 && modelSetup) issues.push({ code: 'primary_model_not_enabled', severity: 'info', detail: `The primary guidance model is not enabled on this AWS account yet (${modelSetup.reason}); the fallback model is serving every request` });
  else if (modelFailures > 0) issues.push({ code: 'primary_model_failing', severity: 'low', detail: `${modelFailures} failed call(s) to the primary guidance model in the last hour (fallback model serving)` });
  if (failedRuns > 0) issues.push({ code: 'failed_runs', severity: 'medium', detail: `${failedRuns} scheduled run(s) failed twice and are waiting in the dead-letter queue` });
  issues.push(...notes); // operator states (pauses, budget brake): info only
  const down = probes.some((p) => (p.id === 'site' || p.id === 'health') && !p.ok);
  const degraded = issues.some((i) => i.severity !== 'info');
  return { status: down ? 'down' : degraded ? 'degraded' : 'healthy', issues };
}

// ---------------------------------------------------------------- the budget brake
/**
 * Measures today's AI spend from the agent log and trips the brake when it reaches the operator's
 * daily budget: new AI work stops until 00:00 UTC, while heat alerts keep going out with cached or
 * pre-written advice. The ops topic is emailed once, when the brake trips.
 */
export async function checkBudget({ agentLog, control, publish, nowMs }) {
  const now = nowMs();
  const day = utcDay(now);
  const { settings } = await control.load();
  const prev = await agentLog.getState('admin', 'budget').catch(() => null);
  const spend = await measureSpend({ agentLog, sinceMs: Date.parse(`${day}T00:00:00Z`) });
  const tripped = spend.spentUsd >= settings.budgetUsd;
  const wasTripped = Boolean(prev?.tripped && prev.day === day);
  const state = {
    day, spentUsd: spend.spentUsd, budgetUsd: settings.budgetUsd, byAgent: spend.byAgent, byModel: spend.byModel,
    runs: spend.runs, unpriced: spend.unpriced, tripped,
    trippedAt: tripped ? (wasTripped ? prev.trippedAt : new Date(now).toISOString()) : null,
  };
  await agentLog.putState('admin', 'budget', state);
  control.invalidate();
  if (tripped && !wasTripped && publish) {
    await publish('HeatShield: daily AI budget reached',
      `Today's measured AI spend is US$${spend.spentUsd.toFixed(2)}, the daily budget is US$${settings.budgetUsd.toFixed(2)}.\n\nNew AI plans and agent model calls are paused until 00:00 UTC. Heat alerts keep going out, with cached or pre-written advice.\n\nTo resume sooner, raise the budget in the admin console.`).catch(() => {});
  }
  return state;
}

// ---------------------------------------------------------------- self-healing
export const REMEDIATION_COOLDOWN_MS = 2 * 3600_000;

/** Re-runs scheduled agents that missed their slot: at most once per agent every 2 hours, never a paused one. */
export async function selfHeal({ heartbeats, control, remediate, agentLog, nowMs }) {
  const overdue = heartbeats.filter((h) => h.overdue);
  if (!remediate || !overdue.length) return [];
  const last = (await agentLog.getState('otto', 'remediation').catch(() => null)) ?? {};
  const actions = [];
  for (const h of overdue) {
    if (control && await control.isPaused(h.agent)) continue;
    if (last[h.agent] && nowMs() - Date.parse(last[h.agent]) < REMEDIATION_COOLDOWN_MS) continue;
    try {
      await remediate(h.agent);
      actions.push({ agent: h.agent, action: 'rerun', ok: true });
    } catch (err) {
      actions.push({ agent: h.agent, action: 'rerun', ok: false, error: clean(err.message, 160) });
    }
    last[h.agent] = new Date(nowMs()).toISOString();
  }
  if (actions.length) await agentLog.putState('otto', 'remediation', last);
  return actions;
}

// ---------------------------------------------------------------- availability
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

function tally(days, day, status) {
  const d = days[day] ?? { checks: 0, up: 0, healthy: 0 };
  d.checks += 1;
  if (status !== 'down') d.up += 1;
  if (status === 'healthy') d.healthy += 1;
  days[day] = d;
}

export function summarizeUptime(days, nowMs, windowDays = 7) {
  const cutoff = utcDay(nowMs - (windowDays - 1) * 86_400_000);
  const keys = Object.keys(days).filter((k) => k >= cutoff).sort();
  const t = keys.reduce((a, k) => ({ checks: a.checks + days[k].checks, up: a.up + days[k].up, healthy: a.healthy + days[k].healthy }), { checks: 0, up: 0, healthy: 0 });
  return { windowDays, since: keys[0] ?? null, checks: t.checks, upPct: pct(t.up, t.checks), healthyPct: pct(t.healthy, t.checks) };
}

/** Per-UTC-day availability from Otto's own checks. The first call rebuilds the last 7 days from his run history. */
export async function recordUptime({ agentLog, status, nowMs }) {
  let days = (await agentLog.getState('otto', 'uptime').catch(() => null))?.days;
  if (!days) {
    days = {};
    for (const r of await agentLog.listRunsSince('otto', new Date(nowMs() - 7 * 86_400_000).toISOString())) {
      const o = r.outcome ?? '';
      const s = o === 'healthy' ? 'healthy' : o.startsWith('degraded') ? 'degraded' : o.startsWith('down') ? 'down' : null;
      if (s) tally(days, r.at.slice(0, 10), s); // Otto's own failed or paused runs say nothing about the site
    }
  }
  tally(days, utcDay(nowMs()), status);
  days = Object.fromEntries(Object.keys(days).sort().slice(-8).map((k) => [k, days[k]]));
  await agentLog.putState('otto', 'uptime', { days });
  return summarizeUptime(days, nowMs());
}

export function parseIncident(text) {
  const raw = extractJson(text);
  return {
    severity: ['low', 'medium', 'high'].includes(raw.severity) ? raw.severity : 'medium',
    title: clean(raw.title, 120) || 'HeatShield incident',
    summary: clean(raw.summary, 600),
    likelyCause: clean(raw.likelyCause, 400),
    recommendedAction: clean(raw.recommendedAction, 400),
    evidence: (Array.isArray(raw.evidence) ? raw.evidence : []).map((e) => clean(e, 200)).filter(Boolean).slice(0, 6),
  };
}

/**
 * @param {object} deps
 * @param {{count: Function, sample: Function}} deps.logs  CloudWatch Logs helpers
 * @param {Record<string,string>} deps.logGroups  fn name -> log group
 * @param {Function} deps.publish  (subject, message) => Promise  (Ops SNS topic)
 */
export async function runWatchdog({ fetchImpl = globalThis.fetch, siteUrl, agentLog, logs, logGroups, converse, models, publish, control = null, remediate = null, failedRuns = null, nowMs = () => Date.now(), deadline = Date.now() + 100_000 }) {
  const probes = await Promise.all(PROBES.map((p) => probe(fetchImpl, siteUrl, p, nowMs)));

  // EWMA control chart per probe (state persisted between runs).
  const prevEwma = (await agentLog.getState('otto', 'ewma')) ?? {};
  const ewma = {};
  const nextEwma = {};
  for (const p of probes) {
    if (!p.ok) continue;
    const floor = PROBES.find((x) => x.id === p.id)?.floor ?? 800;
    ewma[p.id] = ewmaAnomaly(prevEwma[p.id], p.ms, { k: 3, minSamples: 8, floor });
    nextEwma[p.id] = ewmaUpdate(prevEwma[p.id], p.ms);
  }
  await agentLog.putState('otto', 'ewma', { ...prevEwma, ...nextEwma });

  const heartbeats = await Promise.all(Object.entries(HEARTBEATS).map(async ([agent, everyMin]) => {
    const [last] = await agentLog.listRuns(agent, 1);
    const minutesAgo = last ? Math.round((nowMs() - Date.parse(last.at)) / 60_000) : null;
    return { agent, everyMin, lastAt: last?.at ?? null, minutesAgo, overdue: minutesAgo === null ? false : minutesAgo > everyMin * 2 + 10 };
  }));

  const remediations = await selfHeal({ heartbeats, control, remediate, agentLog, nowMs });
  const failed = failedRuns ? await failedRuns().catch(() => null) : null;
  const budget = control ? await checkBudget({ agentLog, control, publish, nowMs }).catch(() => null) : null;
  const notes = [];
  if (control) {
    const { settings } = await control.load();
    const paused = Object.entries(settings.paused).filter(([, v]) => v).map(([k]) => k);
    if (paused.length) notes.push({ code: 'agents_paused', severity: 'info', detail: `Paused by the operator: ${paused.join(', ')}` });
    if (settings.aiPaused) notes.push({ code: 'ai_paused', severity: 'info', detail: 'All AI work is paused by the operator; alerts continue with cached or pre-written advice' });
  }
  if (budget?.tripped) notes.push({ code: 'ai_budget_reached', severity: 'info', detail: `Daily AI budget reached (US$${budget.spentUsd.toFixed(2)} of US$${budget.budgetUsd.toFixed(2)}); new AI work paused until 00:00 UTC` });

  const since = nowMs() - 15 * 60_000;
  const errors = await Promise.all(Object.entries(logGroups).map(async ([fn, group]) => ({
    fn,
    count: (await logs.count(group, '?"\\"level\\":\\"error\\"" ?"Task timed out"', since).catch(() => 0)),
  })));
  // Guidance is generated in the public API AND in the alert loop; count primary-model failures in both
  // (the first version only looked at the public API and missed failures in the 02:00 alert run).
  const guidanceGroups = ['publicApi', 'alertCheck'].filter((fn) => logGroups[fn]).map((fn) => logGroups[fn]);
  const modelFailures = (await Promise.all(guidanceGroups.map((g) =>
    logs.count(g, '"bedrock_guidance_failed"', nowMs() - 3600_000).catch(() => 0)))).reduce((a, b) => a + b, 0);
  // Read the actual errors: the first live incident report guessed "transient unavailability" when
  // the logs said the Anthropic use-case form had not been submitted.
  let modelSetup = null;
  if (modelFailures > 0) {
    const lines = (await Promise.all(guidanceGroups.map((g) => logs.sample(g, '"bedrock_guidance_failed"', nowMs() - 3600_000, 3).catch(() => [])))).flat();
    const parsed = lines.map((l) => { try { return JSON.parse(l.line); } catch { return { message: String(l.line) }; } });
    if (parsed.length && parsed.every((x) => SETUP_ERROR.test(`${x.error ?? ''} ${x.message ?? ''}`))) {
      const last = parsed.at(-1);
      modelSetup = { modelId: last.modelId ?? null, reason: `${last.error ? `${last.error}: ` : ''}${last.message ?? ''}`.slice(0, 200) };
    }
  }

  const { status, issues } = triage({ probes, ewma, heartbeats, errors, modelFailures, modelSetup, failedRuns: failed ?? 0, notes });
  const uptime = await recordUptime({ agentLog, status, nowMs }).catch(() => null);
  const snapshot = {
    status, issues,
    probes: probes.map((p) => ({ ...p, anomaly: Boolean(ewma[p.id]?.anomaly), z: ewma[p.id]?.z ?? null, avgMs: nextEwma[p.id] ? Math.round(nextEwma[p.id].mean) : null })),
    heartbeats, errors, modelFailures, failedRuns: failed, remediations, uptime,
    budget: budget ? { spentUsd: budget.spentUsd, budgetUsd: budget.budgetUsd, tripped: budget.tripped } : null,
  };
  const healed = remediations.length ? ` Re-ran ${remediations.map((r) => `${r.agent}${r.ok ? '' : ' (failed)'}`).join(', ')}.` : '';

  if (status === 'healthy') {
    await agentLog.putState('otto', 'latest', { ...snapshot, incident: null });
    const note = issues.some((i) => i.code === 'primary_model_not_enabled') ? ' Note: the primary model is not enabled on the account yet; the fallback is serving.' : '';
    const brake = budget?.tripped ? ' AI paused: daily budget reached.' : '';
    return { outcome: 'healthy', summary: `All ${probes.length} probes healthy (site ${probes[0].ms} ms); all agents on schedule.${note}${brake}${healed}`, detail: snapshot };
  }

  const fingerprint = createHash('sha1').update(issues.filter((i) => i.severity !== 'info').map((i) => i.code).sort().join('|')).digest('hex').slice(0, 12);
  const prev = await agentLog.getState('otto', 'incident');
  const fresh = !prev || prev.fingerprint !== fingerprint || nowMs() - Date.parse(prev.updatedAt) > 6 * 3600_000;
  if (!fresh) {
    await agentLog.putState('otto', 'latest', { ...snapshot, incident: prev });
    return { outcome: `${status}-ongoing`, summary: `Still ${status}: ${issues.filter((i) => i.severity !== 'info').map((i) => i.code).join(', ')} (incident already reported).${healed}`, detail: snapshot };
  }

  // With AI work paused (operator or budget), the report is written from the triage alone.
  const allowed = control ? await control.generation('otto') : { ok: true };
  if (!allowed.ok) {
    const real = issues.filter((i) => i.severity !== 'info');
    const incident = {
      severity: real.some((i) => i.severity === 'high') ? 'high' : 'medium',
      title: `${status}: ${real.map((i) => i.code).join(', ')}`.slice(0, 120),
      summary: real.map((i) => i.detail).join('. ').slice(0, 600),
      likelyCause: 'Not investigated by the model: AI work is paused (operator or daily budget).',
      recommendedAction: 'Open the admin console; resume AI work if a written investigation is needed.',
      evidence: [], fingerprint, status, codes: issues.map((i) => i.code),
    };
    await agentLog.putState('otto', 'incident', incident);
    await agentLog.putState('otto', 'latest', { ...snapshot, incident: { ...incident, updatedAt: new Date(nowMs()).toISOString() } });
    if (publish) await publish(`HeatShield ${status}: ${incident.title}`.slice(0, 99), incident.summary).catch(() => {});
    return { outcome: `${status}-reported`, summary: `${status.toUpperCase()}: ${incident.title}${healed}`, detail: { ...snapshot, incident } };
  }

  const run = await runAgent({
    agent: {
      name: 'otto',
      models,
      maxTurns: 5,
      maxTokens: 1000,
      system: 'You are Otto, HeatShield\'s site reliability engineer. HeatShield is a public heat early-warning service; if it is down, people miss warnings and the project fails its ship gate. Investigate the issues with your tools, find the most likely cause, and write a short, precise incident report with one recommended action. Do not speculate beyond the evidence.',
      tools: [
        { name: 'get_triage', description: 'Deterministic triage: probe results, latency control-chart flags, agent heartbeats, error counts.', inputSchema: { type: 'object', properties: {} }, handler: async () => snapshot },
        {
          name: 'get_error_samples',
          description: 'Recent error/warning log lines from one function (fn: publicApi, enrollmentApi, alertCheck).',
          inputSchema: { type: 'object', properties: { fn: { type: 'string' } }, required: ['fn'] },
          handler: async ({ fn }) => {
            const group = logGroups[fn];
            if (!group) throw new Error('Unknown function');
            return { lines: await logs.sample(group, '?"\\"level\\":\\"error\\"" ?"\\"level\\":\\"warn\\"" ?"Task timed out"', nowMs() - 3600_000, 8) };
          },
        },
      ],
    },
    input: `Status: ${status}. Issues:\n${issues.map((i) => `- [${i.severity}] ${i.code}: ${i.detail}`).join('\n')}\nInvestigate, then reply with ONLY this JSON:\n{"severity":"low|medium|high","title":"...","summary":"...","likelyCause":"...","evidence":["..."],"recommendedAction":"..."}`,
    converse,
    deadline,
    validate: parseIncident,
  });
  const incident = { ...run.value, fingerprint, status, codes: issues.map((i) => i.code) };
  await agentLog.putState('otto', 'incident', incident);
  await agentLog.putState('otto', 'latest', { ...snapshot, incident: { ...incident, updatedAt: new Date(nowMs()).toISOString() } });
  if (publish) {
    await publish(`HeatShield ${status}: ${incident.title}`.slice(0, 99), `${incident.summary}\n\nLikely cause: ${incident.likelyCause}\nRecommended action: ${incident.recommendedAction}\n\nEvidence:\n${incident.evidence.map((e) => `- ${e}`).join('\n')}`).catch(() => {});
  }
  return { ...run, outcome: `${status}-reported`, summary: `${status.toUpperCase()}: ${incident.title}${healed}`, detail: { ...snapshot, incident } };
}
