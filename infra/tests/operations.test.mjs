/**
 * Operator controls and 24/7 operations: pauses, the AI budget brake, Otto's self-healing, the
 * dead-letter queue, availability, and the site notice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, createControl, runUnlessPaused, utcDay } from '../functions/lib/control.mjs';
import { measureSpend, runCost, PRICES } from '../functions/lib/spend.mjs';
import { runWatchdog, checkBudget, selfHeal, recordUptime, summarizeUptime } from '../functions/lib/agents/watchdog.mjs';
import { createAgentLog } from '../functions/lib/agent-log.mjs';
import { createGuidanceService } from '../functions/lib/guidance.mjs';
import { createPublicApi } from '../functions/lib/public-routes.mjs';
import { runSentinel } from '../functions/lib/agents/sentinel.mjs';
import { runCoordinator } from '../functions/lib/agents/coordinator.mjs';
import { createStore } from '../functions/lib/store.mjs';
import { assessRisk } from '../functions/lib/heat.mjs';
import { createFakeDb, makeForecast, diurnal, silentLog, apiEvent, parse } from './helpers.mjs';

const NOVA_LITE = 'us.amazon.nova-2-lite-v1:0';
const NOVA_PRO = 'us.amazon.nova-pro-v1:0';
const text = (t) => ({ stopReason: 'end_turn', output: { message: { role: 'assistant', content: [{ text: t }] } }, usage: { inputTokens: 10, outputTokens: 5 } });
const hot = () => makeForecast({ nowHour: 9, temp: diurnal(27, 38), rh: () => 55 });
const GOOD = { headline: 'Dangerous heat this afternoon.', actions: ['Start work early.', 'Rest in shade at 13:00.', 'Drink water often.'], seekHelp: 'If confused, call your local emergency number.' };
const memCache = () => { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, put: async (e) => { m.set(e.cacheKey, e); } }; };

function world(startIso = '2026-09-29T10:00:00Z') {
  const { db, tables } = createFakeDb();
  let now = Date.parse(startIso);
  const clock = { nowMs: () => now, advance: (ms) => { now += ms; } };
  const agentLog = createAgentLog({ db, table: tables.agentLog, nowMs: clock.nowMs });
  const control = createControl({ agentLog, nowMs: clock.nowMs, ttlMs: 0 });
  return { db, tables, agentLog, control, clock };
}

// ---------------------------------------------------------------- settings and pauses
test('settings are validated: budget clamped, notice cleaned, unknown agents ignored', () => {
  const s = normalizeSettings({ paused: { sol: 1, dispatch: true, hacker: true }, budgetUsd: 1e9, notice: { text: '<b>Heat</b> warning in Karachi', level: 'shout', until: 'not a date' } });
  assert.equal(s.paused.sol, true);
  assert.equal(s.paused.dispatch, undefined, 'the Dispatcher (alerts) can never be paused');
  assert.equal(s.paused.hacker, undefined);
  assert.equal(s.budgetUsd, 100);
  assert.equal(normalizeSettings({ budgetUsd: 0 }).budgetUsd, 0.5);
  assert.equal(normalizeSettings({}).budgetUsd, 5);
  assert.deepEqual(s.notice, { text: 'Heat warning in Karachi', level: 'info', until: null });
  assert.equal(normalizeSettings({ notice: { text: '   ' } }).notice, null);
});

test('generation gate: operator pause, global AI pause, and a budget brake that only holds for its day', async () => {
  const w = world();
  assert.deepEqual(await w.control.generation('mira'), { ok: true });
  await w.agentLog.putState('admin', 'settings', { paused: { mira: true } });
  assert.deepEqual(await w.control.generation('mira'), { ok: false, reason: 'paused' });
  assert.deepEqual(await w.control.generation('sol'), { ok: true });
  await w.agentLog.putState('admin', 'settings', { aiPaused: true });
  assert.deepEqual(await w.control.generation('sol'), { ok: false, reason: 'ai_paused' });
  await w.agentLog.putState('admin', 'settings', {});
  await w.agentLog.putState('admin', 'budget', { day: '2026-09-29', tripped: true });
  assert.deepEqual(await w.control.generation('sol'), { ok: false, reason: 'budget_paused' });
  w.clock.advance(24 * 3600_000);
  assert.deepEqual(await w.control.generation('sol'), { ok: true }, 'a new UTC day releases the brake');
});

test('the site notice expires on its own', async () => {
  const w = world();
  await w.agentLog.putState('admin', 'settings', { notice: { text: 'Extreme heat in Dhaka until Friday', level: 'danger', until: '2026-09-29T12:00:00Z' } });
  assert.equal((await w.control.notice()).level, 'danger');
  w.clock.advance(3 * 3600_000);
  assert.equal(await w.control.notice(), null);
});

test('a paused agent skips its run but still checks in; the admin "run now" overrides the pause', async () => {
  const w = world();
  await w.agentLog.putState('admin', 'settings', { paused: { sol: true } });
  let ran = 0;
  const work = async () => { ran += 1; return { outcome: 'ok' }; };
  const r = await runUnlessPaused({ control: w.control, agentLog: w.agentLog, agent: 'sol', trigger: 'schedule', work });
  assert.equal(r.outcome, 'paused');
  assert.equal(ran, 0);
  assert.equal((await w.agentLog.listRuns('sol', 1))[0].outcome, 'paused');
  await runUnlessPaused({ control: w.control, agentLog: w.agentLog, agent: 'sol', trigger: 'admin', work });
  assert.equal(ran, 1);
});

// ---------------------------------------------------------------- spend and the budget brake
test('spend is measured from the agent log at list prices; unknown models are counted, not guessed', async () => {
  const w = world();
  await w.agentLog.recordRun('mira', { model: NOVA_LITE, inputTokens: 1_000_000, outputTokens: 100_000 });
  await w.agentLog.recordRun('lexi', { model: NOVA_PRO, inputTokens: 500_000, outputTokens: 50_000 });
  await w.agentLog.recordRun('sol', { model: 'some.new-model', inputTokens: 10, outputTokens: 10 });
  await w.agentLog.recordRun('otto', { model: null, inputTokens: 0, outputTokens: 0 });
  assert.equal(runCost({ model: NOVA_LITE, inputTokens: 1e6, outputTokens: 0 }), PRICES[NOVA_LITE].input);
  const s = await measureSpend({ agentLog: w.agentLog, sinceMs: Date.parse('2026-09-29T00:00:00Z') });
  assert.equal(s.spentUsd, 1.165); // 0.33 + 0.275 (Nova 2 Lite) + 0.40 + 0.16 (Nova Pro)
  assert.equal(s.unpriced, 1);
  assert.equal(s.runs, 3);
  const later = await measureSpend({ agentLog: w.agentLog, sinceMs: Date.parse('2026-09-30T00:00:00Z') });
  assert.equal(later.spentUsd, 0, 'runs before the window are not counted');
});

test('Otto trips the budget brake once, emails the ops topic once, and the brake resets the next day', async () => {
  const w = world();
  await w.agentLog.putState('admin', 'settings', { budgetUsd: 1 });
  const mail = [];
  const publish = async (subject) => { mail.push(subject); };
  await w.agentLog.recordRun('mira', { model: NOVA_PRO, inputTokens: 1_000_000, outputTokens: 100_000 }); // US$1.12
  const first = await checkBudget({ agentLog: w.agentLog, control: w.control, publish, nowMs: w.clock.nowMs });
  assert.equal(first.tripped, true);
  assert.deepEqual(await w.control.generation('mira'), { ok: false, reason: 'budget_paused' });
  await checkBudget({ agentLog: w.agentLog, control: w.control, publish, nowMs: w.clock.nowMs });
  assert.equal(mail.length, 1, 'one email per trip');
  w.clock.advance(24 * 3600_000);
  const next = await checkBudget({ agentLog: w.agentLog, control: w.control, publish, nowMs: w.clock.nowMs });
  assert.equal(next.tripped, false);
  assert.equal(next.day, utcDay(w.clock.nowMs()));
});

// ---------------------------------------------------------------- self-healing
test('Otto re-runs a stalled agent once per 2 hours, and never a paused one', async () => {
  const w = world();
  const calls = [];
  const remediate = async (agent) => { calls.push(agent); };
  const heartbeats = [{ agent: 'sol', overdue: true }, { agent: 'kai', overdue: true }, { agent: 'dispatch', overdue: false }];
  await w.agentLog.putState('admin', 'settings', { paused: { kai: true } });
  const a1 = await selfHeal({ heartbeats, control: w.control, remediate, agentLog: w.agentLog, nowMs: w.clock.nowMs });
  assert.deepEqual(a1, [{ agent: 'sol', action: 'rerun', ok: true }]);
  w.clock.advance(15 * 60_000);
  assert.deepEqual(await selfHeal({ heartbeats, control: w.control, remediate, agentLog: w.agentLog, nowMs: w.clock.nowMs }), []);
  w.clock.advance(2 * 3600_000);
  await selfHeal({ heartbeats, control: w.control, remediate, agentLog: w.agentLog, nowMs: w.clock.nowMs });
  assert.deepEqual(calls, ['sol', 'sol']);
});

// ---------------------------------------------------------------- availability
test('availability is rebuilt from Otto\'s history on the first run, then counted check by check', async () => {
  const w = world();
  w.clock.advance(-3600_000);
  await w.agentLog.recordRun('otto', { outcome: 'healthy' });
  await w.agentLog.recordRun('otto', { outcome: 'degraded-reported' });
  await w.agentLog.recordRun('otto', { outcome: 'down-reported' });
  await w.agentLog.recordRun('otto', { outcome: 'error' }); // Otto's own failure says nothing about the site
  w.clock.advance(3600_000);
  const u = await recordUptime({ agentLog: w.agentLog, status: 'healthy', nowMs: w.clock.nowMs });
  assert.equal(u.checks, 4);
  assert.equal(u.upPct, 75);
  assert.equal(u.healthyPct, 50);
  const again = await recordUptime({ agentLog: w.agentLog, status: 'healthy', nowMs: w.clock.nowMs });
  assert.equal(again.checks, 5);
  assert.equal(summarizeUptime({ '2026-09-01': { checks: 9, up: 0, healthy: 0 } }, w.clock.nowMs()).checks, 0, 'days outside the window do not count');
});

test('Otto: failed scheduled runs degrade the status; a tripped budget is only a note; no model call when AI is paused', async () => {
  const w = world();
  const fetchImpl = async (url) => ({ status: 200, text: async () => (url.includes('open-meteo') ? '{"current":{"temperature_2m":31}}' : url.includes('health') ? '{"ok":true}' : url.includes('risk') ? '{"risk":{}}' : url.includes('agents') ? '{"agents":[]}' : 'HeatShield') });
  const logs = { count: async () => 0, sample: async () => [] };
  const deps = { fetchImpl, siteUrl: 'https://x.test', agentLog: w.agentLog, logs, logGroups: { publicApi: 'g' }, models: ['m'], control: w.control, nowMs: w.clock.nowMs };

  await w.agentLog.putState('admin', 'settings', { budgetUsd: 0.5 });
  await w.agentLog.recordRun('mira', { model: NOVA_PRO, inputTokens: 1_000_000, outputTokens: 0 }); // US$0.80
  const mail = [];
  const healthy = await runWatchdog({ ...deps, publish: async (s) => { mail.push(s); }, converse: async () => { throw new Error('no model when healthy'); } });
  assert.equal(healthy.outcome, 'healthy');
  assert.match(healthy.summary, /AI paused: daily budget reached/);
  assert.ok(healthy.detail.issues.some((i) => i.code === 'ai_budget_reached' && i.severity === 'info'));
  assert.equal(mail.length, 1);

  const failed = await runWatchdog({ ...deps, publish: async (s) => { mail.push(s); }, failedRuns: async () => 2, converse: async () => { throw new Error('AI is paused: Otto must not call the model'); } });
  assert.equal(failed.outcome, 'degraded-reported');
  assert.match(failed.detail.incident.likelyCause, /AI work is paused/);
  assert.ok(failed.detail.issues.some((i) => i.code === 'failed_runs'));
});

// ---------------------------------------------------------------- plans respect the brake
test('with the brake on, approved plans still come from the cache; new ones get pre-written advice, and every outcome is logged', async () => {
  const w = world();
  let allowed = { ok: true };
  const cache = memCache();
  const svc = createGuidanceService({ converse: async () => text(JSON.stringify(GOOD)), cache, models: ['w'], log: silentLog, agentLog: w.agentLog, gate: async () => allowed, nowMs: w.clock.nowMs, nowSeconds: () => Math.floor(w.clock.nowMs() / 1000) });
  const risk = assessRisk(hot(), 'outdoor_worker');
  const first = await svc.getGuidance(risk, 'en');
  assert.equal(first.source, 'bedrock');
  assert.match(first.speechKey, /^[0-9a-f]{64}$/);
  allowed = { ok: false, reason: 'budget_paused' };
  assert.equal((await svc.getGuidance(risk, 'en')).source, 'cache');
  const other = await svc.getGuidance(risk, 'es');
  assert.equal(other.source, 'fallback');
  assert.equal(other.fallbackReason, 'budget_paused');
  assert.match(other.speechKey, /^fb\.[a-z_]+\.outdoor_worker\.es$/);
  const plans = await w.agentLog.listRuns('plans', 10);
  assert.deepEqual(plans.map((p) => p.outcome).sort(), ['fallback', 'published'], 'cache hits are not new plans');
  assert.equal(plans.find((p) => p.outcome === 'published').detail.cacheKey, first.speechKey);
});

test('public API: the notice route, and on-demand runs refused while paused or over budget', async () => {
  const w = world();
  const runAgentNow = async () => ({ outcome: 'ok' });
  const api = createPublicApi({ weather: {}, guidance: {}, version: 't', region: 'r', agentLog: w.agentLog, runAgentNow, control: w.control, now: w.clock.nowMs });
  assert.deepEqual(parse(await api(apiEvent('GET /api/notice'))).body, { notice: null });
  await w.agentLog.putState('admin', 'settings', { paused: { sol: true }, notice: { text: 'Cooling centres open in Karachi', level: 'info' } });
  assert.equal(parse(await api(apiEvent('GET /api/notice'))).body.notice.text, 'Cooling centres open in Karachi');
  const paused = parse(await api(apiEvent('POST /api/agents/{agentId}/run', { pathParameters: { agentId: 'sol' } })));
  assert.equal(paused.status, 409);
  await w.agentLog.putState('admin', 'settings', {});
  await w.agentLog.putState('admin', 'budget', { day: '2026-09-29', tripped: true });
  const over = parse(await api(apiEvent('POST /api/agents/{agentId}/run', { pathParameters: { agentId: 'sol' } })));
  assert.equal(over.status, 503);
  assert.match(over.body.error.message, /budget/);
  const otto = parse(await api(apiEvent('POST /api/agents/{agentId}/run', { pathParameters: { agentId: 'otto' } })));
  assert.equal(otto.status, 200, 'Otto needs no model to check the site, so the AI brake does not stop him');
});

// ---------------------------------------------------------------- agents without AI
test('Sol and Kai keep working from their algorithms when AI work is paused, and Sol re-briefs once it resumes', async () => {
  const w = world();
  const store = createStore({ db: w.db, tables: w.tables });
  await w.db.put({ table: 'locations', item: { locationId: 'l1', lat: 23.81, lon: 90.41, placeName: 'Dhaka, Bangladesh', profile: 'elderly', groupId: 'g1', name: 'Nani' } });
  await w.db.put({ table: 'groups', item: { groupId: 'g1', name: 'Block C' } });
  const dates = Array.from({ length: 38 }, (_, i) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10));
  const weather = { getForecast: async () => hot(), getDaily: async () => ({ dates, today: dates[31], tmax: Array(38).fill(38), tmin: Array(38).fill(29) }) };
  const noModel = async () => { throw new Error('AI is paused'); };

  const sol = await runSentinel({ store, weather, climate: { get: async () => null }, agentLog: w.agentLog, converse: noModel, models: ['m'], nowMs: w.clock.nowMs, retryPauseMs: 0, allowModel: false });
  assert.equal(sol.outcome, 'algorithm-only');
  const state = await w.agentLog.getState('sol', 'latest');
  assert.equal(state.events[0].place, 'Dhaka, Bangladesh');
  assert.match(state.briefing, /AI briefing paused/);

  w.clock.advance(3600_000);
  const replies = [text(JSON.stringify({ briefing: 'Dangerous heat and humidity in Dhaka.', events: [{ areaId: 'A1', level: 'warning' }] }))];
  const resumed = await runSentinel({ store, weather, climate: { get: async () => null }, agentLog: w.agentLog, converse: async () => replies.shift(), models: ['m'], nowMs: w.clock.nowMs, retryPauseMs: 0 });
  assert.equal(resumed.outcome, 'briefed', 'same heat, but the algorithm-only briefing is replaced as soon as AI is back');

  const kai = await runCoordinator({ store, weather, agentLog: w.agentLog, converse: noModel, models: ['m'], nowMs: w.clock.nowMs, allowModel: false });
  assert.equal(kai.detail.groupsPlanned, 1);
  const plan = await w.agentLog.getState('kai', 'group#g1');
  assert.equal(plan.checkIns[0].writtenBy, 'template');
  assert.match(plan.summary, /AI wording is paused/);
});
