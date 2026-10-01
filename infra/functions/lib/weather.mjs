/**
 * Weather + geocoding via Open-Meteo (free, no API key, global coverage).
 * https://open-meteo.com/en/docs  ·  https://open-meteo.com/en/docs/geocoding-api
 *
 * Coordinates are rounded to 2 decimals (~1.1 km) before they leave this module. That is finer
 * than the forecast model grid, so it costs no accuracy, and it means we never store or send
 * anyone's exact position (privacy by design) while letting nearby people share one cache entry.
 */

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const ENSEMBLE_URL = 'https://ensemble-api.open-meteo.com/v1/ensemble';
const PREVIOUS_RUNS_URL = 'https://previous-runs-api.open-meteo.com/v1/forecast';
const TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;
// How old a saved forecast may be when Open-Meteo is down (Sol keeps a city's last good data as long).
export const STALE_MAX_MS = 3 * 60 * 60 * 1000;

export const roundCoord = (x) => Math.round(x * 100) / 100;

export class UpstreamError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message, { cause });
    this.name = 'UpstreamError';
    this.status = status;
  }
}

async function getJson(url, fetchImpl, retryDelayMs, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    // Open-Meteo limits requests per IP, and Lambda shares outbound IPs with other AWS customers, so a
    // 429 is often someone else's burst; a 503 is a brief outage (1 Oct 04:00 UTC). Wait before retrying.
    if (lastErr && retryDelayMs) await new Promise((r) => setTimeout(r, retryDelayMs));
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) return await res.json();
      lastErr = new UpstreamError(`Open-Meteo HTTP ${res.status}`, { status: res.status });
      if (res.status < 500 && res.status !== 429) break; // a bad request: retrying will not help
    } catch (err) {
      lastErr = new UpstreamError(`Open-Meteo request failed: ${err.message}`, { cause: err });
    }
  }
  throw lastErr;
}

/** Map Open-Meteo's column-oriented JSON into row objects the risk engine consumes. */
export function normalizeForecast(json) {
  const c = json?.current;
  const h = json?.hourly;
  if (!c || !h || !Array.isArray(h.time)) throw new UpstreamError('Unexpected forecast payload');
  const hourly = [];
  for (let i = 0; i < h.time.length; i += 1) {
    const tempC = h.temperature_2m?.[i];
    const rh = h.relative_humidity_2m?.[i];
    if (Number.isFinite(tempC) && Number.isFinite(rh)) {
      hourly.push({ time: h.time[i], tempC, rh, uv: h.uv_index?.[i] ?? null });
    }
  }
  const d = json.daily ?? {};
  const daily = (d.time ?? []).map((date, i) => ({
    date,
    tMaxC: d.temperature_2m_max?.[i] ?? null,
    tMinC: d.temperature_2m_min?.[i] ?? null,
    uvMax: d.uv_index_max?.[i] ?? null,
  }));
  if (!Number.isFinite(c.temperature_2m) || !Number.isFinite(c.relative_humidity_2m)) {
    throw new UpstreamError('Forecast is missing current temperature/humidity');
  }
  return {
    timezone: json.timezone,
    utcOffsetSeconds: json.utc_offset_seconds,
    current: {
      time: c.time,
      tempC: c.temperature_2m,
      rh: c.relative_humidity_2m,
      isDay: c.is_day === 1,
    },
    hourly,
    daily,
  };
}

/**
 * A saved forecast, moved on to the current hour: "now" becomes the saved hourly row for this hour in the
 * place's own time, and the result is marked stale with when it was fetched. Null when the saved forecast
 * is too old or no longer covers the next 24 hours.
 */
export function asStale(forecast, fetchedAtMs, nowMs, maxAgeMs = STALE_MAX_MS) {
  if (!forecast || !Number.isFinite(fetchedAtMs) || nowMs - fetchedAtMs > maxAgeMs) return null;
  const localHour = `${new Date(nowMs + (forecast.utcOffsetSeconds ?? 0) * 1000).toISOString().slice(0, 13)}:00`;
  const ahead = forecast.hourly.filter((h) => h.time >= localHour);
  if (ahead.length < 24 || ahead[0].time !== localHour) return null;
  const row = ahead[0];
  return {
    ...forecast,
    // is_day is not in the hourly data; a UV index above 0 means the sun is up
    current: { time: localHour, tempC: row.tempC, rh: row.rh, isDay: (row.uv ?? 0) > 0 },
    stale: { fetchedAt: new Date(fetchedAtMs).toISOString() },
  };
}

/**
 * @param {object} [o.backup] durable store ({ get(key), put(item) }, the GuidanceCache table) for the last good
 *   forecast of each ~1 km cell. With it, an Open-Meteo outage (1 Oct 19:20 UTC: timeouts and 503s for five
 *   minutes) serves that forecast, up to 3 hours old and marked stale, instead of an error. Without it, nothing
 *   changes: callers that must not use an old forecast simply do not pass one.
 */
export function createWeatherClient({ fetchImpl = globalThis.fetch, now = () => Date.now(), retryDelayMs = 1200, backup = null, log = null } = {}) {
  const cache = new Map();

  async function lastGood(key, hit) {
    let best = hit ? { forecast: hit.value, at: hit.at } : null;
    try {
      const item = await backup.get(`forecast:${key}`);
      const at = Date.parse(item?.fetchedAt);
      if (item?.forecastJson && (!best || at > best.at)) best = { forecast: JSON.parse(item.forecastJson), at };
    } catch { /* the backup is a best effort */ }
    return best ? asStale(best.forecast, best.at, now()) : null;
  }

  async function getForecast(lat, lon) {
    const key = `${roundCoord(lat)},${roundCoord(lon)}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_TTL_MS) return hit.value;

    const params = new URLSearchParams({
      latitude: String(roundCoord(lat)),
      longitude: String(roundCoord(lon)),
      current: 'temperature_2m,relative_humidity_2m,is_day',
      hourly: 'temperature_2m,relative_humidity_2m,uv_index',
      daily: 'temperature_2m_max,temperature_2m_min,uv_index_max',
      forecast_days: '4',
      timezone: 'auto',
    });
    let value;
    try {
      value = normalizeForecast(await getJson(`${FORECAST_URL}?${params}`, fetchImpl, retryDelayMs));
    } catch (err) {
      const stale = backup ? await lastGood(key, hit) : null;
      if (!stale) throw err;
      log?.warn?.('weather_stale_served', { cell: key, fetchedAt: stale.stale.fetchedAt, reason: err.message });
      return stale;
    }

    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { at: now(), value });
    if (backup) {
      await backup.put({ cacheKey: `forecast:${key}`, forecastJson: JSON.stringify(value), fetchedAt: new Date(now()).toISOString(), expiresAt: Math.floor(now() / 1000) + STALE_MAX_MS / 1000 })
        .catch(() => { /* a failed backup must never fail the request */ });
    }
    return value;
  }

  /**
   * Daily max/min for the past 31 days, today and 6 more days — what the Excess Heat Factor needs
   * (30 days of history for acclimatisation + a 3-day window ahead).
   */
  async function getDaily(lat, lon) {
    const key = `daily:${roundCoord(lat)},${roundCoord(lon)}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_TTL_MS) return hit.value;
    const params = new URLSearchParams({
      latitude: String(roundCoord(lat)),
      longitude: String(roundCoord(lon)),
      daily: 'temperature_2m_max,temperature_2m_min',
      past_days: '31',
      forecast_days: '7',
      timezone: 'auto',
    });
    const json = await getJson(`${FORECAST_URL}?${params}`, fetchImpl, retryDelayMs);
    if (!Array.isArray(json?.daily?.time)) throw new UpstreamError('Unexpected daily payload');
    const today = new Date(now() + (json.utc_offset_seconds ?? 0) * 1000).toISOString().slice(0, 10);
    const value = {
      dates: json.daily.time,
      tmax: json.daily.temperature_2m_max,
      tmin: json.daily.temperature_2m_min,
      today,
      timezone: json.timezone,
    };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { at: now(), value });
    return value;
  }

  async function geocode(query, language = 'en') {
    const params = new URLSearchParams({ name: query, count: '6', language, format: 'json' });
    const json = await getJson(`${GEOCODE_URL}?${params}`, fetchImpl, retryDelayMs);
    return (json.results ?? []).map((r) => ({
      name: r.name,
      admin1: r.admin1 ?? null,
      country: r.country ?? null,
      countryCode: r.country_code ?? null,
      lat: roundCoord(r.latitude),
      lon: roundCoord(r.longitude),
      timezone: r.timezone ?? null,
      population: r.population ?? null,
    }));
  }

  /** ECMWF IFS ensemble (control + 50 members), hourly temperature and humidity for 4 days, local time. */
  async function getEnsemble(lat, lon) {
    const params = new URLSearchParams({
      latitude: String(roundCoord(lat)),
      longitude: String(roundCoord(lon)),
      hourly: 'temperature_2m,relative_humidity_2m',
      models: 'ecmwf_ifs025',
      forecast_days: '4',
      timezone: 'auto',
    });
    const json = await getJson(`${ENSEMBLE_URL}?${params}`, fetchImpl, retryDelayMs);
    if (!Array.isArray(json?.hourly?.time)) throw new UpstreamError('Unexpected ensemble payload');
    return json.hourly;
  }

  /**
   * The last 14 days as analysed by the model, next to what it forecast 1 and 3 days before
   * (Open-Meteo Previous Runs API): the input to forecast verification.
   */
  async function getPreviousRuns(lat, lon) {
    const vars = ['temperature_2m', 'relative_humidity_2m'];
    const params = new URLSearchParams({
      latitude: String(roundCoord(lat)),
      longitude: String(roundCoord(lon)),
      hourly: [...vars, ...vars.map((v) => `${v}_previous_day1`), ...vars.map((v) => `${v}_previous_day3`)].join(','),
      past_days: '14',
      forecast_days: '1',
      timezone: 'auto',
    });
    const json = await getJson(`${PREVIOUS_RUNS_URL}?${params}`, fetchImpl, retryDelayMs);
    if (!Array.isArray(json?.hourly?.time)) throw new UpstreamError('Unexpected previous-runs payload');
    return { hourly: json.hourly, utcOffsetSeconds: json.utc_offset_seconds ?? 0 };
  }

  return { getForecast, getDaily, geocode, getEnsemble, getPreviousRuns };
}
