import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAlertCheck, formatAlert } from '../functions/lib/alert-runner.mjs';
import { createStore } from '../functions/lib/store.mjs';
import { assessRisk } from '../functions/lib/heat.mjs';
import { createFakeDb, makeForecast, diurnal, silentLog } from './helpers.mjs';

const G = { headline: 'Dangerous heat today.', actions: ['One.', 'Two.', 'Three.'], seekHelp: 'Help.', language: 'en', source: 'cache' };
const guidance = { getGuidance: async (_r, language) => ({ ...G, language }) };

function setup({ nowHour = 9, max = 38, publishFails = false } = {}) {
  const { db, tables } = createFakeDb();
  const store = createStore({ db, tables });
  const sent = [];
  const notifier = {
    publishAlert: async (m) => {
      if (publishFails) throw new Error('SNS throttled');
      sent.push(m);
      return `msg-${sent.length}`;
    },
  };
  let forecast = makeForecast({ nowHour, temp: diurnal(26, max), rh: () => 55 });
  const weather = { getForecast: async () => forecast };
  const run = (extra = {}) => runAlertCheck({ store, weather, guidance, notifier, log: silentLog, siteUrl: 'https://x.test', ...extra });
  const setForecast = (f) => { forecast = f; };
  return { db, store, sent, run, setForecast };
}

const person = (id, extra = {}) => ({
  locationId: id, name: id, placeName: 'Phoenix, United States', lat: 33.45, lon: -112.07,
  profile: 'outdoor_worker', language: 'en', subscriptionArn: `arn:${id}`, ...extra,
});

test('sends one alert per person per day, deduped across hourly runs', async () => {
  const { db, sent, run } = setup();
  await db.put({ table: 'locations', item: person('p1') });
  await db.put({ table: 'locations', item: person('p2') });
  const first = await run();
  assert.equal(first.sent, 2);
  const second = await run();
  assert.equal(second.sent, 0);
  assert.equal(second.alreadyAlerted, 2);
  assert.equal(sent.length, 2);
  assert.match(sent[0].subject, /^HeatShield: (Danger|Extreme Danger) heat risk - Phoenix, United States$/);
});

test('re-alerts the same day only when the tier escalates', async () => {
  const { db, sent, run, setForecast } = setup({ max: 33 });
  await db.put({ table: 'locations', item: person('p1') });
  await run();
  assert.equal(sent.length, 1);
  setForecast(makeForecast({ nowHour: 9, temp: diurnal(26, 41), rh: () => 55 }));
  await run();
  assert.equal(sent.length, 2, 'escalation should trigger a second alert');
});

test('quiet hours: no alerts between 21:00 and 06:00 local', async () => {
  const { db, sent, run } = setup({ nowHour: 23 });
  await db.put({ table: 'locations', item: person('p1') });
  const s = await run();
  assert.equal(s.quiet, 1);
  assert.equal(sent.length, 0);
});

test('below-threshold people are not alerted; profile matters', async () => {
  const { db, sent, run } = setup({ max: 30 }); // Caution-level day
  await db.put({ table: 'locations', item: person('worker') });
  await db.put({ table: 'locations', item: person('grandma', { profile: 'elderly' }) });
  const s = await run();
  assert.equal(s.belowThreshold, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject.includes('Caution'), true);
});

test('delivery failure releases the claim so the next run retries', async () => {
  const { db, run } = setup({ publishFails: true });
  await db.put({ table: 'locations', item: person('p1') });
  const s = await run();
  assert.equal(s.errors, 1);
  assert.equal(db.data.alerts.size, 0);
});

test('members without email are recorded for the dashboard (no Bedrock call)', async () => {
  const { db, run } = setup();
  let calls = 0;
  await db.put({ table: 'locations', item: person('p1', { subscriptionArn: undefined }) });
  const s = await run({ guidance: { getGuidance: async () => { calls += 1; return G; } } });
  assert.equal(s.dashboardOnly, 1);
  assert.equal(calls, 0);
  const [alert] = [...db.data.alerts.values()];
  assert.equal(alert.status, 'dashboard_only');
});

test('forced (manual) alert bypasses quiet hours and labels below-threshold sends as TEST', async () => {
  const { db, sent, run } = setup({ nowHour: 23, max: 20 });
  await db.put({ table: 'locations', item: person('p1') });
  const s = await run({ forceLocationId: 'p1' });
  assert.equal(s.sent, 1);
  assert.match(sent[0].subject, /^\[TEST\] HeatShield/);
  assert.match(sent[0].message, /TEST alert/);
});

test('email body is localized where labels exist and always carries the safety footer', () => {
  const risk = assessRisk(makeForecast({ nowHour: 9, temp: diurnal(26, 38), rh: () => 55 }), 'outdoor_worker');
  const { subject, message } = formatAlert({
    location: person('p1', { placeName: 'São Paulo' }), risk, guidance: { ...G, language: 'es' }, siteUrl: 'https://x.test',
  });
  assert.match(subject, /Sao Paulo$/);
  assert.ok(subject.length < 100);
  assert.match(message, /Qué hacer:/);
  assert.match(message, /local emergency number/);
  assert.doesNotMatch(message, /\n\n\n/);
});
