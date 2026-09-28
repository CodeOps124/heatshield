/**
 * Excess Heat Factor (EHF) — heatwave detection relative to LOCAL climate.
 * Nairn, J.R. & Fawcett, R.J.B. (2015), "The Excess Heat Factor: A Metric for Heatwave Intensity and
 * Its Use in Classifying Heatwave Severity", Int. J. Environ. Res. Public Health 12(1):227-253.
 * https://pmc.ncbi.nlm.nih.gov/articles/PMC4306859/
 *
 *   DMT_i      daily mean temperature = (Tmax + Tmin) / 2
 *   EHIsig_i   = (T_i + T_i+1 + T_i+2)/3 − T95                       T95: 95th pct of DMT, reference period
 *   EHIaccl_i  = (T_i + T_i+1 + T_i+2)/3 − (T_i−1 + … + T_i−30)/30    vs. the previous 30 days
 *   EHF_i      = EHIsig_i × max(1, EHIaccl_i)          heatwave if EHF > 0
 *   severity:  severe if EHF ≥ EHF85, extreme if EHF ≥ 3 × EHF85
 *              (EHF85 = 85th percentile of all positive EHF values in the reference period)
 *
 * Deviations from the paper, stated honestly: we use calendar-day Tmax/Tmin (the paper uses a
 * 9am-to-9am day) and the 1991–2020 WMO normal from ERA5 reanalysis (the paper uses 1971–2000
 * station data).
 */

/** Percentile with linear interpolation between closest ranks (the common "type 7" estimator). */
export function percentile(values, p) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const rank = (p / 100) * (xs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return xs[lo] + (xs[hi] - xs[lo]) * (rank - lo);
}

export const dailyMean = (tmax, tmin) =>
  tmax.map((mx, i) => (Number.isFinite(mx) && Number.isFinite(tmin[i]) ? (mx + tmin[i]) / 2 : null));

/**
 * EHF for every index i of a DMT series that has 30 days before it and 2 days after it.
 * @returns {Array<{i, threeDay, ehiSig, ehiAccl, ehf}>}
 */
export function ehfSeries(dmt, t95) {
  const out = [];
  for (let i = 30; i + 2 < dmt.length; i += 1) {
    const window = [dmt[i], dmt[i + 1], dmt[i + 2]];
    const prev = dmt.slice(i - 30, i);
    if (window.some((v) => v === null) || prev.some((v) => v === null)) continue;
    const threeDay = (window[0] + window[1] + window[2]) / 3;
    const ehiSig = threeDay - t95;
    const ehiAccl = threeDay - prev.reduce((a, b) => a + b, 0) / 30;
    out.push({ i, threeDay, ehiSig, ehiAccl, ehf: ehiSig * Math.max(1, ehiAccl) });
  }
  return out;
}

/** Local climatology from a long daily series (reference period): T95 and EHF85. */
export function climatology(tmax, tmin) {
  const dmt = dailyMean(tmax, tmin);
  const t95 = percentile(dmt, 95);
  const positive = ehfSeries(dmt, t95).map((d) => d.ehf).filter((e) => e > 0);
  return { t95, ehf85: percentile(positive, 85), days: dmt.filter((v) => v !== null).length };
}

export function severity(ehf, ehf85) {
  if (!(ehf > 0)) return 'none';
  if (ehf85 && ehf >= 3 * ehf85) return 'extreme';
  if (ehf85 && ehf >= ehf85) return 'severe';
  return 'low-intensity';
}

/**
 * Assess the coming days for one place.
 * @param {object} p
 * @param {string[]} p.dates   daily dates covering ≥30 past days, today, and the forecast days
 * @param {number[]} p.tmax
 * @param {number[]} p.tmin
 * @param {string}   p.today   local date (YYYY-MM-DD)
 * @param {{t95:number, ehf85:number}} p.climate
 */
export function assessEhf({ dates, tmax, tmin, today, climate }) {
  const dmt = dailyMean(tmax, tmin);
  const todayIdx = dates.indexOf(today);
  if (todayIdx < 30) throw new RangeError('Need at least 30 days of history before today');
  const days = ehfSeries(dmt, climate.t95)
    .filter((d) => d.i >= todayIdx)
    .map((d) => ({
      date: dates[d.i],
      threeDayMeanC: round2(d.threeDay),
      ehiSig: round2(d.ehiSig),
      ehiAccl: round2(d.ehiAccl),
      ehf: round2(d.ehf),
      severity: severity(d.ehf, climate.ehf85),
    }));
  const worst = days.reduce((w, d) => (d.ehf > (w?.ehf ?? -Infinity) ? d : w), null);
  return { days, worst, heatwave: days.some((d) => d.ehf > 0) };
}

const round2 = (x) => Math.round(x * 100) / 100;
