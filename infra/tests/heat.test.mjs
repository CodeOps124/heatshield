import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  heatIndexF, heatIndexC, tierForHeatIndexF, assessRisk, cToF, fToC, PROFILES, windowLabel,
} from '../functions/lib/heat.mjs';
import { makeForecast, diurnal } from './helpers.mjs';

/*
 * Reference values generated independently with MetPy 1.7.1 (metpy.calc.heat_index), which
 * implements the same NWS Rothfusz regression and adjustments. Points are chosen inside the
 * regression regime and include both NWS adjustment cases. Cross-checked against the NWS chart
 * (e.g. 90 °F / 50 % -> ~95 °F, 100 °F / 40 % -> ~109 °F).
 */
const METPY_REFERENCE = [
  [86, 50, 87.8883],
  [90, 50, 94.5969],
  [90, 70, 105.922],
  [95, 40, 98.9894],
  [95, 60, 113.0903],
  [100, 40, 109.2556],
  [100, 55, 123.6383],
  [104, 45, 124.4209],
  [110, 30, 122.3373],
  [96, 75, 132.1396],
  [100, 10, 94.1225], // low-humidity adjustment
  [105, 5, 96.8712], // low-humidity adjustment
  [82, 90, 91.9917], // high-humidity adjustment
  [85, 95, 104.6123], // high-humidity adjustment
  [120, 20, 129.9149],
  [88, 40, 87.9036],
];

test('heat index matches MetPy/NWS reference values', () => {
  for (const [t, rh, expected] of METPY_REFERENCE) {
    const got = heatIndexF(t, rh);
    assert.ok(Math.abs(got - expected) < 0.01, `T=${t}°F RH=${rh}% expected ${expected}, got ${got}`);
  }
});

test('below the regression regime the NWS simple formula is used', () => {
  // 0.5 * (75 + 61 + (75-68)*1.2 + 50*0.094) = 74.55
  assert.ok(Math.abs(heatIndexF(75, 50) - 74.55) < 1e-9);
  assert.equal(heatIndexF(30, 80), 30, 'cold air: heat index is just the temperature');
});

test('humidity is clamped and bad input rejected', () => {
  assert.equal(heatIndexF(95, 150), heatIndexF(95, 100));
  assert.throws(() => heatIndexF(Number.NaN, 50), TypeError);
});

test('celsius wrapper round-trips through °F', () => {
  assert.ok(Math.abs(heatIndexC(fToC(90), 50) - fToC(94.5969)) < 0.01);
  assert.ok(Math.abs(cToF(fToC(123.4)) - 123.4) < 1e-9);
});

test('NWS tier boundaries', () => {
  assert.equal(tierForHeatIndexF(79.9), 'lower');
  assert.equal(tierForHeatIndexF(80), 'caution');
  assert.equal(tierForHeatIndexF(89.9), 'caution');
  assert.equal(tierForHeatIndexF(90), 'extreme_caution');
  assert.equal(tierForHeatIndexF(103), 'danger');
  assert.equal(tierForHeatIndexF(124.9), 'danger');
  assert.equal(tierForHeatIndexF(125), 'extreme_danger');
});

test('vulnerable profiles alert one tier earlier than the general public', () => {
  for (const p of ['elderly', 'chronic_condition', 'child', 'pregnant']) assert.equal(PROFILES[p].alertTier, 'caution');
  assert.equal(PROFILES.general.alertTier, 'extreme_caution');
  assert.equal(PROFILES.outdoor_worker.alertTier, 'extreme_caution');
});

// A hot, humid day: 27 °C at night, 38 °C at 15:00, 55 % humidity. Now = 09:00.
const hotDay = () => makeForecast({ nowHour: 9, temp: diurnal(27, 38), rh: () => 55 });

test('assessRisk: rising trend, peak time and risk window on a hot day', () => {
  const r = assessRisk(hotDay(), 'outdoor_worker');
  assert.equal(r.localHour, 9);
  assert.equal(r.partOfDay, 'morning');
  assert.equal(r.peak24h.label, '15:00');
  assert.equal(r.peak24h.isTomorrow, false);
  assert.ok(['danger', 'extreme_danger'].includes(r.peak24h.tier), `peak tier was ${r.peak24h.tier}`);
  assert.equal(r.trend.rising, true);
  assert.ok(r.trend.hoursUntilRise >= 1 && r.trend.hoursUntilRise <= 6);
  assert.ok(r.riskWindow, 'expected a risk window');
  assert.ok(r.riskWindow.startLabel <= '15:00' && r.riskWindow.endLabel > '15:00');
  assert.equal(r.alert.shouldAlert, true);
  assert.equal(r.hourly.length, 24);
  assert.equal(r.outlook.length, 4);
  assert.equal(r.night.tropicalNight, true, 'nights at 27 °C are tropical nights (> 20 °C)');
});

test('assessRisk: same weather, different profiles, different decisions', () => {
  // Mild-warm day peaking around the Caution tier.
  const f = makeForecast({ nowHour: 10, temp: diurnal(20, 30), rh: () => 50 });
  const elderly = assessRisk(f, 'elderly');
  const general = assessRisk(f, 'general');
  assert.equal(elderly.peak24h.tier, 'caution');
  assert.equal(elderly.alert.shouldAlert, true, 'older adults are warned at Caution');
  assert.equal(general.alert.shouldAlert, false, 'general public is not warned at Caution');
  assert.equal(general.riskWindow, null);
  assert.equal(elderly.night.tropicalNight, false);
});

test('assessRisk: cool day produces no alert and no window', () => {
  const r = assessRisk(makeForecast({ nowHour: 12, temp: diurnal(8, 16), rh: () => 60 }), 'elderly');
  assert.equal(r.current.tier, 'lower');
  assert.equal(r.current.heatIndexApplies, false);
  assert.equal(r.alert.shouldAlert, false);
  assert.equal(r.riskWindow, null);
  assert.equal(r.trend.rising, false);
});

test('assessRisk: evening -> peak is tomorrow', () => {
  const r = assessRisk(hotDay(), 'general');
  const evening = assessRisk(makeForecast({ nowHour: 20, temp: diurnal(27, 38), rh: () => 55 }), 'general');
  assert.equal(r.peak24h.isTomorrow, false);
  assert.equal(evening.peak24h.isTomorrow, true);
  assert.equal(evening.partOfDay, 'evening');
});

test('risk window labels always say which day (regression: "14:00–13:00" on the live dashboard)', () => {
  const base = { startsNow: false, coversNext24h: false };
  assert.equal(windowLabel({ ...base, coversNext24h: true, startsNow: true, startLabel: '14:00', endLabel: '14:00', startDay: 0, endDay: 1 }), 'all of the next 24 hours');
  assert.equal(windowLabel({ ...base, startsNow: true, startLabel: '14:00', endLabel: '13:00', startDay: 0, endDay: 1 }), 'now until 13:00 tomorrow');
  assert.equal(windowLabel({ ...base, startsNow: true, startLabel: '22:00', endLabel: '17:00', startDay: 0, endDay: 0 }), 'now until 17:00');
  assert.equal(windowLabel({ ...base, startLabel: '10:00', endLabel: '18:00', startDay: 1, endDay: 1 }), '10:00 tomorrow to 18:00');
  assert.equal(windowLabel({ ...base, startLabel: '14:00', endLabel: '00:00', startDay: 0, endDay: 0 }), '14:00 to midnight');
  assert.equal(windowLabel({ ...base, startLabel: '21:00', endLabel: '04:00', startDay: 0, endDay: 1 }), '21:00 to 04:00 tomorrow');
});

test('assessRisk window: end is one hour after the last risky hour, with day offsets', () => {
  // Hot at night, current hour 20:00: the risky window runs past midnight.
  const r = assessRisk(makeForecast({ nowHour: 20, temp: diurnal(27, 38), rh: () => 55 }), 'outdoor_worker');
  const w = r.riskWindow;
  assert.ok(w);
  const startIdx = r.hourly.findIndex((h) => h.time === w.start);
  const lastRisky = r.hourly[startIdx + w.hours - 1];
  assert.equal(Date.parse(`${w.end}:00Z`) - Date.parse(`${lastRisky.time}:00Z`), 3600_000, 'end = last risky hour + 1 h');
  assert.equal(w.startDay, 0);
  assert.equal(w.endDay, lastRisky.time.slice(0, 10) === r.localTime.slice(0, 10) ? 0 : 1);
  assert.match(w.label, /(now until|to) /);
});

test('assessRisk rejects unknown profiles and empty forecasts', () => {
  assert.throws(() => assessRisk(hotDay(), 'astronaut'), RangeError);
  assert.throws(() => assessRisk({ current: null, hourly: [] }, 'general'), RangeError);
});
