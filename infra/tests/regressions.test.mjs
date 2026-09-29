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
import { parseSafetyReview } from '../functions/lib/agents/safety-reviewer.mjs';
import { runSentinel } from '../functions/lib/agents/sentinel.mjs';
import { runCoordinator } from '../functions/lib/agents/coordinator.mjs';
import { triage, runWatchdog } from '../functions/lib/agents/watchdog.mjs';
import { runAlertCheck } from '../functions/lib/alert-runner.mjs';
import { createEnrollmentApi } from '../functions/lib/enrollment-routes.mjs';
import { createStore } from '../functions/lib/store.mjs';
import { assessRisk } from '../functions/lib/heat.mjs';
import { createFakeDb, makeForecast, diurnal, silentLog, apiEvent, parse } from './helpers.mjs';

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

test('Lexi 02:00 UTC: style notes never block; wrong words, grammar and false facts do', () => {
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
