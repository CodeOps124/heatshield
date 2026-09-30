/**
 * Regression tests for problems observed in the agents' first night live on AWS
 * (2026-09-28 20:31 UTC → 2026-09-29 10:30 UTC). Each test names the real event it covers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, extractJson } from '../functions/lib/agent-runtime.mjs';
import { createAgentLog } from '../functions/lib/agent-log.mjs';
import { createGuidanceService } from '../functions/lib/guidance.mjs';
import { parseLanguageReview } from '../functions/lib/agents/language-reviewer.mjs';
import { parseSafetyReview, createSafetyReviewer, evidenceInMessage, namesEmergencyNumber } from '../functions/lib/agents/safety-reviewer.mjs';
import { runSentinel, headlineFor } from '../functions/lib/agents/sentinel.mjs';
import { runCoordinator } from '../functions/lib/agents/coordinator.mjs';
import { triage, runWatchdog } from '../functions/lib/agents/watchdog.mjs';
import { createLogsReader } from '../functions/lib/logs-reader.mjs';
import { runAlertCheck } from '../functions/lib/alert-runner.mjs';
import { createEnrollmentApi } from '../functions/lib/enrollment-routes.mjs';
import { createStore } from '../functions/lib/store.mjs';
import { assessRisk } from '../functions/lib/heat.mjs';
import { createWeatherClient, UpstreamError } from '../functions/lib/weather.mjs';
import { createFakeDb, makeForecast, diurnal, silentLog, apiEvent, parse } from './helpers.mjs';
import { parseJsonLoose } from '../functions/lib/util.mjs';

const text = (t) => ({ stopReason: 'end_turn', output: { message: { role: 'assistant', content: [{ text: t }] } }, usage: { inputTokens: 10, outputTokens: 5 } });
const hot = () => makeForecast({ nowHour: 9, temp: diurnal(27, 38), rh: () => 55 });
const GOOD = { headline: 'Dangerous heat this afternoon.', actions: ['Start work early.', 'Rest in shade at 13:00.', 'Drink water often.'], seekHelp: 'If confused, call your local emergency number.' };
const memCache = () => { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, put: async (e) => { m.set(e.cacheKey, e); } }; };

test('Sol 04:05 UTC: malformed JSON from the model gets one repair turn instead of failing the run', async () => {
  const replies = [text('{"briefing":"x","events":[{"a":1} {"b":2}]}'), text('{"ok":true}')];
  const seen = [];
  const res = await runAgent({
    agent: { name: 't', models: ['m'], system: 's' },
    input: 'go',
    converse: async (p) => { seen.push(p.messages.at(-1).content[0].text ?? ''); return replies.shift(); },
    validate: (t) => { const v = extractJson(t); if (!v.ok) throw new Error('missing ok'); return v; },
  });
  assert.equal(res.value.ok, true);
  assert.equal(res.repaired, 1);
  assert.match(seen[1], /could not be used: .*Reply again with ONLY the corrected JSON/);
  await assert.rejects(runAgent({
    agent: { name: 't', models: ['m'], system: 's' },
    input: 'go',
    converse: async () => text('not json at all'),
    validate: extractJson,
  }), /failed validation/);
});

test('Lexi 02:00 UTC: style notes never block; wrong words and grammar do', () => {
  const bt = { headline: 'h', actions: ['a'], seekHelp: 's' };
  const style = parseLanguageReview(JSON.stringify({ backTranslation: bt, verdict: 'revise', issues: [{ quote: 'Heat will rise', category: 'style', problem: 'Could say "heat risk"' }] }));
  assert.equal(style.verdict, 'approve', 'a model "revise" over style alone is overruled by code');
  assert.equal(style.issues[0].severity, 'minor');
  const word = parseLanguageReview(JSON.stringify({ backTranslation: bt, verdict: 'approve', issues: [{ quote: 'জরা', category: 'word', problem: 'means "old age", not heat' }] }));
  assert.equal(word.verdict, 'revise');
  const unknown = parseLanguageReview(JSON.stringify({ backTranslation: bt, issues: [{ category: 'vibes', problem: 'meh' }] }));
  assert.equal(unknown.issues[0].category, 'style');
  assert.throws(() => parseLanguageReview('{"issues":[]}'), /backTranslation/);
});

test('Lexi 11:40 UTC: 22 of 24 blocking issues were "fact" (today\'s peak read as the risk now); fact notes are now optional for Mira', () => {
  const bt = { headline: 'h', actions: ['a'], seekHelp: 's' };
  const r = parseLanguageReview(JSON.stringify({ backTranslation: bt, issues: [
    { quote: 'گرمی میں شدید احتیاط', category: 'fact', problem: "The current heat risk is 'Caution', not 'Extreme Caution'." },
    { quote: 'تھڑی', category: 'word', problem: 'Not a correct Urdu word; the word for midday is دوپہر.' },
  ] }));
  assert.equal(r.issues[0].category, 'fact');
  assert.equal(r.issues[0].severity, 'minor', 'kept as a suggestion for Mira');
  assert.equal(r.issues[1].severity, 'blocking');
  assert.equal(r.verdict, 'revise', 'a wrong word still blocks');
  const factOnly = parseLanguageReview(JSON.stringify({ backTranslation: bt, issues: [{ quote: 'x', category: 'fact', problem: 'Should say Danger, not high.' }] }));
  assert.equal(factOnly.verdict, 'approve');
});

test('Vera 02:00 UTC: "a cup every 15 minutes" style variations pass; broken limits and missing emergency advice block', () => {
  assert.equal(parseSafetyReview('{"issues":[{"rule":"e","problem":"a bit alarmist"}]}').verdict, 'approve');
  assert.equal(parseSafetyReview('{"issues":[]}').verdict, 'approve');
  assert.equal(parseSafetyReview('{"issues":[{"rule":"b","problem":"says 3 litres per hour"}]}').verdict, 'revise');
  assert.equal(parseSafetyReview('{"issues":[{"rule":"d","problem":"no emergency number"}]}').verdict, 'revise');
  assert.equal(parseSafetyReview('{"issues":[{"rule":"zz","problem":"?"}]}').issues[0].severity, 'minor');
  assert.throws(() => parseSafetyReview('{"verdict":"approve"}'), /issues array/);
});

test('Mira gets up to two revision rounds, with minor notes marked optional', async () => {
  const prompts = [];
  const verdicts = ['revise', 'revise', 'approve'];
  const reviewers = {
    language: {
      review: async () => {
        const v = verdicts.shift();
        return { verdict: v, issues: v === 'revise' ? [{ problem: 'wrong word', severity: 'blocking' }, { problem: 'could be warmer', severity: 'minor' }] : [] };
      },
    },
    safety: { review: async () => ({ verdict: 'approve', issues: [] }) },
  };
  const svc = createGuidanceService({
    converse: async (p) => { prompts.push(p.messages[0].content[0].text); return text(JSON.stringify(GOOD)); },
    cache: memCache(), models: ['w'], log: silentLog, reviewers,
  });
  const g = await svc.getGuidance(assessRisk(hot(), 'general'), 'en');
  assert.equal(g.review.status, 'approved');
  assert.equal(g.review.revisions, 2);
  assert.equal(prompts.length, 3);
  assert.match(prompts[1], /You MUST fix:\n- wrong word\nOptional suggestions[^\n]*\n- could be warmer/);
});

test('Otto 06:00 UTC: a slow risk probe is attributed upstream when Open-Meteo is slow too', () => {
  const probes = [{ id: 'site', ok: true, ms: 100 }, { id: 'risk', ok: true, ms: 6000 }, { id: 'openmeteo', ok: true, ms: 5000 }];
  const both = triage({ probes, ewma: { risk: { anomaly: true, z: 6 }, openmeteo: { anomaly: true, z: 7 } }, heartbeats: [], errors: [], modelFailures: 0 });
  assert.deepEqual(both.issues.map((i) => i.code), ['upstream_slow']);
  const ours = triage({ probes, ewma: { risk: { anomaly: true, z: 6 } }, heartbeats: [], errors: [], modelFailures: 0 });
  assert.deepEqual(ours.issues.map((i) => i.code), ['risk_slow']);
  const down = triage({ probes: [{ id: 'site', ok: true, ms: 100 }, { id: 'openmeteo', ok: false, status: 503, ms: 50 }], ewma: {}, heartbeats: [], errors: [], modelFailures: 0 });
  assert.equal(down.status, 'degraded');
  assert.equal(down.issues[0].code, 'upstream_failing');
});

test('Otto 02:15 UTC: primary-model failures are counted in BOTH functions that generate guidance', async () => {
  const { db, tables } = createFakeDb();
  const agentLog = createAgentLog({ db, table: tables.agentLog });
  const counted = [];
  const logs = {
    count: async (group, pattern) => { if (pattern.includes('bedrock_guidance_failed')) counted.push(group); return 0; },
    sample: async () => [],
  };
  const fetchImpl = async (url) => ({ status: 200, text: async () => (url.includes('open-meteo') ? 'temperature_2m' : 'HeatShield "ok":true "risk" "agents"') });
  await runWatchdog({ fetchImpl, siteUrl: 'https://x.test', agentLog, logs, logGroups: { publicApi: 'P', enrollmentApi: 'E', alertCheck: 'A' }, models: ['m'], converse: async () => text('{}') });
  assert.deepEqual(counted.sort(), ['A', 'P']);
});

test('Sol first runs: an area whose climatology is not downloaded yet is judged on heat index alone', async () => {
  const { db, tables } = createFakeDb();
  const store = createStore({ db, tables });
  const agentLog = createAgentLog({ db, table: tables.agentLog });
  await db.put({ table: 'locations', item: { locationId: 'l1', lat: 25.2, lon: 55.27, placeName: 'Dubai', profile: 'outdoor_worker' } });
  const dates = Array.from({ length: 38 }, (_, i) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10));
  const weather = {
    getForecast: async () => hot(),
    getDaily: async () => ({ dates, today: dates[31], tmax: Array(38).fill(38), tmin: Array(38).fill(29) }),
  };
  const replies = [text(JSON.stringify({ briefing: 'Dangerous heat and humidity in Dubai.', events: [{ areaId: 'A1', level: 'warning', trend: 'new', headline: 'Dubai' }] }))];
  const r = await runSentinel({ store, weather, climate: { get: async () => null }, agentLog, converse: async () => replies.shift(), models: ['m'] });
  assert.equal(r.outcome, 'briefed');
  const state = await agentLog.getState('sol', 'latest');
  assert.equal(state.areas[0].climatePending, true);
  assert.equal(state.events[0].level, 'warning');
});

test('Sol 10:05 UTC: an unchanged briefing is still rewritten after 6 hours (each re-check used to reset its age)', async () => {
  const { db, tables } = createFakeDb();
  const store = createStore({ db, tables });
  let now = Date.parse('2026-09-29T04:05:00Z');
  const nowMs = () => now;
  const agentLog = createAgentLog({ db, table: tables.agentLog, nowMs });
  await db.put({ table: 'locations', item: { locationId: 'l1', lat: 25.2, lon: 55.27, placeName: 'Dubai', profile: 'outdoor_worker' } });
  const dates = Array.from({ length: 38 }, (_, i) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10));
  const weather = {
    getForecast: async () => hot(),
    getDaily: async () => ({ dates, today: dates[31], tmax: Array(38).fill(38), tmin: Array(38).fill(29) }),
  };
  let calls = 0;
  const converse = async () => {
    calls += 1;
    return text(JSON.stringify({ briefing: `Briefing ${calls}.`, events: [{ areaId: 'A1', level: 'warning', trend: 'steady', headline: 'Dubai' }] }));
  };
  const run = () => runSentinel({ store, weather, climate: { get: async () => null }, agentLog, converse, models: ['m'], nowMs });
  assert.equal((await run()).outcome, 'briefed');
  let last;
  for (let hour = 1; hour <= 5; hour += 1) {
    now += 3600_000;
    last = await run();
    assert.equal(last.outcome, 'unchanged');
  }
  assert.match(last.summary, /unchanged since the 04:05 UTC briefing/);
  now += 3600_000;
  assert.equal((await run()).outcome, 'briefed', 'six hours after the briefing, Sol writes a fresh one');
  assert.equal(calls, 2);
  assert.equal((await agentLog.getState('sol', 'latest')).briefedAt, '2026-09-29T10:05:00.000Z');
});

test('Mira 02:00 UTC: activity lines read "an English plan", not "a English plan"', async () => {
  const { db, tables } = createFakeDb();
  const agentLog = createAgentLog({ db, table: tables.agentLog });
  const svc = createGuidanceService({ converse: async () => text(JSON.stringify(GOOD)), cache: memCache(), models: ['w'], log: silentLog, agentLog });
  await svc.getGuidance(assessRisk(hot(), 'general'), 'en');
  await svc.getGuidance(assessRisk(hot(), 'general'), 'es');
  const summaries = (await agentLog.listRuns('mira')).map((r) => r.summary);
  assert.ok(summaries.some((x) => x.startsWith('Wrote an English plan')), summaries.join(' | '));
  assert.ok(summaries.some((x) => x.startsWith('Wrote a Spanish plan')), summaries.join(' | '));
});

test('Sol 11:05 UTC: Open-Meteo answered 429 for 2 of 10 areas; the weather client now retries a 429 once, but not a 400', async () => {
  const replies = [{ ok: false, status: 429 }, { ok: true, status: 200, json: async () => ({ daily: { time: ['2026-09-29'], temperature_2m_max: [40], temperature_2m_min: [30] } }) }];
  const calls = [];
  const weather = createWeatherClient({ fetchImpl: async (url) => { calls.push(url); return replies.shift(); }, retryDelayMs: 0 });
  const daily = await weather.getDaily(25.2, 55.27);
  assert.equal(calls.length, 2);
  assert.deepEqual(daily.tmax, [40]);

  let badCalls = 0;
  const strict = createWeatherClient({ fetchImpl: async () => { badCalls += 1; return { ok: false, status: 400 }; }, retryDelayMs: 0 });
  await assert.rejects(strict.getDaily(1, 1), /HTTP 400/);
  assert.equal(badCalls, 1, 'a bad request is not retried');
});

function refusalWorld() {
  const { db, tables } = createFakeDb();
  const store = createStore({ db, tables });
  let now = Date.parse('2026-09-29T10:05:00Z');
  const clock = { nowMs: () => now, advance: (ms) => { now += ms; } };
  const agentLog = createAgentLog({ db, table: tables.agentLog, nowMs: clock.nowMs });
  const dates = Array.from({ length: 38 }, (_, i) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10));
  const refused = new Set();
  const refuse = (lat) => { if (refused.has(lat)) throw new UpstreamError('Open-Meteo HTTP 429', { status: 429 }); };
  const weather = {
    getForecast: async (lat) => { refuse(lat); return lat > 20 ? hot() : makeForecast({ nowHour: 9, temp: diurnal(15, 24), rh: () => 50 }); },
    getDaily: async (lat) => { refuse(lat); return { dates, today: dates[31], tmax: Array(38).fill(lat > 20 ? 38 : 24), tmin: Array(38).fill(lat > 20 ? 29 : 14) }; },
  };
  return { db, store, agentLog, weather, clock, refused };
}

test('Sol 11:05 UTC: an area refused twice keeps its last good data (marked stale) and its heat event stays', async () => {
  const w = refusalWorld();
  await w.db.put({ table: 'locations', item: { locationId: 'l1', lat: 23.81, lon: 90.41, placeName: 'Dhaka, Bangladesh', profile: 'elderly' } });
  await w.db.put({ table: 'locations', item: { locationId: 'l2', lat: 14.6, lon: 120.98, placeName: 'Manila, Philippines', profile: 'child' } });
  let modelCalls = 0;
  const converse = async () => {
    modelCalls += 1;
    return text(JSON.stringify({ briefing: 'Dangerous heat and humidity in Dhaka.', events: [{ areaId: 'A1', level: 'warning', trend: 'new', headline: 'Dhaka' }] }));
  };
  const run = () => runSentinel({ store: w.store, weather: w.weather, climate: { get: async () => null }, agentLog: w.agentLog, converse, models: ['m'], nowMs: w.clock.nowMs, retryPauseMs: 0 });
  assert.equal((await run()).outcome, 'briefed');

  // Next hour Open-Meteo refuses Dhaka (the area with the heat event) on both tries.
  w.clock.advance(3600_000);
  w.refused.add(23.81);
  const r = await run();
  assert.equal(r.outcome, 'partial', 'the heat event stays; no model call is needed to say so');
  assert.match(r.summary, /Scanned 1 areas \(1 more kept from earlier data\)/);
  assert.equal(modelCalls, 1);
  const state = await w.agentLog.getState('sol', 'latest');
  assert.equal(state.areas.length, 2, 'the board keeps both areas');
  const dhaka = state.areas.find((a) => a.place === 'Dhaka, Bangladesh');
  assert.equal(dhaka.stale, true);
  assert.equal(dhaka.asOf, '2026-09-29T10:05:00.000Z');
  assert.equal(state.events[0].place, 'Dhaka, Bangladesh');
  assert.equal(state.events[0].stale, true);
  assert.equal(state.failures[0].message, 'Open-Meteo HTTP 429');
  assert.match(state.briefing, /forecast for Dhaka could not be refreshed/);
  w.clock.advance(3600_000);
  assert.equal((await run()).outcome, 'unchanged', 'still refused next hour: no new briefing, no flapping');

  // Fresh data again: Sol writes a new briefing, so the "could not be refreshed" text goes away.
  w.clock.advance(3600_000);
  w.refused.delete(23.81);
  assert.equal((await run()).outcome, 'briefed');
  assert.equal(modelCalls, 2);
  const fresh = await w.agentLog.getState('sol', 'latest');
  assert.equal(fresh.events[0].stale, undefined);
  assert.ok(!fresh.areas.some((x) => x.stale));
  assert.doesNotMatch(fresh.briefing, /could not be refreshed/);
  w.refused.add(23.81);

  // After 3 hours without fresh data, the area is no longer shown as if we knew.
  w.clock.advance(3 * 3600_000);
  await run();
  const later = await w.agentLog.getState('sol', 'latest');
  assert.ok(!later.areas.some((a) => a.place === 'Dhaka, Bangladesh'));
  assert.ok(!later.events.some((e) => e.place === 'Dhaka, Bangladesh'));
});

test('Sol: an area refused once is retried after a pause and counts as fresh', async () => {
  const w = refusalWorld();
  await w.db.put({ table: 'locations', item: { locationId: 'l1', lat: 14.6, lon: 120.98, placeName: 'Manila, Philippines', profile: 'child' } });
  let refusals = 0;
  const weather = {
    ...w.weather,
    getDaily: async (lat) => {
      if (refusals === 0) { refusals += 1; throw new UpstreamError('Open-Meteo HTTP 429', { status: 429 }); }
      return w.weather.getDaily(lat);
    },
  };
  const r = await runSentinel({ store: w.store, weather, climate: { get: async () => null }, agentLog: w.agentLog, converse: async () => { throw new Error('quiet: no model call'); }, models: ['m'], nowMs: w.clock.nowMs, retryPauseMs: 0 });
  assert.equal(r.outcome, 'quiet');
  const state = await w.agentLog.getState('sol', 'latest');
  assert.deepEqual(state.failures, []);
  assert.equal(state.areas[0].stale, undefined);
});

test('Sol 11:30 UTC: a headline claimed dangerous heat in Cuiabá on Thursday (forecast: one tier lower); headlines now come from the numbers', () => {
  const tiers = (list) => list.map(([date, tier]) => ({ date, tier }));
  const cuiaba = {
    place: 'Cuiabá, Brazil',
    hiDays: tiers([['2026-09-29', 'extreme_caution'], ['2026-09-30', 'danger'], ['2026-10-01', 'extreme_caution'], ['2026-10-02', 'extreme_caution']]),
    ehf: { worst: { severity: 'low-intensity' }, days: [{ date: '2026-09-29', severity: 'low-intensity' }, { date: '2026-09-30', severity: 'none' }] },
  };
  assert.equal(headlineFor(cuiaba), 'Cuiabá: dangerous heat and humidity on Wednesday; hotter than usual for this time of year on Tuesday');
  const dubai = { place: 'Dubai, United Arab Emirates', hiDays: tiers([['2026-09-29', 'danger'], ['2026-09-30', 'danger'], ['2026-10-01', 'danger'], ['2026-10-02', 'danger']]), ehf: { worst: { severity: 'none' }, days: [] } };
  assert.equal(headlineFor(dubai), 'Dubai: dangerous heat and humidity from Tuesday to Friday');
  const hcmc = { place: 'Ho Chi Minh City, Vietnam', hiDays: tiers([['2026-09-29', 'extreme_caution'], ['2026-09-30', 'danger'], ['2026-10-01', 'extreme_danger']]), ehf: null };
  assert.equal(headlineFor(hcmc), 'Ho Chi Minh City: extremely dangerous heat and humidity on Thursday');
  const split = { place: 'Karachi', hiDays: tiers([['2026-09-29', 'danger'], ['2026-09-30', 'caution'], ['2026-10-01', 'danger']]), ehf: null };
  assert.equal(headlineFor(split), 'Karachi: dangerous heat and humidity on Tuesday and Thursday');
});

test('Otto 11:36 UTC: a model that is not enabled on the account is a setup note, not "degraded"; real failures still degrade', async () => {
  const probes = [{ id: 'site', ok: true, ms: 300 }];
  const setup = triage({ probes, ewma: {}, heartbeats: [], errors: [], modelFailures: 1, modelSetup: { reason: 'ResourceNotFoundException: Model use case details have not been submitted' } });
  assert.equal(setup.status, 'healthy');
  assert.equal(setup.issues[0].code, 'primary_model_not_enabled');
  assert.match(setup.issues[0].detail, /use case details have not been submitted/);

  const { db, tables } = createFakeDb();
  const agentLog = createAgentLog({ db, table: tables.agentLog });
  const fetchImpl = async (url) => ({ status: 200, text: async () => (url.includes('open-meteo') ? '{"current":{"temperature_2m":31}}' : url.includes('health') ? '{"ok":true}' : url.includes('risk') ? '{"risk":{}}' : url.includes('agents') ? '{"agents":[]}' : 'HeatShield') });
  const line = (error, message) => ({ at: '2026-09-29T11:30:00Z', line: JSON.stringify({ level: 'warn', msg: 'bedrock_guidance_failed', modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', error, message }) });
  let sampled = [line('ResourceNotFoundException', 'Model use case details have not been submitted for this account.')];
  const logs = { count: async (_g, pattern) => (pattern.includes('bedrock_guidance_failed') ? 1 : 0), sample: async () => sampled };
  const deps = { fetchImpl, siteUrl: 'https://x.test', agentLog, logs, logGroups: { publicApi: 'g' }, models: ['m'], publish: async () => {} };
  const ok = await runWatchdog({ ...deps, converse: async () => { throw new Error('no incident, no model call'); } });
  assert.equal(ok.outcome, 'healthy');
  assert.match(ok.summary, /primary model is not enabled on the account yet/);

  sampled = [line('ThrottlingException', 'Too many requests, please wait before trying again.')];
  const incident = { severity: 'low', title: 'Primary model throttled', summary: 'Throttled; fallback serving.', likelyCause: 'Bedrock throttling', evidence: ['1 failure'], recommendedAction: 'Watch the rate.' };
  const replies = [text(JSON.stringify(incident))];
  const bad = await runWatchdog({ ...deps, converse: async () => replies.shift() });
  assert.equal(bad.outcome, 'degraded-reported');
});

test('Otto 30 Sep 05:37 UTC: an empty first page of log results made a known setup state look like a failing model', async () => {
  // FilterLogEvents searches stream by stream; a page can be empty while more events exist.
  const raw = (ms) => ({ timestamp: ms, message: `2026-09-30T05:36:51.229Z	req	WARN	${JSON.stringify({ level: 'warn', msg: 'bedrock_guidance_failed', modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', error: 'ResourceNotFoundException', message: 'Model use case details have not been submitted for this account. Fill out the Anthropic use case details form before using the model.' })}
` });
  const pages = [{ events: [], nextToken: 't1' }, { events: [raw(Date.parse('2026-09-30T05:36:53Z')), raw(Date.parse('2026-09-30T05:36:51Z'))], nextToken: 't2' }, { events: [] }];
  const filterCalls = [];
  const logs = createLogsReader({
    filterLogEvents: async (params) => { filterCalls.push(params.nextToken ?? null); return params.filterPattern.includes('bedrock_guidance_failed') ? pages[params.nextToken ? Number(params.nextToken.slice(1)) : 0] : { events: [] }; },
    describeLogGroups: async () => ({ logGroups: [] }),
  });
  const lines = await logs.sample('g', '"bedrock_guidance_failed"', 0, 3);
  assert.equal(lines.length, 2, 'the events on page 2 are read');
  assert.ok(lines[0].at < lines[1].at, 'oldest first, most recent last');
  assert.deepEqual(filterCalls, [null, 't1', 't2']);
  assert.equal(await logs.count('g', '"bedrock_guidance_failed"', 0), 2);
  assert.doesNotMatch(lines[0].line, /req|WARN/, 'only the structured fields are kept');

  const { db, tables } = createFakeDb();
  const agentLog = createAgentLog({ db, table: tables.agentLog });
  const fetchImpl = async (url) => ({ status: 200, text: async () => (url.includes('open-meteo') ? '{"current":{"temperature_2m":31}}' : url.includes('health') ? '{"ok":true}' : url.includes('risk') ? '{"risk":{}}' : url.includes('agents') ? '{"agents":[]}' : 'HeatShield') });
  const r = await runWatchdog({ fetchImpl, siteUrl: 'https://x.test', agentLog, logs, logGroups: { publicApi: 'g' }, models: ['m'], publish: async () => {}, converse: async () => { throw new Error('a setup state needs no model call'); } });
  assert.equal(r.outcome, 'healthy');
  assert.match(r.summary, /primary model is not enabled on the account yet/);
});

test('Mira 11:55 UTC: a runaway Swahili reply hit the token limit; the writer now takes one more sample before giving up', async () => {
  const calls = [];
  const replies = [
    { stopReason: 'max_tokens', output: { message: { role: 'assistant', content: [{ text: '{"headline":"Joto kali leo. Joto kali leo. Joto kali leo.' }] } }, usage: { inputTokens: 10, outputTokens: 1500 } },
    text(JSON.stringify(GOOD)),
  ];
  const svc = createGuidanceService({ converse: async (p) => { calls.push(p.modelId); return replies.shift(); }, cache: memCache(), models: ['nova'], log: silentLog });
  const g = await svc.getGuidance(assessRisk(hot(), 'general'), 'en');
  assert.equal(g.source, 'bedrock');
  assert.deepEqual(calls, ['nova', 'nova']);

  // "Not enabled" is not retried on the same model: it moves on to the next one.
  const seen = [];
  const denied = Object.assign(new Error('Model use case details have not been submitted'), { name: 'ResourceNotFoundException' });
  const svc2 = createGuidanceService({
    converse: async (p) => { seen.push(p.modelId); if (p.modelId === 'claude') throw denied; return text(JSON.stringify(GOOD)); },
    cache: memCache(), models: ['claude', 'nova'], log: silentLog,
  });
  assert.equal((await svc2.getGuidance(assessRisk(hot(), 'general'), 'en')).source, 'bedrock');
  assert.deepEqual(seen, ['claude', 'nova']);
});

test('Mira 11:58 UTC: Chinese replies with a raw line break in a string or a trailing comma still parse', () => {
  const raw = '{"headline":"今天很热。","actions":["早上工作。\n中午休息。","多喝水。","待在阴凉处。",],"seekHelp":"如果头晕，请拨打当地急救电话。"}';
  const g = parseJsonLoose(raw);
  assert.equal(g.actions.length, 3);
  assert.equal(g.actions[0], '早上工作。\n中午休息。');
  assert.throws(() => parseJsonLoose('{"headline": }'), SyntaxError);
  assert.deepEqual(extractJson('Sure! {"ok": [1, 2,],}'), { ok: [1, 2] });
});

test('Vera 11:58 UTC: the judge sees the whole vetted library, not only the facts retrieved for the writer', async () => {
  let seen = '';
  const reviewers = {
    language: { review: async () => ({ verdict: 'approve', issues: [] }) },
    safety: { review: async (_g, ctx) => { seen = ctx.factsList; return { verdict: 'approve', issues: [] }; } },
  };
  const svc = createGuidanceService({ converse: async () => text(JSON.stringify(GOOD)), cache: memCache(), models: ['w'], log: silentLog, reviewers });
  await svc.getGuidance(assessRisk(hot(), 'general'), 'en');
  assert.match(seen, /one cup \(240 ml\) of water every 15 to 20 minutes/);
  assert.match(seen, /Cool showers or baths help lower body temperature/);
});

test('Reviewers 12:05 UTC: the objections from three live evaluations, sorted into real errors and notes', () => {
  const bt = { headline: 'h', actions: ['a'], seekHelp: 's' };
  const lexi = (category, problem) => parseLanguageReview(JSON.stringify({ backTranslation: bt, issues: [{ quote: 'q', category, problem }] })).issues[0].severity;
  // Real errors: still block.
  assert.equal(lexi('word', "'kichocho' is not a real Swahili word for 'dizzy'."), 'blocking');
  assert.equal(lexi('word', "'Lome' is not a real Spanish word. It seems to be a typo for 'Tome'."), 'blocking');
  assert.equal(lexi('word', "'تھنڈے' is misspelled; it should be 'ٹھنڈے'."), 'blocking');
  assert.equal(lexi('word', 'Not a real Hindi word; likely a misspelling or invented term. Meaning unclear.'), 'blocking');
  // Wording: notes for Mira.
  assert.equal(lexi('word', "'Extrême Prudence' is not a correct term for the heat risk level. It should be 'Extrême Caution'."), 'minor');
  assert.equal(lexi('word', "'Cảnh báo cực kỳ' is not a standard term for heat levels."), 'minor');
  assert.equal(lexi('grammar', "The phrase 'se você tiver' is awkward and unclear."), 'minor');
  assert.equal(lexi('word', "'joto kupita kiasi mwilini' is not idiomatic. A more natural phrasing would be 'joto kali mwilini'."), 'minor');
  assert.equal(lexi('word', "Repeated word 'tirai' (curtains)."), 'minor');

  const vera = (rule, problem) => parseSafetyReview(JSON.stringify({ issues: [{ quote: 'q', rule, problem }] })).issues[0].severity;
  assert.equal(vera('b', 'The message does not specify the amount of water to drink, which could lead to overhydration.'), 'minor');
  assert.equal(vera('d', 'The message does not explicitly instruct to call the local emergency number for heat-stroke signs.'), 'blocking');
  assert.equal(vera('b', 'Advising the use of a fan as a primary cooling method during very hot conditions is against the safety guidelines.'), 'blocking');
  assert.equal(vera('c', 'Recommends a hot bath to relax.'), 'blocking');
});

test('Vera 12:24 UTC: a harm objection must survive a second reading that points at the exact words', async () => {
  const plan = {
    headline: 'حرارة خطيرة اليوم.',
    actions: ['قلل العمل البدني حتى الساعة 03:00 من الغد.', 'اشرب كوبًا من الماء كل 15 إلى 20 دقيقة.', 'احتفظ بمنطقة النوم باردة قدر الإمكان، وارتدِ ملابس خفيفة.'],
    seekHelp: 'إذا شعرت بالارتباك أو الإغماء، اتصل برقم الطوارئ المحلي.',
  };
  assert.equal(evidenceInMessage('«احتفظ بمنطقة النوم باردة قدر الإمكان»', plan), true, 'punctuation and quotes do not matter');
  assert.equal(evidenceInMessage('وارتد ملابس خفيفة', plan), true, 'a copy without the kasra still matches');
  assert.equal(evidenceInMessage('استخدم الماء البارد', plan), false);

  const objection = { quote: 'احتفظ بمنطقة النوم باردة قدر الإمكان', rule: 'c', problem: 'Cold water as the main cooling can lower body temperature too quickly.' };
  const run = (verdict) => {
    const replies = [text(JSON.stringify({ issues: [objection] })), text(JSON.stringify({ verdicts: [verdict] }))];
    return createSafetyReviewer({ converse: async () => replies.shift(), models: ['m'] }).review(plan, { factsList: '- x', situation: '- y', deadline: Date.now() + 20_000 });
  };
  const hallucinated = await run({ id: 1, confirmed: false, evidence: '' });
  assert.equal(hallucinated.verdict, 'approve');
  assert.match(hallucinated.issues[0].problem, /not confirmed on a second reading/);
  const inventedEvidence = await run({ id: 1, confirmed: true, evidence: 'استخدم الماء البارد للتبريد' });
  assert.equal(inventedEvidence.verdict, 'approve', 'evidence that is not in the message does not count');
  const real = await run({ id: 1, confirmed: true, evidence: 'احتفظ بمنطقة النوم باردة قدر الإمكان' });
  assert.equal(real.verdict, 'revise', 'a confirmed objection with real evidence still blocks');

  const broken = [text(JSON.stringify({ issues: [objection] })), text('no json here'), text('still none')];
  const unsure = await createSafetyReviewer({ converse: async () => broken.shift(), models: ['m'] }).review(plan, { factsList: '- x', situation: '- y', deadline: Date.now() + 20_000 });
  assert.equal(unsure.verdict, 'revise', 'if the second reading fails, the objection stands');
});

test('Vera and Lexi 30 Sep 06:05 UTC: a correct Arabic plan went to the fallback over objections the message itself refutes', async () => {
  const plan = {
    headline: 'الحرارة مرتفعة اليوم، يجب أن تكون حذراً للغاية.',
    actions: ['استرح في مكان مظلل كل 5-10 دقائق أثناء العمل.', 'اشرب كوباً من الماء كل 15 إلى 20 دقيقة.', 'حافظ على برودة غرفة النوم قدر الإمكان.'],
    seekHelp: 'إذا شعرت بالارتباك أو الإغماء أو لاحظت أي علامات أخرى للسكتة الدماغية الحرارية، اتصل برقم الطوارئ المحلي الخاص بك على الفور.',
  };
  const review = (message, issues) => createSafetyReviewer({ converse: async () => text(JSON.stringify({ issues })), models: ['m'] })
    .review(message, { factsList: '- x', situation: '- y', deadline: Date.now() + 20_000, language: 'ar' });

  // The final objection proposed the sentence as written as its own fix.
  const same = await review(plan, [{ quote: plan.seekHelp, rule: 'd', problem: 'The text should ask people to call the local emergency number if they notice heat-stroke signs.', fix: plan.seekHelp }]);
  assert.equal(same.verdict, 'approve');
  assert.match(same.issues[0].problem, /the suggested fix is the text as written/);

  // The one before: "should also list other signs", while the help sentence names the emergency number.
  const shorter = { ...plan, seekHelp: 'إذا شعرت بالارتباك أو الإغماء، اتصل برقم الطوارئ المحلي الخاص بك على الفور.' };
  const more = await review(shorter, [{ quote: shorter.seekHelp, rule: 'd', problem: 'The text should also include other heat-stroke signs.', fix: plan.seekHelp }]);
  assert.equal(more.verdict, 'approve');
  assert.match(more.issues[0].problem, /does tell people to call the emergency number/);

  // A help sentence that really lacks the emergency number still blocks.
  const missing = { ...plan, seekHelp: 'إذا شعرت بالارتباك أو الإغماء، استرح في الظل.' };
  assert.equal((await review(missing, [{ quote: missing.seekHelp, rule: 'd', problem: 'Does not tell people to call the emergency number.', fix: 'اتصل برقم الطوارئ.' }])).verdict, 'revise');

  // Lexi: a preference is a note; a real grammar error and a wrong decimal separator still block.
  const bt = { headline: 'x', actions: ['a', 'b'], seekHelp: 'c' };
  const lexi = (issue) => parseLanguageReview(JSON.stringify({ backTranslation: bt, issues: [issue] })).issues[0].severity;
  assert.equal(lexi({ quote: 'لاستراحة', fix: 'للراحة', category: 'word', problem: "'استراحة' is not the best word for a short break; 'راحة' is more appropriate." }), 'minor');
  assert.equal(lexi({ quote: 'شرب كوب من الماء', fix: 'اشرَب كوب من الماء', category: 'grammar', problem: "The verb 'شرب' should be in the imperative form 'اشرَب'." }), 'blocking');
  assert.equal(lexi({ quote: '1,5 lít', fix: '1.5 lít', category: 'word', problem: 'Wrong decimal separator.' }), 'blocking', 'punctuation counts');
  assert.equal(lexi({ quote: 'Tome descansos.', fix: 'tome descansos. ', category: 'word', problem: 'Wrong word.' }), 'minor', 'the same words');

  // The words each language uses for the emergency number, from live plans (30 Sep).
  const help = (language, seekHelp) => namesEmergencyNumber({ seekHelp }, language);
  assert.ok(help('ur', 'اگر آپ کو بے ہوشی، الجھن، یا بہت زیادہ گرمی محسوس ہو تو اپنے مقامی امدادی نمبر پر فون کریں۔'));
  assert.ok(help('hi', 'अगर कोई चक्कर आना, भ्रम या बेहोशी हो तो तुरंत अपने स्थानीय आपातकालीन नंबर पर कॉल करें।'));
  assert.ok(help('bn', 'যদি মাথা ঘোরা, অচেতনতা বা বুদ্ধি হারানো হয়, আপনার স্থানীয় জরুরি নম্বরে কল করুন।'));
  assert.ok(help('vi', 'Nếu có dấu hiệu như mệt mỏi, chóng mặt, nôn mửa hoặc bất tỉnh thì gọi số điện thoại khẩn cấp địa phương ngay.'));
  assert.ok(help('zh', '如果出现头痛、恶心、头晕、虚弱、大量出汗、口渴或意识模糊，请立即拨打当地紧急电话。'));
  assert.ok(help('sw', 'Ishara za mapigo ya joto ni kuchanganyikiwa, kufaintia: piga simu ya dharura ya eneo lako.'));
  assert.ok(help('fr', "Si vous perdez connaissance, appelez votre numéro d'urgence local immédiatement."));
  assert.ok(!help('en', 'If you feel faint, rest in the shade.'));
});

test('Kai: empty groups (left by end-to-end tests) are skipped, not counted as planned', async () => {
  const { db, tables } = createFakeDb();
  const store = createStore({ db, tables });
  const agentLog = createAgentLog({ db, table: tables.agentLog });
  await db.put({ table: 'groups', item: { groupId: 'empty', name: 'Nobody here' } });
  const res = await runCoordinator({ store, weather: { getForecast: async () => hot() }, agentLog, models: ['m'], converse: async () => { throw new Error('no model needed'); } });
  assert.equal(res.detail.groupsPlanned, 0);
});

test('Dispatcher 02:00 UTC: an unconfirmed email subscription is not "emailed" (SNS would silently drop it)', async () => {
  const { db, tables } = createFakeDb();
  const store = createStore({ db, tables });
  await db.put({ table: 'locations', item: { locationId: 'p1', name: 'p1', placeName: 'Phoenix', lat: 33.45, lon: -112.07, profile: 'outdoor_worker', language: 'en', subscriptionArn: 'arn:p1' } });
  const published = [];
  const s = await runAlertCheck({
    store,
    weather: { getForecast: async () => hot() },
    guidance: { getGuidance: async () => GOOD },
    notifier: { subscriptionStatus: async () => 'pending', publishAlert: async (m) => { published.push(m); return 'x'; } },
    log: silentLog,
  });
  assert.equal(s.sent, 0);
  assert.equal(s.dashboardOnly, 1);
  assert.equal(s.pendingConfirmation, 1);
  assert.equal(published.length, 0);
  const [alert] = [...db.data.alerts.values()];
  assert.equal(alert.channel, 'dashboard (email not confirmed yet)');
});

test('Leaders can delete their whole group (members, subscriptions, alerts); the demo group cannot be deleted', async () => {
  const { db, tables } = createFakeDb();
  const subs = new Map();
  const notifier = {
    subscribeEmail: async (_e, id) => { subs.set(`arn:${id}`, true); return `arn:${id}`; },
    unsubscribe: async (arn) => { subs.delete(arn); },
    subscriptionStatus: async () => 'pending',
  };
  const api = createEnrollmentApi({ store: createStore({ db, tables }), notifier, weather: { getForecast: async () => hot() } });
  const member = (extra) => ({ name: 'A', placeName: 'Karachi', lat: 24.86, lon: 67.01, profile: 'elderly', language: 'ur', ...extra });
  const g = parse(await api(apiEvent('POST /api/groups', { body: { name: 'Temp' } }))).body;
  await api(apiEvent('POST /api/locations', { body: member({ groupId: g.groupId, email: 'a@example.org' }) }));
  await api(apiEvent('POST /api/locations', { body: member({ groupId: g.groupId, name: 'B' }) }));

  const wrong = parse(await api(apiEvent('DELETE /api/groups/{groupId}', { pathParameters: { groupId: g.groupId }, headers: { 'x-admin-key': 'nope' } })));
  assert.equal(wrong.status, 403);
  const ok = parse(await api(apiEvent('DELETE /api/groups/{groupId}', { pathParameters: { groupId: g.groupId }, headers: { 'x-admin-key': g.adminKey } })));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.membersRemoved, 2);
  assert.equal(db.data.groups.size, 0);
  assert.equal(db.data.locations.size, 0);
  assert.equal(subs.size, 0);

  const demo = parse(await api(apiEvent('POST /api/groups', { body: { name: 'Demo' } }))).body;
  db.data.groups.get(demo.groupId).readOnly = true;
  const blocked = parse(await api(apiEvent('DELETE /api/groups/{groupId}', { pathParameters: { groupId: demo.groupId }, headers: { 'x-admin-key': demo.adminKey } })));
  assert.equal(blocked.status, 403);
});
