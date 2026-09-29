/**
 * SOL — Heat Sentinel agent (runs hourly).
 * Expertise encoded: operational heat-health early warning.
 * Algorithms:
 *   - Excess Heat Factor (Nairn & Fawcett 2015) against each area's 1991–2020 ERA5 climatology:
 *     detects heatwaves RELATIVE TO LOCAL CLIMATE (41 °C is normal in Dubai in August, not in Paris)
 *   - NWS heat-index tiers for the physiological risk of the coming days
 *   - least-squares trend of daily maximum temperature (°C/day)
 * The algorithm sets a CEILING on how severe each event may be called; the model ranks, compares
 * with its previous briefing (new / escalating / easing), and writes the situation briefing. It
 * cannot escalate beyond the evidence.
 */
import { createHash } from 'node:crypto';
import { runAgent, extractJson } from '../agent-runtime.mjs';
import { assessEhf, climatology } from '../algorithms/ehf.mjs';
import { linearRegression } from '../algorithms/stats.mjs';
import { assessRisk, tierRank } from '../heat.mjs';
import { mapLimit } from '../util.mjs';

const VULNERABLE = new Set(['elderly', 'chronic_condition', 'child', 'pregnant']);
const LEVELS = ['watch', 'warning', 'emergency'];
const TRENDS = ['new', 'escalating', 'steady', 'easing'];
const CLIMATE_GRID = 0.25; // ERA5 resolution: nearby people share one climatology
const MAX_AREAS = 40;

const snap = (x) => Math.round(x / CLIMATE_GRID) * CLIMATE_GRID;
const clean = (s, n) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');

/**
 * 30-year climatology per ERA5 cell, computed once and cached forever in the agent log.
 * A 30-year daily download is heavy for Open-Meteo's per-minute limit (the first live runs lost
 * areas to it), so `get(..., { allowFetch: false })` returns null instead of downloading.
 */
export function createClimateService({ agentLog, fetchImpl = globalThis.fetch }) {
  return {
    async get(lat, lon, { allowFetch = true } = {}) {
      const key = `climate#${snap(lat).toFixed(2)},${snap(lon).toFixed(2)}`;
      const cached = await agentLog.getState('sol', key);
      if (cached?.t95) return cached;
      if (!allowFetch) return null;
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${snap(lat)}&longitude=${snap(lon)}&start_date=1991-01-01&end_date=2020-12-31&daily=temperature_2m_max,temperature_2m_min&timezone=auto`;
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`Open-Meteo archive HTTP ${res.status}`);
      const json = await res.json();
      const c = climatology(json.daily.temperature_2m_max, json.daily.temperature_2m_min);
      const value = { t95: c.t95, ehf85: c.ehf85, days: c.days, period: '1991-2020', source: 'ERA5 reanalysis via Open-Meteo' };
      await agentLog.putState('sol', key, value);
      return value;
    },
  };
}

/** Algorithmic ceiling: the most severe level the evidence supports. */
export function evidenceCeiling(area) {
  const worstEhf = area.ehf?.worst?.severity ?? 'none';
  const worstTier = area.hiDays.reduce((w, d) => Math.max(w, tierRank(d.tier)), 0);
  if (worstEhf === 'extreme' || worstTier >= tierRank('extreme_danger')) return 'emergency';
  if (worstEhf === 'severe' || worstTier >= tierRank('danger')) return 'warning';
  if (worstEhf === 'low-intensity') return 'watch';
  return null;
}

/** Group registered locations into watched areas (no names, no contact details). */
export function buildAreas(locations) {
  const cells = new Map();
  for (const l of locations) {
    const key = `${l.lat},${l.lon}`;
    const c = cells.get(key) ?? { lat: l.lat, lon: l.lon, places: new Map(), people: 0, vulnerable: 0, workers: 0 };
    c.people += 1;
    if (VULNERABLE.has(l.profile)) c.vulnerable += 1;
    if (l.profile === 'outdoor_worker') c.workers += 1;
    c.places.set(l.placeName, (c.places.get(l.placeName) ?? 0) + 1);
    cells.set(key, c);
  }
  return [...cells.values()]
    .sort((a, b) => b.people - a.people)
    .slice(0, MAX_AREAS)
    .map((c, i) => ({
      areaId: `A${i + 1}`,
      lat: c.lat,
      lon: c.lon,
      place: [...c.places.entries()].sort((a, b) => b[1] - a[1])[0][0],
      people: c.people,
      vulnerable: c.vulnerable,
      workers: c.workers,
    }));
}

export function parseSentinelOutput(text, candidates) {
  const raw = extractJson(text);
  const byId = new Map(candidates.map((c) => [c.areaId, c]));
  const events = [];
  for (const e of Array.isArray(raw.events) ? raw.events : []) {
    const area = byId.get(e?.areaId);
    if (!area || events.some((x) => x.areaId === area.areaId)) continue;
    const ceiling = LEVELS.indexOf(area.ceiling);
    const asked = LEVELS.indexOf(e.level);
    events.push({
      areaId: area.areaId,
      level: LEVELS[asked === -1 ? ceiling : Math.min(asked, ceiling)], // never above the evidence
      trend: TRENDS.includes(e.trend) ? e.trend : 'new',
      headline: clean(e.headline, 160) || `Heat signal in ${area.place}`,
      reason: clean(e.reason, 400),
    });
  }
  // Every candidate must be reported; the model may not silently drop an at-risk area.
  for (const c of candidates) {
    if (!events.some((e) => e.areaId === c.areaId)) {
      events.push({ areaId: c.areaId, level: c.ceiling, trend: 'new', headline: `Heat signal in ${c.place}`, reason: 'Reported from the algorithm (the model did not mention this area).' });
    }
  }
  const briefing = clean(raw.briefing, 1200);
  if (!briefing) throw new Error('Sentinel produced no briefing');
  return { briefing, events };
}

const NEW_CLIMATES_PER_RUN = 3;
const CARRY_MS = 3 * 3600_000;

export async function runSentinel({ store, weather, climate, agentLog, converse, models, deadline = Date.now() + 240_000, nowMs = () => Date.now(), retryPauseMs = 20_000 }) {
  const areas = buildAreas(await store.listAllLocations());
  const failures = [];

  // Climatologies first, sequentially, with a download budget; cached ones cost nothing.
  let downloads = 0;
  for (const area of areas) {
    try {
      area.clim = await climate.get(area.lat, area.lon, { allowFetch: false });
      if (!area.clim && downloads < NEW_CLIMATES_PER_RUN) {
        downloads += 1;
        area.clim = await climate.get(area.lat, area.lon);
      }
    } catch (err) {
      area.clim = null;
      failures.push({ areaId: area.areaId, place: area.place, stage: 'climate', message: err.message });
    }
  }

  const assessArea = async (area) => {
    const [daily, forecast] = await Promise.all([
      weather.getDaily(area.lat, area.lon),
      weather.getForecast(area.lat, area.lon),
    ]);
    const clim = area.clim;
    // No climatology yet (budget or download failure): judge on heat index alone this hour.
    area.ehf = clim
      ? assessEhf({ dates: daily.dates, tmax: daily.tmax, tmin: daily.tmin, today: daily.today, climate: clim })
      : { days: [], worst: null, heatwave: false, climatePending: true };
    area.climate = clim ? { t95: round1(clim.t95), ehf85: round1(clim.ehf85), period: clim.period } : null;
    area.hiDays = assessRisk(forecast, 'general').outlook.map((d) => ({ date: d.date, tier: d.tier, maxHeatIndexC: d.maxHeatIndexC }));
    const future = daily.dates.map((d, i) => [d, daily.tmax[i]]).filter(([d]) => d >= daily.today);
    area.tmaxTrendCPerDay = round1(linearRegression(future.map((_, i) => i), future.map(([, t]) => t)).slope);
    area.tropicalNights = daily.dates.filter((d, i) => d >= daily.today && daily.tmin[i] > 20).length;
    area.ceiling = evidenceCeiling(area);
  };
  const attempt = (area) => assessArea(area).then(() => { delete area.error; }, (err) => { area.error = err.message; });
  await mapLimit(areas, 4, attempt);
  // Open-Meteo limits requests per IP and Lambda shares outbound IPs with other AWS customers, so an
  // area can be refused for reasons that have nothing to do with us: one more try after a pause.
  const refused = areas.filter((a) => a.error);
  if (refused.length && deadline - Date.now() > retryPauseMs + 60_000) {
    await new Promise((r) => setTimeout(r, retryPauseMs));
    for (const area of refused) await attempt(area);
  }
  for (const a of areas) if (a.error) failures.push({ areaId: a.areaId, place: a.place, stage: 'forecast', message: a.error });

  const nowIso = new Date(nowMs()).toISOString();
  const prev = await agentLog.getState('sol', 'latest');
  const assessed = areas.filter((a) => !a.error);
  const candidates = assessed.filter((a) => a.ceiling);
  // An area that still could not be refreshed keeps its last good data (up to 3 hours, marked stale),
  // so a rate limit never silently drops a heat event or makes the board flicker.
  const carried = areas.filter((a) => a.error).flatMap((a) => {
    const last = (prev?.areas ?? []).find((p) => p.place === a.place);
    const asOf = last?.asOf ?? prev?.updatedAt;
    return last && nowMs() - Date.parse(asOf) < CARRY_MS ? [{ ...last, areaId: a.areaId, stale: true, asOf }] : [];
  });
  const carriedEvents = (prev?.events ?? [])
    .filter((e) => carried.some((c) => c.ceiling && c.place === e.place))
    .map((e) => ({ ...e, stale: true }));
  const areaSummary = [
    ...assessed.map((a) => ({
      areaId: a.areaId, place: a.place, people: a.people, ceiling: a.ceiling, climatePending: Boolean(a.ehf.climatePending),
      lat: Math.round(a.lat * 10) / 10, lon: Math.round(a.lon * 10) / 10, // city-level, for the situation board
      ehfWorst: a.ehf.worst ? { date: a.ehf.worst.date, ehf: a.ehf.worst.ehf, severity: a.ehf.worst.severity } : null,
      worstTier: a.hiDays.reduce((w, d) => (tierRank(d.tier) > tierRank(w) ? d.tier : w), 'lower'),
      asOf: nowIso,
    })),
    ...carried,
  ];
  const base = { areasScanned: assessed.length, areasCarried: carried.length, failures, areas: areaSummary };
  const scanned = `Scanned ${assessed.length} areas${carried.length ? ` (${carried.length} more kept from earlier data)` : ''}`;
  const staleNote = carriedEvents.length
    ? `The forecast for ${carriedEvents.map((e) => e.place.split(',')[0]).join(', ')} could not be refreshed this hour, so the earlier heat event(s) there stay in place until they can be checked again.`
    : '';

  if (candidates.length === 0 && carriedEvents.length === 0) {
    const state = { ...base, briefing: `No heatwave or dangerous heat in the ${assessed.length} watched areas over the next days.`, events: [], fingerprint: 'quiet', model: null, briefedAt: nowIso };
    await agentLog.putState('sol', 'latest', state);
    return { outcome: 'quiet', summary: `${scanned}: all quiet.`, detail: { events: [] } };
  }

  // What would change the briefing: which areas are at which ceiling, their worst EHF day, and
  // whether that comes from this hour's data or from earlier data (so the text never goes stale).
  const fingerprint = createHash('sha1')
    .update(JSON.stringify(areaSummary.filter((a) => a.ceiling).map((a) => [a.place, a.ceiling, a.ehfWorst?.date ?? null, a.ehfWorst?.severity ?? null, Boolean(a.stale)]).sort()))
    .digest('hex').slice(0, 12);
  // Age of the briefing itself: updatedAt moves on every re-check, so it could never expire one.
  const prevAge = prev?.briefedAt ? nowMs() - Date.parse(prev.briefedAt) : Infinity;
  if (prev?.fingerprint === fingerprint && prevAge < 6 * 3600_000 && prev.events?.length) {
    await agentLog.putState('sol', 'latest', { ...prev, ...base, events: prev.events, briefing: prev.briefing, fingerprint });
    return {
      outcome: 'unchanged',
      summary: `${scanned}: ${prev.events.length} heat event(s) unchanged since the ${prev.briefedAt.slice(11, 16)} UTC briefing.`,
      detail: { events: prev.events.map(({ place, level, trend }) => ({ place, level, trend })) },
    };
  }
  if (candidates.length === 0) {
    // Only areas we could not refresh still show heat: keep their events as they were, no model call.
    const briefing = `No heat signals in the ${assessed.length} areas refreshed this hour. ${staleNote}`;
    await agentLog.putState('sol', 'latest', { ...base, briefing, events: carriedEvents, fingerprint, model: null, briefedAt: nowIso });
    return { outcome: 'partial', summary: `${scanned}: no new heat signals; kept ${carriedEvents.length} earlier event(s).`, detail: { events: carriedEvents.map(({ place, level, trend }) => ({ place, level, trend })) } };
  }

  const signal = (c) => ({
    areaId: c.areaId, place: c.place, people: c.people, vulnerablePeople: c.vulnerable, outdoorWorkers: c.workers,
    evidenceCeiling: c.ceiling,
    excessHeatFactor: c.ehf.climatePending ? 'not available yet (local climatology still being computed)' : c.ehf.days.map((d) => ({ date: d.date, ehf: d.ehf, severity: d.severity })),
    heatIndexByDay: c.hiDays, tmaxTrendCPerDay: c.tmaxTrendCPerDay, tropicalNightsAhead: c.tropicalNights,
  });
  const run = await runAgent({
    agent: {
      name: 'sol',
      models,
      maxTurns: 5,
      maxTokens: 1500,
      system: 'You are Sol, HeatShield\'s heat sentinel: an operational heat-health forecaster. You read algorithmic heat signals (Excess Heat Factor against local 1991-2020 climate, US National Weather Service heat-index tiers, temperature trend, tropical nights) and decide which areas need a heat watch, warning or emergency, whether each is new, escalating, steady or easing compared with your previous briefing, and you write a short situation briefing for community health workers. Use the tools. Never exceed an area\'s evidenceCeiling. Write for non-specialists: plain words, no jargon or acronyms (say "unusually hot for this place and time of year" instead of "positive EHF", and "dangerous heat and humidity" instead of "danger-tier heat index"). Be factual and calm; name places and weekdays or dates.',
      tools: [
        { name: 'list_heat_signals', description: 'All watched areas with a heat signal, with the algorithm\'s evidence.', inputSchema: { type: 'object', properties: {} }, handler: async () => ({ areas: candidates.map(signal) }) },
        {
          name: 'get_area_detail',
          description: 'Full evidence for one area, including its local climatology (T95, EHF85).',
          inputSchema: { type: 'object', properties: { areaId: { type: 'string' } }, required: ['areaId'] },
          handler: async ({ areaId }) => {
            const c = candidates.find((a) => a.areaId === areaId);
            if (!c) throw new Error('No such area');
            return { ...signal(c), climate: c.climate, ehfDays: c.ehf.days };
          },
        },
        {
          name: 'get_previous_briefing',
          description: 'Your previous briefing and events, to judge what is new, escalating or easing.',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => (prev ? { generatedAt: prev.updatedAt, briefing: prev.briefing, events: (prev.events ?? []).map(({ place, level, headline }) => ({ place, level, headline })) } : { none: true }),
        },
      ],
    },
    input: `It is ${new Date(nowMs()).toISOString()}. ${candidates.length} of ${assessed.length} watched areas show a heat signal. Investigate with your tools, then reply with ONLY this JSON:\n{"briefing":"3-5 plain-language sentences","events":[{"areaId":"A1","level":"watch|warning|emergency","trend":"new|escalating|steady|easing","headline":"one plain-language line","reason":"cite the evidence (EHF, tiers, dates)"}]}`,
    converse,
    deadline,
    validate: (text) => parseSentinelOutput(text, candidates),
  });

  const { events } = run.value;
  const briefing = [run.value.briefing, staleNote].filter(Boolean).join(' ');
  const enriched = [
    ...events.map((e) => {
      const a = candidates.find((c) => c.areaId === e.areaId);
      return { ...e, place: a.place, lat: a.lat, lon: a.lon, people: a.people, ehfWorst: a.ehf.worst, ceiling: a.ceiling };
    }),
    ...carriedEvents,
  ];
  await agentLog.putState('sol', 'latest', { ...base, briefing, events: enriched, fingerprint, model: run.model, briefedAt: nowIso });
  const emergencies = enriched.filter((e) => e.level === 'emergency').length;
  return {
    ...run,
    outcome: 'briefed',
    summary: `${scanned}: ${enriched.length} heat event(s)${emergencies ? `, ${emergencies} emergency` : ''}. ${briefing.slice(0, 160)}`,
    detail: { events: enriched.map(({ place, level, trend, headline }) => ({ place, level, trend, headline })) },
  };
}

const round1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
