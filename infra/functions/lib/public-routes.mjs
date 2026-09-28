/**
 * Public, anonymous endpoints — what a judge (or anyone) can try without signing up.
 *   GET /api/health
 *   GET /api/geocode?q=Karachi
 *   GET /api/risk?lat=..&lon=..&profile=..
 *   GET /api/guidance?lat=..&lon=..&profile=..&lang=..
 */
import { assessRisk, PROFILES } from './heat.mjs';
import { isLanguage } from './languages.mjs';
import { roundCoord } from './weather.mjs';
import { json, router } from './http.mjs';
import { ValidationError, cleanText, parseCoord } from './util.mjs';

export function parseRiskQuery(q = {}) {
  const lat = roundCoord(parseCoord(q.lat, 'lat'));
  const lon = roundCoord(parseCoord(q.lon, 'lon'));
  const profile = q.profile ?? 'general';
  if (!Object.hasOwn(PROFILES, profile)) throw new ValidationError(`Unknown profile "${profile}"`);
  return { lat, lon, profile };
}

export function parseLanguage(value) {
  const lang = value ?? 'en';
  if (!isLanguage(lang)) throw new ValidationError(`Unsupported language "${lang}"`);
  return lang;
}

export function createPublicApi({ weather, guidance, version, region, agentsApi = null }) {
  return router({
    'GET /api/agents': async () => {
      if (!agentsApi) return json(404, { error: { code: 'not_found', message: 'No such route' } });
      return json(200, await agentsApi.get());
    },

    'GET /api/health': async () =>
      json(200, { ok: true, service: 'heatshield-api', version, region, time: new Date().toISOString() }),

    'GET /api/geocode': async (event) => {
      const q = cleanText(event.queryStringParameters?.q, 80);
      if (!q || q.length < 2) throw new ValidationError('Type at least 2 characters to search for a place');
      const results = await weather.geocode(q);
      return json(200, { results });
    },

    'GET /api/risk': async (event) => {
      const { lat, lon, profile } = parseRiskQuery(event.queryStringParameters);
      const forecast = await weather.getForecast(lat, lon);
      return json(200, { lat, lon, risk: assessRisk(forecast, profile) });
    },

    'GET /api/guidance': async (event) => {
      const { lat, lon, profile } = parseRiskQuery(event.queryStringParameters);
      const lang = parseLanguage(event.queryStringParameters?.lang);
      // Risk is always recomputed server-side from the coordinates; the client cannot supply
      // (or tamper with) the values that go into the prompt.
      const forecast = await weather.getForecast(lat, lon);
      const risk = assessRisk(forecast, profile);
      const result = await guidance.getGuidance(risk, lang);
      return json(200, { lat, lon, risk, guidance: result });
    },
  });
}
