/**
 * Forecast verification for daily peak heat index, from Open-Meteo's Previous Runs API: for each
 * past day, the forecast issued 1 day before (and 3 days before) is compared with the same model's
 * own analysis of that day (its best estimate of what happened). That is standard "verification
 * against analysis"; it is not a comparison with weather-station observations.
 *   MAE   mean absolute error of the day's peak heat index (°C)
 *   bias  mean (forecast - analysis): positive means the forecast ran hot
 *   tier agreement  share of days on which the forecast put the peak in the same NWS tier
 *   Danger contingency (1 day ahead): hits, misses, false alarms, correct negatives
 */
import { cToF, fToC, heatIndexF, tierForHeatIndexF, tierRank } from '../heat.mjs';

const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;

function dailyPeaks(time, temps, rhs) {
  const peaks = new Map();
  const counts = new Map();
  time.forEach((t, i) => {
    if (!Number.isFinite(temps?.[i]) || !Number.isFinite(rhs?.[i])) return;
    const day = t.slice(0, 10);
    const hi = heatIndexF(cToF(temps[i]), rhs[i]);
    peaks.set(day, Math.max(peaks.get(day) ?? -Infinity, hi));
    counts.set(day, (counts.get(day) ?? 0) + 1);
  });
  // Only days with at least 20 of 24 hours are judged.
  return new Map([...peaks].filter(([day]) => counts.get(day) >= 20).map(([day, f]) => [day, f]));
}

function score(pairs) {
  if (!pairs.length) return null;
  const errs = pairs.map(([f, o]) => fToC(f) - fToC(o));
  return {
    days: pairs.length,
    maeC: round1(errs.reduce((s, e) => s + Math.abs(e), 0) / errs.length),
    biasC: round1(errs.reduce((s, e) => s + e, 0) / errs.length),
    tierAgreement: round2(pairs.filter(([f, o]) => tierForHeatIndexF(f) === tierForHeatIndexF(o)).length / pairs.length),
  };
}

/** @param hourly Previous Runs API hourly block; @param today local date (YYYY-MM-DD), excluded (incomplete) */
export function verifyPeaks(hourly, today) {
  const t = hourly?.time ?? [];
  const truth = dailyPeaks(t, hourly.temperature_2m, hourly.relative_humidity_2m);
  const lead1 = dailyPeaks(t, hourly.temperature_2m_previous_day1, hourly.relative_humidity_2m_previous_day1);
  const lead3 = dailyPeaks(t, hourly.temperature_2m_previous_day3, hourly.relative_humidity_2m_previous_day3);
  const days = [...truth.keys()].filter((d) => d < today).sort();
  const pairsFor = (lead) => days.filter((d) => lead.has(d)).map((d) => [lead.get(d), truth.get(d)]);
  const p1 = pairsFor(lead1);
  const danger = { hits: 0, misses: 0, falseAlarms: 0, correctNegatives: 0 };
  const isDanger = (f) => tierRank(tierForHeatIndexF(f)) >= tierRank('danger');
  for (const [f, o] of p1) {
    if (isDanger(f) && isDanger(o)) danger.hits += 1;
    else if (!isDanger(f) && isDanger(o)) danger.misses += 1;
    else if (isDanger(f) && !isDanger(o)) danger.falseAlarms += 1;
    else danger.correctNegatives += 1;
  }
  return { from: days[0] ?? null, to: days.at(-1) ?? null, lead1: score(p1), lead3: score(pairsFor(lead3)), danger };
}
