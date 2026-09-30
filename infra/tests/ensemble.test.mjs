/** Ensemble probabilities: the maths, how they bound Sol's ceiling, and what Sol says about them. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exceedance, members, likelihood } from '../functions/lib/algorithms/ensemble.mjs';
import { evidenceCeiling, headlineFor, runSentinel } from '../functions/lib/agents/sentinel.mjs';
import { createAgentLog } from '../functions/lib/agent-log.mjs';
import { createStore } from '../functions/lib/store.mjs';
import { heatIndexC } from '../functions/lib/heat.mjs';
import { createFakeDb, makeForecast, diurnal } from './helpers.mjs';

const hours = (date, n = 24) => Array.from({ length: n }, (_, h) => `${date}T${String(h).padStart(2, '0')}:00`);
const flat = (v, n = 24) => Array(n).fill(v);

test('each member\'s daily peak heat index; the share of members reaching a tier is the probability', () => {
  // 36 °C at 50% is Danger (heat index about 45 °C); 30 °C at 50% is not.
  assert.ok(heatIndexC(36, 50) >= 39.4 && heatIndexC(30, 50) < 39.4);
  const hourly = {
    time: [...hours('2026-10-01'), ...hours('2026-10-02', 10)],
    temperature_2m: flat(36, 34), relative_humidity_2m: flat(50, 34),
    temperature_2m_member01: flat(36, 34), relative_humidity_2m_member01: flat(50, 34),
    temperature_2m_member02: flat(30, 34), relative_humidity_2m_member02: flat(50, 34),
    temperature_2m_member03: flat(36, 34), // no humidity series: not a usable member
  };
  assert.deepEqual(members(hourly).map((m) => m.id), ['control', 'member01', 'member02']);
  const [day, partial] = exceedance(hourly);
  assert.equal(day.date, '2026-10-01');
  assert.equal(day.members, 3);
  assert.equal(day.pDanger, 0.67);
  assert.equal(day.pExtremeDanger, 0);
  assert.equal(day.peakHeatIndexC.p50, Math.round(heatIndexC(36, 50) * 10) / 10);
  assert.equal(partial, undefined, 'a day with only 10 of 24 hours is not judged');
  assert.deepEqual([0.95, 0.7, 0.4, 0.1].map(likelihood), ['very likely', 'likely', 'possible', 'unlikely']);
});

const area = (tiers, ensemble, ehf = null) => ({
  place: 'Dhaka, Bangladesh',
  hiDays: tiers.map(([date, tier]) => ({ date, tier })),
  ehf: ehf ?? { worst: { severity: 'none' }, days: [] },
  ensemble: ensemble ? { days: ensemble.map(([date, pDanger, pExtremeDanger = 0]) => ({ date, pDanger, pExtremeDanger })) } : null,
});

test('Sol 29 Sep: Dhaka\'s one-forecast "danger" that 14-27% of the ensemble agreed with is a watch, not a warning', () => {
  const tiers = [['2026-09-30', 'danger'], ['2026-10-01', 'extreme_caution']];
  assert.equal(evidenceCeiling(area(tiers, null)), 'warning', 'without an ensemble, unchanged');
  assert.equal(evidenceCeiling(area(tiers, [['2026-09-30', 0.14], ['2026-10-01', 0.27]])), 'watch');
  assert.equal(evidenceCeiling(area(tiers, [['2026-09-30', 0.35]])), 'warning', 'possible (30%+) keeps the warning');
  assert.equal(evidenceCeiling(area([['2026-09-30', 'extreme_danger']], [['2026-09-30', 0.8, 0.1]])), 'warning', 'extreme danger needs its own 30%');
  assert.equal(evidenceCeiling(area([['2026-09-30', 'extreme_caution']], [['2026-09-30', 0.55]])), 'watch', 'early notice when half the ensemble reaches danger');
  assert.equal(evidenceCeiling(area([['2026-09-30', 'extreme_caution']], [['2026-09-30', 0.4]])), null);
  const heatwave = { worst: { severity: 'severe' }, days: [] };
  assert.equal(evidenceCeiling(area([['2026-09-30', 'caution']], [['2026-09-30', 0]], heatwave)), 'warning', 'a heatwave for the season does not depend on the ensemble');
});

test('headlines carry the ensemble\'s chance for the days they name', () => {
  const a = area([['2026-09-30', 'danger'], ['2026-10-01', 'danger']], [['2026-09-30', 0.14], ['2026-10-01', 0.27]]);
  assert.equal(headlineFor(a), 'Dhaka: dangerous heat and humidity on Wednesday and Thursday (14-27% chance)');
  const early = area([['2026-10-02', 'extreme_caution']], [['2026-10-02', 0.55]]);
  assert.equal(headlineFor(early), 'Dhaka: dangerous heat and humidity possible on Friday (55% chance)');
});

test('Sol downloads at most 3 ensembles per run, keeps each for 6 hours, and the chance reaches the event', async () => {
  const { db, tables } = createFakeDb();
  let now = Date.parse('2026-09-30T09:05:00Z');
  const nowMs = () => now;
  const agentLog = createAgentLog({ db, table: tables.agentLog, nowMs });
  const store = createStore({ db, tables });
  const cities = [[23.81, 90.41], [25.2, 55.27], [24.86, 67.01], [28.61, 77.21]];
  for (const [i, [lat, lon]] of cities.entries()) {
    await db.put({ table: 'locations', item: { locationId: `l${i}`, lat, lon, placeName: `City ${i}`, profile: 'elderly' } });
  }
  const dates = Array.from({ length: 38 }, (_, i) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10));
  let ensembleCalls = 0;
  const hot = makeForecast({ nowHour: 9, temp: diurnal(27, 38), rh: () => 55 });
  const weather = {
    getForecast: async () => hot,
    getDaily: async () => ({ dates, today: dates[29], tmax: Array(38).fill(33), tmin: Array(38).fill(26) }),
    getEnsemble: async () => {
      ensembleCalls += 1;
      const days = [...new Set(hot.hourly.map((h) => h.time.slice(0, 10)))];
      const time = days.flatMap((d) => hours(d));
      return { time, temperature_2m: flat(36, time.length), relative_humidity_2m: flat(50, time.length) };
    },
  };
  const answer = { stopReason: 'end_turn', output: { message: { role: 'assistant', content: [{ text: JSON.stringify({ briefing: 'Dangerous heat and humidity is very likely.', events: [] }) }] } }, usage: { inputTokens: 1, outputTokens: 1 } };
  const run = () => runSentinel({ store, weather, climate: { get: async () => null }, agentLog, converse: async () => answer, models: ['m'], nowMs, retryPauseMs: 0 });
  await run();
  assert.equal(ensembleCalls, 3, 'budget of 3 per run');
  const state = await agentLog.getState('sol', 'latest');
  const withChance = state.events.filter((e) => e.chance !== null);
  assert.equal(withChance.length, 3);
  assert.equal(withChance[0].chance, 1);
  assert.equal(withChance[0].confidence, 'very likely');
  assert.ok(withChance.every((e) => e.chanceOf === (e.level === 'emergency' ? 'extreme_danger' : 'danger')), 'says what the chance is of');
  now += 3600_000;
  await run();
  assert.equal(ensembleCalls, 4, 'the next hour downloads only the one still missing');
  now += 3600_000;
  await run();
  assert.equal(ensembleCalls, 4, 'fresh ensembles (under 6 h) are reused');
});
