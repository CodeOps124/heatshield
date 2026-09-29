/** Admin console API: who may use it, what it changes, and that every change is audited. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminApi, groupsOf, requireAdmin } from '../functions/lib/admin-routes.mjs';
import { createAgentLog } from '../functions/lib/agent-log.mjs';
import { createAgentsApi } from '../functions/lib/agents-api.mjs';
import { createControl } from '../functions/lib/control.mjs';
import { createStore } from '../functions/lib/store.mjs';
import { createFakeDb, apiEvent, parse } from './helpers.mjs';

const ADMIN = { token_use: 'id', email: 'ops@example.org', sub: 'u1', 'cognito:groups': '[admins]' };
const as = (claims, routeKey, opts = {}) => ({ ...apiEvent(routeKey, opts), requestContext: { authorizer: { jwt: { claims } } } });

function world() {
  const { db, tables } = createFakeDb();
  let now = Date.parse('2026-09-29T15:00:00Z');
  const nowMs = () => now;
  const agentLog = createAgentLog({ db, table: tables.agentLog, nowMs });
  const control = createControl({ agentLog, nowMs, ttlMs: 0 });
  const store = createStore({ db, tables });
  const invoked = [];
  const api = createAdminApi({
    agentLog, control, cache: store.guidanceCache, nowMs,
    agentsApi: createAgentsApi({ agentLog, control, nowMs }),
    invokeAgent: async (id, payload, { wait }) => { invoked.push({ id, payload, wait }); return { outcome: 'ok', summary: `${id} ran` }; },
    failedRuns: { count: async () => 0, peek: async () => [], purge: async () => {} },
    alarms: async () => [{ name: 'otto-silent', state: 'OK', description: 'x', since: null }],
  });
  return { db, tables, agentLog, control, store, api, invoked, advance: (ms) => { now += ms; } };
}

test('only an ID token of the "admins" group gets in', () => {
  assert.deepEqual(groupsOf({ 'cognito:groups': '[admins ops]' }), ['admins', 'ops']);
  assert.deepEqual(groupsOf({ 'cognito:groups': '["admins"]' }), ['admins']);
  assert.deepEqual(groupsOf({ 'cognito:groups': ['admins'] }), ['admins']);
  assert.deepEqual(groupsOf({}), []);
  assert.throws(() => requireAdmin({}), (e) => e.status === 401);
  assert.throws(() => requireAdmin({ requestContext: { authorizer: { jwt: { claims: { ...ADMIN, token_use: 'access' } } } } }), (e) => e.status === 401);
  assert.throws(() => requireAdmin({ requestContext: { authorizer: { jwt: { claims: { ...ADMIN, 'cognito:groups': '[viewers]' } } } } }), (e) => e.status === 403);
  assert.equal(requireAdmin({ requestContext: { authorizer: { jwt: { claims: ADMIN } } } }).email, 'ops@example.org');
});

test('a non-admin is refused before anything changes', async () => {
  const w = world();
  const res = parse(await w.api(as({ ...ADMIN, 'cognito:groups': '[]' }, 'PUT /api/admin/settings', { body: { aiPaused: true } })));
  assert.equal(res.status, 403);
  assert.equal(await w.agentLog.getState('admin', 'settings'), null);
});

test('settings merge, are validated, take effect for every agent, and are audited', async () => {
  const w = world();
  let r = parse(await w.api(as(ADMIN, 'PUT /api/admin/settings', { body: { paused: { sol: true }, budgetUsd: 2 } })));
  assert.equal(r.status, 200);
  r = parse(await w.api(as(ADMIN, 'PUT /api/admin/settings', { body: { paused: { kai: true }, notice: { text: 'Cooling centres open', level: 'warning' } } })));
  assert.deepEqual(Object.entries(r.body.settings.paused).filter(([, v]) => v).map(([k]) => k).sort(), ['kai', 'sol'], 'pauses merge');
  assert.equal(r.body.settings.budgetUsd, 2);
  assert.equal(await w.control.isPaused('sol'), true);
  assert.equal((await w.control.notice()).text, 'Cooling centres open');
  const audit = await w.agentLog.listRuns('admin', 10);
  assert.equal(audit.length, 2);
  assert.equal(audit[0].actor, 'ops@example.org');
  assert.match(audit[0].outcome, /settings: .*paused/);
  assert.ok(audit[0].expiresAt - Math.floor(Date.parse('2026-09-29T15:00:00Z') / 1000) >= 89 * 86400, 'audit kept 90 days');
});

test('raising the budget above today\'s spend releases Otto\'s brake at once', async () => {
  const w = world();
  await w.agentLog.putState('admin', 'budget', { day: '2026-09-29', spentUsd: 3.2, tripped: true });
  assert.equal((await w.control.generation('mira')).reason, 'budget_paused');
  await w.api(as(ADMIN, 'PUT /api/admin/settings', { body: { budgetUsd: 5 } }));
  assert.deepEqual(await w.control.generation('mira'), { ok: true });
});

test('run now: agents are waited for, the Dispatcher starts in the background, unknown agents are refused', async () => {
  const w = world();
  const sol = parse(await w.api(as(ADMIN, 'POST /api/admin/agents/{agentId}/run', { pathParameters: { agentId: 'sol' } })));
  assert.equal(sol.status, 200);
  assert.equal(sol.body.result.summary, 'sol ran');
  const dispatch = parse(await w.api(as(ADMIN, 'POST /api/admin/agents/{agentId}/run', { pathParameters: { agentId: 'dispatch' } })));
  assert.equal(dispatch.status, 202);
  assert.deepEqual(w.invoked.map((i) => [i.id, i.payload.trigger, i.wait]), [['sol', 'admin', true], ['dispatch', 'admin', false]]);
  assert.equal(parse(await w.api(as(ADMIN, 'POST /api/admin/agents/{agentId}/run', { pathParameters: { agentId: 'mira' } }))).status, 404);
});

test('recall removes a cached plan, and only a real plan key is accepted', async () => {
  const w = world();
  const key = 'a'.repeat(64);
  await w.store.guidanceCache.put({ cacheKey: key, guidance: { headline: 'Dangerous heat today.' }, expiresAt: 9e9 });
  assert.equal(parse(await w.api(as(ADMIN, 'DELETE /api/admin/plans/{cacheKey}', { pathParameters: { cacheKey: '../x' } }))).status, 400);
  assert.equal(parse(await w.api(as(ADMIN, 'DELETE /api/admin/plans/{cacheKey}', { pathParameters: { cacheKey: key } }))).status, 200);
  assert.equal(await w.store.guidanceCache.get(key), null);
  assert.equal(parse(await w.api(as(ADMIN, 'DELETE /api/admin/plans/{cacheKey}', { pathParameters: { cacheKey: key } }))).status, 404);
  assert.equal((await w.agentLog.listRuns('admin', 1))[0].detail.headline, 'Dangerous heat today.');
});

test('overview: measured spend per day, plan quality by language, alarm states, agents with their controls', async () => {
  const w = world();
  await w.agentLog.recordRun('mira', { model: 'us.amazon.nova-pro-v1:0', inputTokens: 1_000_000, outputTokens: 0 });
  await w.agentLog.recordRun('plans', { outcome: 'published', detail: { language: 'ar' } });
  await w.agentLog.recordRun('plans', { outcome: 'fallback', detail: { language: 'sw', reason: 'reviewers_rejected' } });
  const o = parse(await w.api(as(ADMIN, 'GET /api/admin/overview'))).body;
  assert.equal(o.me.email, 'ops@example.org');
  assert.equal(o.spend7d.length, 7);
  assert.equal(o.spend7d.at(-1).usd, 0.8);
  assert.equal(o.quality.last24h.published, 1);
  assert.deepEqual(o.quality.last7d.byLanguage.sw, { total: 1, published: 0 });
  assert.equal(o.quality.last7d.reasons.reviewers_rejected, 1);
  assert.equal(o.alarms[0].name, 'otto-silent');
  const dispatch = o.agents.find((a) => a.id === 'dispatch');
  assert.equal(dispatch.pausable, false, 'heat alerts cannot be paused');
  assert.equal(dispatch.runnable, true);
});
