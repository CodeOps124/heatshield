/**
 * Probabilistic heat forecasts from an ensemble: the ECMWF IFS ensemble (control + 50 perturbed
 * members, 0.25°) via Open-Meteo's Ensemble API. Each member is a complete, physically consistent
 * forecast; running the NWS heat index over every member and counting how many reach a tier on a
 * given day gives a probability. "36 of 51 forecasts reach Danger on Thursday" is evidence a
 * single forecast cannot give.
 *
 * Input (Open-Meteo, timezone=auto): hourly.time (local ISO), temperature_2m and
 * relative_humidity_2m for the control, plus *_member01 ... *_member50.
 */
import { cToF, fToC, heatIndexF, tierForHeatIndexF, tierRank } from '../heat.mjs';

const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;

/** Member series found in the response: [{ id, temp: [...], rh: [...] }]. */
export function members(hourly) {
  const out = [];
  for (const key of Object.keys(hourly ?? {})) {
    const m = key.match(/^temperature_2m(?:_(member\d+))?$/);
    if (!m) continue;
    const suffix = m[1] ? `_${m[1]}` : '';
    const rh = hourly[`relative_humidity_2m${suffix}`];
    if (Array.isArray(hourly[key]) && Array.isArray(rh)) out.push({ id: m[1] ?? 'control', temp: hourly[key], rh });
  }
  return out;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * Per local day: the share of members whose daily peak heat index reaches each NWS tier, and the
 * spread (10th / 50th / 90th percentile) of those daily peaks in °C. Days where fewer than 18 of 24
 * hours are present in a member are skipped for that member.
 */
export function exceedance(hourly) {
  const series = members(hourly);
  const times = hourly?.time ?? [];
  if (!series.length || !times.length) return [];
  const dates = [...new Set(times.map((t) => t.slice(0, 10)))];
  return dates.map((date) => {
    const idx = times.map((t, i) => (t.startsWith(date) ? i : -1)).filter((i) => i >= 0);
    const peaks = [];
    for (const s of series) {
      let peak = -Infinity;
      let hours = 0;
      for (const i of idx) {
        const t = s.temp[i];
        const rh = s.rh[i];
        if (!Number.isFinite(t) || !Number.isFinite(rh)) continue;
        hours += 1;
        peak = Math.max(peak, heatIndexF(cToF(t), rh));
      }
      if (hours >= 18) peaks.push(peak);
    }
    if (!peaks.length) return null;
    const share = (tier) => round2(peaks.filter((f) => tierRank(tierForHeatIndexF(f)) >= tierRank(tier)).length / peaks.length);
    const sortedC = peaks.map(fToC).sort((a, b) => a - b);
    return {
      date,
      members: peaks.length,
      pExtremeCaution: share('extreme_caution'),
      pDanger: share('danger'),
      pExtremeDanger: share('extreme_danger'),
      peakHeatIndexC: { p10: round1(percentile(sortedC, 0.1)), p50: round1(percentile(sortedC, 0.5)), p90: round1(percentile(sortedC, 0.9)) },
    };
  }).filter(Boolean);
}

/** Plain words for a probability, used in briefings and headlines. */
export function likelihood(p) {
  if (p >= 0.9) return 'very likely';
  if (p >= 0.6) return 'likely';
  if (p >= 0.3) return 'possible';
  return 'unlikely';
}
