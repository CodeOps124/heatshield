import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, extractJson } from '../functions/lib/agent-runtime.mjs';
import { createAgentLog, recorded } from '../functions/lib/agent-log.mjs';
import { createGuidanceService, retrieveFacts, buildGuidanceInput } from '../functions/lib/guidance.mjs';
import { detectRuleViolations, createSafetyReviewer } from '../functions/lib/agents/safety-reviewer.mjs';
import { createLanguageReviewer } from '../functions/lib/agents/language-reviewer.mjs';
import { evidenceCeiling, parseSentinelOutput, runSentinel, buildAreas } from '../functions/lib/agents/sentinel.mjs';
import { buildCheckInSchedule, urgencyScore, parseCoordinatorOutput, runCoordinator } from '../functions/lib/agents/coordinator.mjs';
import { triage, runWatchdog } from '../functions/lib/agents/watchdog.mjs';
import { createAgentsApi } from '../functions/lib/agents-api.mjs';
import { nextRunAt } from '../functions/lib/agents/roster.mjs';
import { assessRisk } from '../functions/lib/heat.mjs';
import { createStore } from '../functions/lib/store.mjs';
import { createFakeDb, makeForecast, diurnal, silentLog } from './helpers.mjs';

const text = (t, stop = 'end_turn', usage = { inputTokens: 10, outputTokens: 5 }) => ({ stopReason: stop, output: { message: { role: 'assistant', content: [{ text: t }] } }, usage });
const toolUse = (name, input = {}, id = 't1') => ({ stopReason: 'tool_use', output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: id, name, input } }] } }, usage: { inputTokens: 20, outputTokens: 5 } });
const hot = () => makeForecast({ nowHour: 9, temp: diurnal(27, 38), rh: () => 55 });

// ---------------------------------------------------------------- agent runtime
test('agent loop: model calls a tool, sees the result, then answers', async () => {
  const seen = [];
  const replies = [toolUse('get_x', { q: 1 }), text('{"answer":42}')];
  const res = await runAgent({
    agent: { name: 't', models: ['m1'], system: 's', tools: [{ name: 'get_x', description: 'd', inputSchema: { type: 'object' }, handler: async (a) => { seen.push(a); return [1, 2]; } }] },
    input: 'go',
    converse: async (p) => {
      if (seen.length) {
        const last = p.messages.at(-1).content[0].toolResult;
        assert.deepEqual(last.content[0].json, { result: [1, 2] }, 'arrays are wrapped for Converse');
      }
      return replies.shift();
    },
  });
  assert.deepEqual(seen, [{ q: 1 }]);
  assert.equal(extractJson(res.text).answer, 42);
  assert.equal(res.turns, 2);
  assert.equal(res.toolCalls[0].name, 'get_x');
  assert.equal(res.usage.inputTokens, 30);
});

test('agent loop: falls back to the next model only when the first call fails', async () => {
  const tried = [];
  const res = await runAgent({
    agent: { name: 't', models: ['bad', 'good'], system: 's' },
    input: 'x',
    converse: async ({ modelId }) => { tried.push(modelId); if (modelId === 'bad') throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' }); return text('ok'); },
  });
  assert.deepEqual(tried, ['bad', 'good']);
  assert.equal(res.model, 'good');
  await assert.rejects(runAgent({
    agent: { name: 't', models: ['m'], system: 's', maxTurns: 2, tools: [{ name: 'loop', description: 'd', inputSchema: { type: 'object' }, handler: async () => ({}) }] },
    input: 'x', converse: async () => toolUse('loop'),
  }), /did not finish within 2 turns/);
});

test('agent log records successful and failed runs', async () => {
  const { db, tables } = createFakeDb();
  const agentLog = createAgentLog({ db, table: tables.agentLog });
  await recorded(agentLog, 'sol', 'test', async () => ({ outcome: 'quiet', summary: 'ok' }));
  await assert.rejects(recorded(agentLog, 'sol', 'test', async () => { throw new Error('boom'); }));
  const runs = await agentLog.listRuns('sol', 5);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((r) => r.outcome).sort(), ['error', 'quiet']);
});

// ---------------------------------------------------------------- Mira + reviewers
test('Mira retrieves profile-relevant facts with BM25 and always keeps the life-safety facts', () => {
  const worker = retrieveFacts(buildGuidanceInput(assessRisk(hot(), 'outdoor_worker'), 'en')).map((f) => f.id);
  const child = retrieveFacts(buildGuidanceInput(assessRisk(hot(), 'child'), 'en')).map((f) => f.id);
  assert.ok(worker.includes('worker-water'));
  assert.ok(child.includes('parked-car'));
  for (const ids of [worker, child]) assert.ok(ids.includes('heat-stroke') && ids.includes('heat-exhaustion'));
});

test('Vera\'s detectors catch phone numbers, medicines and doses but not times or ranges', () => {
  const clean = { headline: 'Hot until 17:00.', actions: ['Drink a cup every 15-20 minutes.', 'Rest at 13:00.'], seekHelp: 'Call your local emergency number.' };
  assert.equal(detectRuleViolations(clean).length, 0);
  const bad = { ...clean, actions: ['Take 500 mg paracetamol.', 'Call 0800 123 4567.'] };
  const found = detectRuleViolations(bad).map((i) => i.detector).sort();
  assert.deepEqual(found, ['dose', 'medicine', 'phone']);
});

const GOOD = { headline: 'Dangerous heat this afternoon.', actions: ['Start work early.', 'Rest in shade at 13:00.', 'Drink water often.'], seekHelp: 'If confused, call your local emergency number.' };
const writerReply = (g) => text(JSON.stringify(g));
const memCache = () => { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, put: async (e) => { m.set(e.cacheKey, e); } }; };

test('review loop: a reviewer sends the draft back, Mira revises with the feedback, both approve, result is cached', async () => {
  const prompts = [];
  const lexiVerdicts = ['revise', 'approve'];
  const reviewers = {
    language: { review: async () => { const v = lexiVerdicts.shift(); return { verdict: v, method: 'test', issues: v === 'revise' ? [{ quote: 'Start', problem: 'Wrong word', fix: 'Begin' }] : [], backTranslation: GOOD, model: 'nova-pro' }; } },
    safety: { review: async () => ({ verdict: 'approve', method: 'test', issues: [], model: 'nova-pro' }) },
  };
  const { db, tables } = createFakeDb();
  const agentLog = createAgentLog({ db, table: tables.agentLog });
  const cache = memCache();
  const svc = createGuidanceService({
    converse: async (p) => { prompts.push(p.messages[0].content[0].text); return writerReply(GOOD); },
    cache, models: ['writer'], log: silentLog, reviewers, agentLog,
  });
  const g = await svc.getGuidance(assessRisk(hot(), 'outdoor_worker'), 'en');
  assert.equal(g.source, 'bedrock');
  assert.equal(g.review.status, 'approved');
  assert.equal(g.review.revised, true);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /sent back by HeatShield's reviewers[\s\S]*Wrong word[\s\S]*Fix: Begin/);
  assert.equal(cache.m.size, 1, 'approved guidance is cached');
  assert.equal((await agentLog.listRuns('mira', 5)).length, 2);
  assert.equal((await agentLog.listRuns('lexi', 5)).length, 2);
  const again = await svc.getGuidance(assessRisk(hot(), 'outdoor_worker'), 'en');
  assert.equal(again.source, 'cache');
  assert.equal(again.review.status, 'approved');
});

test('review loop: rejected twice -> safe pre-written guidance; reviewer outage -> shown as unreviewed, not cached', async () => {
  const reject = { review: async () => ({ verdict: 'revise', issues: [{ problem: 'unsafe' }] }) };
  const approve = { review: async () => ({ verdict: 'approve', issues: [] }) };
  const cache = memCache();
  const svc = createGuidanceService({ converse: async () => writerReply(GOOD), cache, models: ['w'], log: silentLog, reviewers: { language: approve, safety: reject } });
  const g = await svc.getGuidance(assessRisk(hot(), 'elderly'), 'es');
  assert.equal(g.source, 'fallback');
  assert.equal(g.fallbackReason, 'reviewers_rejected');
  assert.equal(g.language, 'es');

  const down = { review: async () => { throw new Error('throttled'); } };
  const cache2 = memCache();
  const svc2 = createGuidanceService({ converse: async () => writerReply(GOOD), cache: cache2, models: ['w'], log: silentLog, reviewers: { language: down, safety: approve } });
  const g2 = await svc2.getGuidance(assessRisk(hot(), 'elderly'), 'en');
  assert.equal(g2.source, 'bedrock');
  assert.equal(g2.review.status, 'unreviewed');
  assert.equal(cache2.m.size, 0);
});

test('Lexi rejects wrong-language text without spending a model call; Vera rejects rule violations without one too', async () => {
  let calls = 0;
  const converse = async () => { calls += 1; return text('{}'); };
  const lexi = createLanguageReviewer({ converse, models: ['m'] });
  const r = await lexi.review({ headline: 'Drink water and stay in the shade today.', actions: ['Rest in the shade when it is hot.', 'Drink water often during the day.'], seekHelp: 'If you feel confused, call for help.' }, { language: 'es', factsSummary: '' });
  assert.equal(r.verdict, 'revise');
  assert.equal(r.method, 'langid');
  const vera = createSafetyReviewer({ converse, models: ['m'] });
  const v = await vera.review({ ...GOOD, actions: ['Take aspirin.', 'Rest.'] }, { factsList: '', situation: '' });
  assert.equal(v.verdict, 'revise');
  assert.equal(v.method, 'rules');
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------- Sol
const area = (over = {}) => ({ areaId: 'A1', place: 'Cuiabá, Brazil', ehf: { worst: { severity: 'none' } }, hiDays: [{ tier: 'caution' }], ...over });

test('Sol\'s evidence ceiling comes from the algorithm, and the model cannot exceed it or drop an area', () => {
  assert.equal(evidenceCeiling(area()), null);
  assert.equal(evidenceCeiling(area({ ehf: { worst: { severity: 'low-intensity' } } })), 'watch');
  assert.equal(evidenceCeiling(area({ hiDays: [{ tier: 'danger' }] })), 'warning');
  assert.equal(evidenceCeiling(area({ ehf: { worst: { severity: 'extreme' } } })), 'emergency');

  const candidates = [{ ...area(), ceiling: 'watch' }, { ...area({ areaId: 'A2', place: 'Dubai' }), ceiling: 'warning' }];
  const out = parseSentinelOutput(JSON.stringify({ briefing: 'Heat building.', events: [{ areaId: 'A1', level: 'emergency', trend: 'new', headline: 'x' }, { areaId: 'ZZ', level: 'watch' }] }), candidates);
  assert.equal(out.events.find((e) => e.areaId === 'A1').level, 'watch', 'clamped to the ceiling');
  assert.ok(out.events.some((e) => e.areaId === 'A2'), 'omitted candidate is still reported');
  assert.ok(!out.events.some((e) => e.areaId === 'ZZ'), 'unknown area ignored');
});

function sentinelWorld({ heatwave }) {
  const { db, tables } = createFakeDb();
  const store = createStore({ db, tables });
  const agentLog = createAgentLog({ db, table: tables.agentLog });
  const dates = Array.from({ length: 38 }, (_, i) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10));
  const today = dates[31];
  const weather = {
    getForecast: async () => (heatwave ? hot() : makeForecast({ nowHour: 9, temp: diurnal(15, 24), rh: () => 50 })),
    getDaily: async () => ({ dates, today, tmax: [...Array(31).fill(30), ...(heatwave ? [41, 42, 42, 40, 36, 33, 31] : Array(7).fill(30))], tmin: [...Array(31).fill(20), ...(heatwave ? [29, 30, 30, 28, 24, 22, 21] : Array(7).fill(20))] }),
  };
  const climate = { get: async () => ({ t95: 29, ehf85: 10, period: '1991-2020' }) };
  return { db, store, agentLog, weather, climate };
}

test('Sol: quiet weather needs no model call; a heatwave is investigated with tools and briefed; unchanged next hour', async () => {
  const quiet = sentinelWorld({ heatwave: false });
  await quiet.db.put({ table: 'locations', item: { locationId: 'l1', lat: 1, lon: 1, placeName: 'Town', profile: 'elderly' } });
  let calls = 0;
  const r1 = await runSentinel({ ...quiet, converse: async () => { calls += 1; return text('{}'); }, models: ['m'] });
  assert.equal(r1.outcome, 'quiet');
  assert.equal(calls, 0);

  const w = sentinelWorld({ heatwave: true });
  await w.db.put({ table: 'locations', item: { locationId: 'l1', lat: -15.6, lon: -56.1, placeName: 'Cuiabá, Brazil', profile: 'elderly' } });
  const replies = [toolUse('list_heat_signals'), text(JSON.stringify({ briefing: 'Extreme heat in Cuiabá through Thursday.', events: [{ areaId: 'A1', level: 'emergency', trend: 'new', headline: 'Extreme heatwave in Cuiabá', reason: 'EHF well above EHF85' }] }))];
  const r2 = await runSentinel({ ...w, converse: async () => replies.shift(), models: ['m'] });
  assert.equal(r2.outcome, 'briefed');
  const state = await w.agentLog.getState('sol', 'latest');
  assert.equal(state.events[0].place, 'Cuiabá, Brazil');
  assert.equal(state.events[0].level, 'emergency');

  const r3 = await runSentinel({ ...w, converse: async () => { throw new Error('should not be called'); }, models: ['m'] });
  assert.equal(r3.outcome, 'unchanged');
  assert.equal(buildAreas([{ lat: 1, lon: 1, placeName: 'X', profile: 'child' }])[0].vulnerable, 1);
});

// ---------------------------------------------------------------- Kai
test('Kai: urgency rises with risk, and EDF orders check-ins by absolute deadline across time zones', () => {
  const base = { gap: 0, hasWindow: true, soon: false, vulnerable: false, tropicalNight: false, noEmail: false };
  assert.ok(urgencyScore({ ...base, gap: 1 }) > urgencyScore(base));
  assert.ok(urgencyScore({ ...base, vulnerable: true }) > urgencyScore(base));
  assert.ok(urgencyScore({ ...base, gap: -1, hasWindow: false }) < 0.1);

  // Two members, same local clock time for their risky window, but UTC+4 comes 4 h earlier in absolute time.
  const f = makeForecast({ nowHour: 9, temp: diurnal(27, 38), rh: () => 55 });
  const east = { ...assessRisk({ ...f, utcOffsetSeconds: 4 * 3600 }, 'outdoor_worker') };
  const west = { ...assessRisk({ ...f, utcOffsetSeconds: 0 }, 'outdoor_worker') };
  const now = Date.parse(`${f.current.time}:00Z`) - 4 * 3600_000; // 09:15 in UTC+4
  const rows = buildCheckInSchedule([{ locationId: 'w', name: 'W', profile: 'outdoor_worker' }, { locationId: 'e', name: 'E', profile: 'outdoor_worker' }], [west, east], now);
  assert.deepEqual(rows.map((r) => r.locationId), ['e', 'w']);
  assert.deepEqual(rows.map((r) => r.ref), ['M1', 'M2']);
});

test('Kai: the model fills in words but cannot reorder or invent people', () => {
  const schedule = [{ ref: 'M1', order: 1, checkInBy: 'now', next12Tier: 'danger', alertTier: 'caution', riskyHours: 'now until 17:00' }, { ref: 'M2', order: 2, checkInBy: '12:00 their time', next12Tier: 'caution', alertTier: 'caution', riskyHours: '12:00 to 16:00' }];
  const out = parseCoordinatorOutput(JSON.stringify({ summary: 'Two people.', checkIns: [{ ref: 'M2', action: 'Call at 11:30.', reason: 'Older adult.' }, { ref: 'M9', action: 'x' }] }), schedule);
  assert.deepEqual(out.checkIns.map((c) => c.ref), ['M1', 'M2']);
  assert.equal(out.checkIns[1].action, 'Call at 11:30.');
  assert.equal(out.checkIns[0].writtenBy, 'template');
});

test('Kai end-to-end: group plan saved without names reaching the model', async () => {
  const { db, tables } = createFakeDb();
  const store = createStore({ db, tables });
  const agentLog = createAgentLog({ db, table: tables.agentLog });
  await db.put({ table: 'groups', item: { groupId: 'g1', name: 'Crew' } });
  await db.put({ table: 'locations', item: { locationId: 'l1', groupId: 'g1', name: 'Secret Name', lat: 1, lon: 1, placeName: 'Town', profile: 'elderly' } });
  const sent = [];
  const replies = [toolUse('get_checkin_schedule'), text(JSON.stringify({ summary: 'Check on M1 before noon.', checkIns: [{ ref: 'M1', action: 'Call before noon.', reason: 'Older adult alone.' }], teamNote: 'Water breaks.' }))];
  const res = await runCoordinator({ store, weather: { getForecast: async () => hot() }, agentLog, models: ['m'], converse: async (p) => { sent.push(JSON.stringify(p.messages)); return replies.shift(); } });
  assert.equal(res.outcome, 'planned');
  assert.ok(!sent.join('').includes('Secret Name'), 'member names never go to the model');
  const plan = await agentLog.getState('kai', 'group#g1');
  assert.equal(plan.checkIns[0].locationId, 'l1');
  assert.equal(plan.checkIns[0].action, 'Call before noon.');
});

// ---------------------------------------------------------------- Otto
test('Otto triage: site down beats everything; slow or overdue is degraded', () => {
  const ok = { id: 'site', ok: true, ms: 100 };
  assert.equal(triage({ probes: [ok], ewma: {}, heartbeats: [], errors: [], modelFailures: 0 }).status, 'healthy');
  assert.equal(triage({ probes: [{ ...ok, ok: false, status: 503 }], ewma: {}, heartbeats: [], errors: [], modelFailures: 0 }).status, 'down');
  const t = triage({ probes: [ok], ewma: { site: { anomaly: true, z: 5 } }, heartbeats: [{ agent: 'sol', overdue: true, everyMin: 60, minutesAgo: 200 }], errors: [], modelFailures: 2 });
  assert.equal(t.status, 'degraded');
  assert.deepEqual(t.issues.map((i) => i.code).sort(), ['primary_model_failing', 'site_slow', 'sol_overdue']);
});

test('Otto: healthy runs cost no model call; a new incident is investigated and published once', async () => {
  const { db, tables } = createFakeDb();
  const agentLog = createAgentLog({ db, table: tables.agentLog });
  const page = { site: 'HeatShield', health: '{"ok":true}', risk: '{"risk":{}}', agents: '{"agents":[]}', openmeteo: '{"current":{"temperature_2m":31}}' };
  const fetchImpl = async (url) => {
    const body = url.includes('open-meteo') ? page.openmeteo : url.endsWith('/') ? page.site : url.includes('health') ? page.health : url.includes('risk') ? page.risk : page.agents;
    return { status: 200, text: async () => body };
  };
  const logs = { count: async () => 0, sample: async () => [] };
  const published = [];
  let calls = 0;
  const deps = { fetchImpl, siteUrl: 'https://x.test', agentLog, logs, logGroups: { publicApi: 'g' }, models: ['m'], publish: async (s) => { published.push(s); } };
  const h = await runWatchdog({ ...deps, converse: async () => { calls += 1; return text('{}'); } });
  assert.equal(h.outcome, 'healthy');
  assert.equal(calls, 0);

  logs.count = async (_g, pattern) => (pattern.includes('bedrock_guidance_failed') ? 3 : 0);
  const incident = { severity: 'low', title: 'Primary model failing', summary: 'Claude calls fail; Nova serving.', likelyCause: 'Use-case form not submitted', evidence: ['3 failures'], recommendedAction: 'Submit the Anthropic use-case form.' };
  const replies = [toolUse('get_triage'), text(JSON.stringify(incident))];
  const d = await runWatchdog({ ...deps, converse: async () => { calls += 1; return replies.shift(); } });
  assert.equal(d.outcome, 'degraded-reported');
  assert.equal(published.length, 1);
  const again = await runWatchdog({ ...deps, converse: async () => { throw new Error('should not re-investigate'); } });
  assert.equal(again.outcome, 'degraded-ongoing');
  assert.equal(published.length, 1);
});

// ---------------------------------------------------------------- console API
test('agents API: status from latest runs, next-run countdowns, review stats', async () => {
  const { db, tables } = createFakeDb();
  let now = Date.parse('2026-09-29T10:02:00Z');
  const agentLog = createAgentLog({ db, table: tables.agentLog, nowMs: () => now });
  await agentLog.recordRun('otto', { outcome: 'healthy', summary: 'ok' });
  await agentLog.recordRun('lexi', { outcome: 'approve', summary: 'ok', detail: { verdict: 'approve', language: 'ar' } });
  await agentLog.recordRun('kai', { outcome: 'error', summary: 'boom' });
  now += 30_000;
  const api = createAgentsApi({ agentLog, nowMs: () => now });
  const out = await api.get();
  const by = Object.fromEntries(out.agents.map((a) => [a.id, a]));
  assert.equal(by.otto.status, 'working');
  assert.equal(by.kai.status, 'error');
  assert.equal(by.sol.status, 'waiting');
  assert.equal(by.sol.nextRunAt, '2026-09-29T10:05:00.000Z');
  assert.equal(by.otto.nextRunAt, '2026-09-29T10:15:00.000Z');
  assert.equal(by.kai.nextRunAt, '2026-09-29T12:15:00.000Z');
  assert.equal(out.reviewStats24h.approved, 1);
  assert.equal(nextRunAt(null, now), null);
});
