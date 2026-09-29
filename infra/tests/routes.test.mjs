import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicApi } from '../functions/lib/public-routes.mjs';
import { createEnrollmentApi } from '../functions/lib/enrollment-routes.mjs';
import { createStore } from '../functions/lib/store.mjs';
import { UpstreamError } from '../functions/lib/weather.mjs';
import { createFakeDb, makeForecast, diurnal, apiEvent, parse } from './helpers.mjs';

const hot = makeForecast({ nowHour: 9, temp: diurnal(27, 38), rh: () => 55 });
const weather = { getForecast: async () => hot, geocode: async (q) => [{ name: q, lat: 1, lon: 2 }] };

function fakeNotifier() {
  const subs = new Map();
  return {
    subs,
    subscribeEmail: async (email, locationId) => { const arn = `arn:sns:${locationId}`; subs.set(arn, email); return arn; },
    unsubscribe: async (arn) => { subs.delete(arn); },
    subscriptionStatus: async () => 'pending',
    publishAlert: async () => 'msg-1',
  };
}

// ---------------- public API ----------------
const guidance = { getGuidance: async (_risk, language) => ({ headline: 'h', actions: ['a', 'b'], seekHelp: 's', language, source: 'cache' }) };
const pub = createPublicApi({ weather, guidance, version: 'test', region: 'us-east-1' });

test('GET /api/risk returns an assessment with rounded coordinates', async () => {
  const { status, body } = parse(await pub(apiEvent('GET /api/risk', { query: { lat: '24.86081', lon: '67.01044', profile: 'elderly' } })));
  assert.equal(status, 200);
  assert.equal(body.lat, 24.86);
  assert.equal(body.lon, 67.01);
  assert.equal(body.risk.profile.id, 'elderly');
});

test('public API validates input with 400s', async () => {
  const cases = [
    apiEvent('GET /api/risk', { query: { lat: '100', lon: '0' } }),
    apiEvent('GET /api/risk', { query: { lat: '1', lon: '1', profile: 'robot' } }),
    apiEvent('GET /api/guidance', { query: { lat: '1', lon: '1', lang: 'klingon' } }),
    apiEvent('GET /api/geocode', { query: { q: 'a' } }),
  ];
  for (const e of cases) assert.equal(parse(await pub(e)).status, 400, JSON.stringify(e.queryStringParameters));
});

test('weather outage maps to a friendly 502, unknown routes to 404', async () => {
  const down = createPublicApi({
    weather: { getForecast: async () => { throw new UpstreamError('boom'); } }, guidance, version: 't',
  });
  const r = parse(await down(apiEvent('GET /api/risk', { query: { lat: '1', lon: '1' } })));
  assert.equal(r.status, 502);
  assert.equal(r.body.error.code, 'weather_unavailable');
  assert.equal(parse(await pub(apiEvent('GET /nope'))).status, 404);
});

test('GET /api/guidance returns risk + guidance in the requested language', async () => {
  const { status, body } = parse(await pub(apiEvent('GET /api/guidance', { query: { lat: '1', lon: '1', profile: 'child', lang: 'hi' } })));
  assert.equal(status, 200);
  assert.equal(body.guidance.language, 'hi');
  assert.equal(body.risk.profile.id, 'child');
});

// ---------------- enrollment API ----------------
function enrollment() {
  const { db, tables } = createFakeDb();
  const notifier = fakeNotifier();
  const api = createEnrollmentApi({ store: createStore({ db, tables }), notifier, weather });
  return { api, db, notifier };
}

const member = (extra = {}) => ({
  name: 'Amina', placeName: 'Karachi, Pakistan', countryCode: 'pk', lat: 24.8608, lon: 67.0104,
  profile: 'outdoor_worker', language: 'ur', ...extra,
});

test('leader creates a group, members join, dashboard shows live risk', async () => {
  const { api, db, notifier } = enrollment();
  const g = parse(await api(apiEvent('POST /api/groups', { body: { name: 'Site 4 crew' } })));
  assert.equal(g.status, 201);
  assert.equal(g.body.adminKey.length, 32);
  const stored = db.data.groups.get(g.body.groupId);
  assert.ok(!JSON.stringify(stored).includes(g.body.adminKey), 'admin key must be stored hashed only');

  const reg = parse(await api(apiEvent('POST /api/locations', { body: member({ groupId: g.body.groupId, email: 'amina@example.org' }) })));
  assert.equal(reg.status, 201);
  assert.equal(reg.body.emailConfirmationSent, true);
  const loc = db.data.locations.get(reg.body.locationId);
  assert.equal(loc.lat, 24.86, 'coordinates stored rounded');
  assert.equal(loc.countryCode, 'PK');
  assert.ok(!JSON.stringify(loc).includes('amina@example.org'), 'email must not be stored in DynamoDB');
  assert.equal(notifier.subs.size, 1);

  await api(apiEvent('POST /api/locations', { body: member({ groupId: g.body.groupId, name: 'Bilal', profile: 'elderly' }) }));

  const dash = parse(await api(apiEvent('GET /api/groups/{groupId}/dashboard', {
    pathParameters: { groupId: g.body.groupId }, headers: { 'x-admin-key': g.body.adminKey },
  })));
  assert.equal(dash.status, 200);
  assert.equal(dash.body.summary.members, 2);
  assert.equal(dash.body.summary.needAttention, 2);
  assert.ok(dash.body.members.every((m) => m.risk && m.risk.tier));
  assert.ok(!JSON.stringify(dash.body).includes('arn:'), 'dashboard must not leak subscription ARNs');
});

test('dashboard rejects wrong keys and unknown groups identically', async () => {
  const { api } = enrollment();
  const g = parse(await api(apiEvent('POST /api/groups', { body: { name: 'Crew' } })));
  const wrong = parse(await api(apiEvent('GET /api/groups/{groupId}/dashboard', {
    pathParameters: { groupId: g.body.groupId }, headers: { 'x-admin-key': 'nope' },
  })));
  const missing = parse(await api(apiEvent('GET /api/groups/{groupId}/dashboard', {
    pathParameters: { groupId: 'doesnotexist1' }, headers: { 'x-admin-key': g.body.adminKey },
  })));
  assert.equal(wrong.status, 403);
  assert.deepEqual(wrong, missing);
});

test('registration validation', async () => {
  const { api } = enrollment();
  const bad = [
    member({ name: '   ' }),
    member({ profile: 'wizard' }),
    member({ language: 'xx' }),
    member({ lat: 200 }),
    member({ email: 'nope' }),
    member({ groupId: 'no-such-group' }),
  ];
  for (const body of bad) {
    const { status } = parse(await api(apiEvent('POST /api/locations', { body })));
    assert.ok([400, 404].includes(status), `expected rejection for ${JSON.stringify(body)}, got ${status}`);
  }
  const notJson = await api({ routeKey: 'POST /api/locations', body: '{oops', headers: {} });
  assert.equal(parse(notJson).status, 400);
});

test('owner can view and delete their data; deletion unsubscribes and removes alerts', async () => {
  const { api, db, notifier } = enrollment();
  const reg = parse(await api(apiEvent('POST /api/locations', { body: member({ email: 'x@example.org' }) })));
  const { locationId, manageToken } = reg.body;
  db.data.alerts.set(`${locationId}|2026-07-01`, { locationId, alertDate: '2026-07-01', tier: 'danger' });

  const me = parse(await api(apiEvent('GET /api/locations/{locationId}', {
    pathParameters: { locationId }, headers: { 'x-manage-token': manageToken },
  })));
  assert.equal(me.status, 200);
  assert.equal(me.body.location.emailStatus, 'pending');

  const forbidden = parse(await api(apiEvent('DELETE /api/locations/{locationId}', {
    pathParameters: { locationId }, headers: { 'x-manage-token': 'wrong' },
  })));
  assert.equal(forbidden.status, 403);

  const del = parse(await api(apiEvent('DELETE /api/locations/{locationId}', {
    pathParameters: { locationId }, headers: { 'x-manage-token': manageToken },
  })));
  assert.equal(del.status, 200);
  assert.equal(db.data.locations.size, 0);
  assert.equal(db.data.alerts.size, 0);
  assert.equal(notifier.subs.size, 0);
});

test('read-only (demo) groups refuse new members and removals but still show the dashboard', async () => {
  const { api, db } = enrollment();
  const g = parse(await api(apiEvent('POST /api/groups', { body: { name: 'Demo' } }))).body;
  const m = parse(await api(apiEvent('POST /api/locations', { body: member({ groupId: g.groupId }) }))).body;
  db.data.groups.get(g.groupId).readOnly = true;

  const info = parse(await api(apiEvent('GET /api/groups/{groupId}', { pathParameters: { groupId: g.groupId } })));
  assert.equal(info.body.readOnly, true);
  const join = parse(await api(apiEvent('POST /api/locations', { body: member({ groupId: g.groupId, name: 'Vandal' }) })));
  assert.equal(join.status, 403);
  const remove = parse(await api(apiEvent('DELETE /api/groups/{groupId}/members/{locationId}', {
    pathParameters: { groupId: g.groupId, locationId: m.locationId }, headers: { 'x-admin-key': g.adminKey },
  })));
  assert.equal(remove.status, 403);
  const dash = parse(await api(apiEvent('GET /api/groups/{groupId}/dashboard', {
    pathParameters: { groupId: g.groupId }, headers: { 'x-admin-key': g.adminKey },
  })));
  assert.equal(dash.status, 200);
  assert.equal(dash.body.group.readOnly, true);
  assert.equal(dash.body.members.length, 1);
});

test('personal page exposes a trimmed last-alert record', async () => {
  const { api, db } = enrollment();
  const reg = parse(await api(apiEvent('POST /api/locations', { body: member() }))).body;
  db.data.alerts.set(`${reg.locationId}|2026-07-01`, {
    locationId: reg.locationId, alertDate: '2026-07-01', tier: 'danger', status: 'sent', sentAt: 123, messageId: 'internal',
  });
  const me = parse(await api(apiEvent('GET /api/locations/{locationId}', {
    pathParameters: { locationId: reg.locationId }, headers: { 'x-manage-token': reg.manageToken },
  })));
  assert.deepEqual(me.body.lastAlert, { date: '2026-07-01', tier: 'danger', status: 'sent', sentAt: 123 });
});

test('leader can remove only members of their own group', async () => {
  const { api, db } = enrollment();
  const g1 = parse(await api(apiEvent('POST /api/groups', { body: { name: 'A' } }))).body;
  const g2 = parse(await api(apiEvent('POST /api/groups', { body: { name: 'B' } }))).body;
  const m2 = parse(await api(apiEvent('POST /api/locations', { body: member({ groupId: g2.groupId }) }))).body;
  const attempt = parse(await api(apiEvent('DELETE /api/groups/{groupId}/members/{locationId}', {
    pathParameters: { groupId: g1.groupId, locationId: m2.locationId }, headers: { 'x-admin-key': g1.adminKey },
  })));
  assert.equal(attempt.status, 404);
  assert.equal(db.data.locations.size, 1);
});

test('visitors can run Sol or Otto on demand, behind a global per-agent cooldown', async () => {
  const { db, tables } = createFakeDb();
  const { createAgentLog } = await import('../functions/lib/agent-log.mjs');
  let now = Date.parse('2026-09-29T12:00:00Z');
  const agentLog = createAgentLog({ db, table: tables.agentLog, nowMs: () => now });
  const ran = [];
  const api = createPublicApi({
    weather, guidance, version: 't', agentLog, now: () => now,
    runAgentNow: async (id) => { ran.push(id); return { outcome: 'healthy', summary: 'All probes healthy' }; },
  });
  const run = async (agentId) => parse(await api(apiEvent('POST /api/agents/{agentId}/run', { pathParameters: { agentId } })));

  const first = await run('otto');
  assert.equal(first.status, 200);
  assert.equal(first.body.result.outcome, 'healthy');
  const tooSoon = await run('otto');
  assert.equal(tooSoon.status, 429);
  assert.ok(tooSoon.body.retryAfterSec > 0 && tooSoon.body.retryAfterSec <= 120);
  assert.equal((await run('sol')).status, 200, 'cooldowns are per agent');
  now += 2 * 60_000 + 1000;
  assert.equal((await run('otto')).status, 200);
  assert.deepEqual(ran, ['otto', 'sol', 'otto']);
  assert.equal((await run('mira')).status, 404, 'only Sol and Otto can be run on demand');
});
