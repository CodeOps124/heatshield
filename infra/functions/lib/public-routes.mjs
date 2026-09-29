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
import { HttpError, json, router } from './http.mjs';
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

// Visitors may ask Sol or Otto to run now. A GLOBAL cooldown per agent (not per visitor) caps cost
// no matter how many people click: at most 144 Sol runs and 720 Otto runs a day.
export const ON_DEMAND_COOLDOWN_MS = { sol: 10 * 60_000, otto: 2 * 60_000 };

export function createPublicApi({ weather, guidance, version, region, agentsApi = null, agentLog = null, runAgentNow = null, now = () => Date.now() }) {
  return router({
    'GET /api/agents': async () => {
      if (!agentsApi) return json(404, { error: { code: 'not_found', message: 'No such route' } });
      return json(200, await agentsApi.get());
    },

    'POST /api/agents/{agentId}/run': async (event) => {
      const agentId = event.pathParameters?.agentId;
      if (!Object.hasOwn(ON_DEMAND_COOLDOWN_MS, agentId)) {
        throw new HttpError(404, 'not_found', 'Only Sol and Otto can be run on demand.');
      }
      if (!agentLog || !runAgentNow) throw new HttpError(503, 'unavailable', 'On-demand runs are not available.');
      const last = await agentLog.getState('ondemand', agentId).catch(() => null);
      const since = last?.requestedAt ? now() - Date.parse(last.requestedAt) : Infinity;
      if (since < ON_DEMAND_COOLDOWN_MS[agentId]) {
        const retryAfterSec = Math.ceil((ON_DEMAND_COOLDOWN_MS[agentId] - since) / 1000);
        return json(429, { error: { code: 'cooldown', message: `Someone asked ${agentId === 'sol' ? 'Sol' : 'Otto'} ${Math.floor(since / 1000)} s ago. Try again in ${retryAfterSec} s.` }, retryAfterSec });
      }
      await agentLog.putState('ondemand', agentId, { requestedAt: new Date(now()).toISOString() });
      try {
        const result = await runAgentNow(agentId);
        return json(200, { agent: agentId, result });
      } catch (err) {
        // A failed run should not burn the cooldown, and the visitor deserves the real reason.
        await (last ? agentLog.putState('ondemand', agentId, { requestedAt: last.requestedAt }) : agentLog.deleteState('ondemand', agentId)).catch(() => {});
        return json(502, { error: { code: 'agent_failed', message: `${agentId === 'sol' ? 'Sol' : 'Otto'} could not finish: ${err.message}` } });
      }
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
      const started = now();
      const result = await guidance.getGuidance(risk, lang);
      return json(200, { lat, lon, risk, guidance: { ...result, durationMs: now() - started } });
    },
  });
}
