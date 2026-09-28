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
const TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;

export const roundCoord = (x) => Math.round(x * 100) / 100;

export class UpstreamError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message, { cause });
    this.name = 'UpstreamError';
    this.status = status;
  }
}

async function getJson(url, fetchImpl, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) return await res.json();
      lastErr = new UpstreamError(`Open-Meteo HTTP ${res.status}`, { status: res.status });
      if (res.status < 500) break; // client error: retrying will not help
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

export function createWeatherClient({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const cache = new Map();

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
    const value = normalizeForecast(await getJson(`${FORECAST_URL}?${params}`, fetchImpl));

    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { at: now(), value });
    return value;
  }

  async function geocode(query, language = 'en') {
    const params = new URLSearchParams({ name: query, count: '6', language, format: 'json' });
    const json = await getJson(`${GEOCODE_URL}?${params}`, fetchImpl);
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

  return { getForecast, geocode };
}
