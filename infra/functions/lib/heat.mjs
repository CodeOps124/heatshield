/**
 * HeatShield risk engine — pure functions, no I/O, fully unit-tested.
 *
 * Heat index:  US National Weather Service algorithm (Rothfusz regression + NWS adjustments)
 *              https://www.wpc.ncep.noaa.gov/html/heatindex_equation.shtml
 * Tiers:       NWS heat index classification (Caution / Extreme Caution / Danger / Extreme Danger)
 *              https://www.weather.gov/ama/heatindex
 * Night:       "Tropical night" = daily minimum above 20 °C (WMO/ETCCDI index TR20).
 */

export const TIERS = Object.freeze(['lower', 'caution', 'extreme_caution', 'danger', 'extreme_danger']);

export const TIER_LABELS = Object.freeze({
  lower: 'Lower risk',
  caution: 'Caution',
  extreme_caution: 'Extreme Caution',
  danger: 'Danger',
  extreme_danger: 'Extreme Danger',
});

/**
 * Profile-adjusted ALERT thresholds. The heat index itself is objective; what changes per
 * person is the tier at which we proactively warn them. Populations that regulate body heat
 * less well (older adults, chronic illness, young children, pregnancy) are warned one tier
 * earlier than the general public. Outdoor workers are warned at Extreme Caution because the
 * NWS values assume shade — full sun can add up to 15 °F (weather.gov/ama/heatindex).
 */
export const PROFILES = Object.freeze({
  outdoor_worker: { label: 'Outdoor worker', alertTier: 'extreme_caution' },
  elderly: { label: 'Older adult (65+)', alertTier: 'caution' },
  chronic_condition: { label: 'Chronic health condition', alertTier: 'caution' },
  child: { label: 'Young child (or caring for one)', alertTier: 'caution' },
  pregnant: { label: 'Pregnant', alertTier: 'caution' },
  general: { label: 'General public', alertTier: 'extreme_caution' },
});

export const TROPICAL_NIGHT_C = 20;

export const cToF = (c) => (c * 9) / 5 + 32;
export const fToC = (f) => ((f - 32) * 5) / 9;
export const tierRank = (tier) => TIERS.indexOf(tier);
const round1 = (x) => Math.round(x * 10) / 10;

/** NWS heat index in °F from air temperature (°F) and relative humidity (%). */
export function heatIndexF(tempF, rhPercent) {
  if (!Number.isFinite(tempF) || !Number.isFinite(rhPercent)) {
    throw new TypeError(`heatIndexF needs finite numbers, got T=${tempF}, RH=${rhPercent}`);
  }
  const T = tempF;
  const RH = Math.min(100, Math.max(0, rhPercent));

  // Heat index has no meaning in cold air; report the air temperature (same convention as MetPy).
  if (T <= 40) return T;

  // Step 1 (NWS): Steadman's simple formula, already averaged with temperature.
  const simple = 0.5 * (T + 61.0 + (T - 68.0) * 1.2 + RH * 0.094);
  if (simple < 80) return simple;

  // Step 2 (NWS): full Rothfusz regression.
  let hi =
    -42.379 +
    2.04901523 * T +
    10.14333127 * RH -
    0.22475541 * T * RH -
    0.00683783 * T * T -
    0.05481717 * RH * RH +
    0.00122874 * T * T * RH +
    0.00085282 * T * RH * RH -
    0.00000199 * T * T * RH * RH;

  // Step 3 (NWS): adjustments at the humidity extremes.
  if (RH < 13 && T >= 80 && T <= 112) {
    hi -= ((13 - RH) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
  } else if (RH > 85 && T >= 80 && T <= 87) {
    hi += ((RH - 85) / 10) * ((87 - T) / 5);
  }
  return hi;
}

export const heatIndexC = (tempC, rhPercent) => fToC(heatIndexF(cToF(tempC), rhPercent));

/** NWS classification of a heat index value (°F). */
export function tierForHeatIndexF(hiF) {
  if (hiF >= 125) return 'extreme_danger';
  if (hiF >= 103) return 'danger';
  if (hiF >= 90) return 'extreme_caution';
  if (hiF >= 80) return 'caution';
  return 'lower';
}

export const maxTier = (tiers) =>
  tiers.reduce((best, t) => (tierRank(t) > tierRank(best) ? t : best), 'lower');

export function partOfDay(hour) {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

const hourOf = (localIso) => Number(localIso.slice(11, 13));
const hhmm = (localIso) => localIso.slice(11, 16);
const dateOf = (localIso) => localIso.slice(0, 10);

/** Local ISO hour + 1 h (string arithmetic via UTC so no machine time zone leaks in). */
function plusOneHour(localIso) {
  const d = new Date(`${localIso.slice(0, 16)}:00Z`);
  d.setUTCHours(d.getUTCHours() + 1);
  return d.toISOString().slice(0, 16);
}

/** Whole days between the local date `today` and the date of `localIso` (0 = today, 1 = tomorrow). */
const dayOffset = (today, localIso) => Math.round((Date.parse(`${dateOf(localIso)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);

const dayWord = (offset) => (offset === 0 ? '' : offset === 1 ? ' tomorrow' : ' the day after tomorrow');

/**
 * Plain-English window, unambiguous about the day:
 *   "all of the next 24 hours" · "now until 13:00 tomorrow" · "10:00 tomorrow to 18:00" · "14:00 to midnight"
 * `endDay` is the day of the LAST risky hour, so a window ending at 00:00 reads "midnight" on that day.
 */
export function windowLabel({ startsNow, coversNext24h, startLabel, endLabel, startDay, endDay }) {
  if (coversNext24h) return 'all of the next 24 hours';
  // Name the end's day only when it differs from the (explicitly named) start day.
  const endWord = !startsNow && endDay === startDay ? '' : dayWord(endDay);
  const end = endLabel === '00:00' ? `midnight${endWord}` : `${endLabel}${endWord}`;
  return startsNow ? `now until ${end}` : `${startLabel}${dayWord(startDay)} to ${end}`;
}

function scoreHour(h) {
  const hiF = heatIndexF(cToF(h.tempC), h.rh);
  return {
    time: h.time,
    tempC: round1(h.tempC),
    rh: Math.round(h.rh),
    heatIndexC: round1(fToC(hiF)),
    tier: tierForHeatIndexF(hiF),
  };
}

/**
 * Turn a normalized forecast into a profile-specific risk assessment.
 *
 * @param {object} forecast  output of normalizeForecast() in weather.mjs:
 *   { timezone, current: {time, tempC, rh, isDay}, hourly: [{time, tempC, rh, uv}],
 *     daily: [{date, uvMax}] }  — all times are LOCAL ISO strings "YYYY-MM-DDTHH:MM".
 * @param {string} profileId  key of PROFILES
 */
export function assessRisk(forecast, profileId) {
  const profile = PROFILES[profileId];
  if (!profile) throw new RangeError(`Unknown profile "${profileId}"`);
  const { current, hourly } = forecast;
  if (!current || !Array.isArray(hourly) || hourly.length === 0) {
    throw new RangeError('Forecast is missing current conditions or hourly data');
  }

  const now = scoreHour(current);
  const tempF = cToF(current.tempC);

  // Locate the current hour in the hourly series (both are local time strings).
  const currentHourKey = `${current.time.slice(0, 13)}:00`;
  let idx = hourly.findIndex((h) => h.time === currentHourKey);
  if (idx === -1) idx = Math.max(0, hourly.findIndex((h) => h.time > current.time) - 1);

  const next24 = hourly.slice(idx, idx + 24).map(scoreHour);
  const upcoming = next24.slice(1); // strictly after the current hour

  // Trend: is risk rising within the next 6 hours?
  const next6 = upcoming.slice(0, 6);
  const next6MaxTier = maxTier(next6.map((h) => h.tier));
  const firstHigher = next6.findIndex((h) => tierRank(h.tier) > tierRank(now.tier));
  const rising = firstHigher !== -1;

  // Peak of the next 24 h.
  const peak = next24.reduce((a, b) => (b.heatIndexC > a.heatIndexC ? b : a), next24[0] ?? now);

  // First contiguous window in the next 24 h at/above this profile's alert tier.
  const threshold = tierRank(profile.alertTier);
  const today = dateOf(current.time);
  let riskWindow = null;
  const start = next24.findIndex((h) => tierRank(h.tier) >= threshold);
  if (start !== -1) {
    let end = start;
    while (end + 1 < next24.length && tierRank(next24[end + 1].tier) >= threshold) end += 1;
    const endExclusive = plusOneHour(next24[end].time); // the window ends when the last risky hour ends
    const startDay = dayOffset(today, next24[start].time);
    const endDay = dayOffset(today, next24[end].time); // day of the last risky hour
    const coversNext24h = start === 0 && end === next24.length - 1;
    riskWindow = {
      start: next24[start].time,
      end: endExclusive,
      startLabel: hhmm(next24[start].time),
      endLabel: hhmm(endExclusive),
      startDay,
      endDay,
      startsNow: start === 0,
      coversNext24h,
      hours: end - start + 1,
      label: windowLabel({ startsNow: start === 0, coversNext24h, startLabel: hhmm(next24[start].time), endLabel: hhmm(endExclusive), startDay, endDay }),
    };
  }

  // Multi-day outlook (early warning is about days, not just hours).
  const byDate = new Map();
  for (const h of hourly.slice(idx).map(scoreHour)) {
    const d = dateOf(h.time);
    const prev = byDate.get(d);
    if (!prev || h.heatIndexC > prev.maxHeatIndexC) {
      byDate.set(d, { date: d, maxHeatIndexC: h.heatIndexC, maxTempC: h.tempC, tier: h.tier });
    }
  }
  const outlook = [...byDate.values()].slice(0, 4);

  // Overnight relief: coolest temperature in the next early-morning hours (00:00–06:59).
  const nightHours = next24.filter((h) => hourOf(h.time) <= 6);
  const nightLowC = nightHours.length ? Math.min(...nightHours.map((h) => h.tempC)) : null;

  // Alert decision: worst tier from now through the next 12 hours vs profile threshold.
  const next12MaxTier = maxTier(next24.slice(0, 13).map((h) => h.tier));
  const shouldAlert = tierRank(next12MaxTier) >= threshold;

  const localHour = hourOf(current.time);
  const uvMaxToday = forecast.daily?.find((d) => d.date === today)?.uvMax ?? null;

  return {
    timezone: forecast.timezone,
    utcOffsetSeconds: forecast.utcOffsetSeconds ?? 0,
    localTime: current.time,
    localHour,
    partOfDay: partOfDay(localHour),
    isDay: Boolean(current.isDay),
    current: {
      tempC: now.tempC,
      rh: now.rh,
      heatIndexC: now.heatIndexC,
      // NWS: the heat index is only meaningful at 80 °F (26.7 °C) and above.
      heatIndexApplies: tempF >= 80,
      tier: now.tier,
    },
    trend: {
      rising,
      hoursUntilRise: rising ? firstHigher + 1 : null,
      next6hMaxTier: next6MaxTier,
    },
    peak24h: {
      time: peak.time,
      label: hhmm(peak.time),
      isTomorrow: dateOf(peak.time) !== today,
      heatIndexC: peak.heatIndexC,
      tempC: peak.tempC,
      tier: peak.tier,
    },
    riskWindow,
    outlook,
    night: {
      lowC: nightLowC,
      tropicalNight: nightLowC !== null && nightLowC > TROPICAL_NIGHT_C,
    },
    uvMaxToday,
    profile: { id: profileId, label: profile.label, alertTier: profile.alertTier },
    alert: { shouldAlert, levelTier: next12MaxTier },
    hourly: next24.map(({ time, heatIndexC: hic, tempC, tier }) => ({ time, heatIndexC: hic, tempC, tier })),
  };
}
