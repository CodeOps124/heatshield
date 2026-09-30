/**
 * QUINN — Forecast Auditor agent (daily). Expertise encoded: forecast verification.
 * Algorithm: for each city Sol watches, the day-ahead and 3-day-ahead forecasts of the daily peak
 * heat index over the last 14 days are scored against the same model's own analysis
 * (algorithms/verification.mjs): mean error, bias, tier agreement, and Danger hits / misses /
 * false alarms. Sol receives the scores, so a briefing can say how far to trust the forecast.
 * Model: decides which facts the team should hear about, as claims from a fixed list. Code checks
 * every claim against the scores and writes the sentence; a claim the numbers do not support is
 * dropped and counted. (The first version let the model write prose: it called Karachi's Danger
 * record "perfect" when the forecast had missed 2 Danger days.)
 */
import { runAgent, extractJson } from '../agent-runtime.mjs';
import { verifyPeaks } from '../algorithms/verification.mjs';
import { mapLimit } from '../util.mjs';

const clean = (s, n) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

const city = (c) => c.place.split(',')[0];
const fmt = (x) => `${x > 0 ? '+' : ''}${x}`;

/** The claims Quinn may make, each with the test the numbers must pass and the sentence code writes. */
export const CLAIMS = {
  ran_hot: {
    means: 'the forecast peaks were warmer than what happened, by 0.5 °C or more on average',
    holds: (c) => c.lead1.biasC >= 0.5 || (c.lead1.biasC >= 0 && (c.lead3?.biasC ?? 0) >= 0.5),
    say: (c) => `${city(c)}: the forecast ran hot (${fmt(c.lead1.biasC)} °C one day ahead${c.lead3 ? `, ${fmt(c.lead3.biasC)} °C three days ahead` : ''}).`,
  },
  ran_cold: {
    means: 'the forecast peaks were cooler than what happened, by 0.5 °C or more on average',
    holds: (c) => c.lead1.biasC <= -0.5 || (c.lead1.biasC <= 0 && (c.lead3?.biasC ?? 0) <= -0.5),
    say: (c) => `${city(c)}: the forecast ran cool (${fmt(c.lead1.biasC)} °C one day ahead${c.lead3 ? `, ${fmt(c.lead3.biasC)} °C three days ahead` : ''}).`,
  },
  missed_danger: {
    means: 'a Danger day that the day-ahead forecast did not call',
    holds: (c) => c.danger.misses > 0,
    say: (c) => `${city(c)}: the day-ahead forecast missed ${c.danger.misses} Danger day(s).`,
  },
  false_alarms: {
    means: 'a day-ahead Danger forecast that did not happen',
    holds: (c) => c.danger.falseAlarms > 0,
    say: (c) => `${city(c)}: ${c.danger.falseAlarms} day-ahead Danger forecast(s) did not happen.`,
  },
  reliable_danger_calls: {
    means: 'Danger was forecast at least once and every day-ahead Danger call was right',
    holds: (c) => c.danger.hits > 0 && c.danger.misses === 0 && c.danger.falseAlarms === 0,
    say: (c) => `${city(c)}: every day-ahead Danger forecast was right (${c.danger.hits} of ${c.danger.hits}).`,
  },
  most_accurate: {
    means: 'the smallest average day-ahead error of all the cities',
    holds: (c, all) => all.length > 1 && c.lead1.maeC <= Math.min(...all.map((x) => x.lead1.maeC)) + 0.05,
    say: (c) => `${city(c)}: the most accurate forecast (off by ${c.lead1.maeC} °C on average).`,
  },
  least_accurate: {
    means: 'the largest average day-ahead error of all the cities',
    holds: (c, all) => all.length > 1 && c.lead1.maeC >= Math.max(...all.map((x) => x.lead1.maeC)) - 0.05,
    say: (c) => `${city(c)}: the least accurate forecast (off by ${c.lead1.maeC} °C on average).`,
  },
};

/** Keeps the model's claims that the numbers support; returns sentences and what was rejected. */
export function verifyClaims(picked, report) {
  const byName = new Map(report.cities.map((c) => [city(c).toLowerCase(), c]));
  const accepted = [];
  const rejected = [];
  for (const p of picked.slice(0, 8)) {
    const c = byName.get(String(p?.city ?? '').split(',')[0].trim().toLowerCase());
    const claim = CLAIMS[p?.claim];
    if (!c || !claim) { rejected.push({ city: p?.city ?? null, claim: p?.claim ?? null, why: 'unknown city or claim' }); continue; }
    if (!claim.holds(c, report.cities)) { rejected.push({ city: city(c), claim: p.claim, why: 'not supported by the scores' }); continue; }
    if (!accepted.some((a) => a.city === city(c) && a.claim === p.claim)) accepted.push({ city: city(c), claim: p.claim, sentence: claim.say(c) });
  }
  return { accepted, rejected };
}

/** How many claims the numbers support; the model is asked for at least 3 when that many exist. */
export const supportedClaims = (report) => report.cities.reduce((n, c) => n + Object.values(CLAIMS).filter((k) => k.holds(c, report.cities)).length, 0);

export function parseClaims(text) {
  const raw = extractJson(text);
  if (!Array.isArray(raw?.claims)) throw new Error('Reply needs a claims array');
  return raw.claims.map((c) => ({ city: clean(c?.city, 60), claim: clean(c?.claim, 40) }));
}

export function overallSentence(report) {
  const o = report.overall;
  return `Over the last ${report.windowDays} days, the day-ahead forecast of each day's peak heat index was off by ${o.lead1MaeC} °C on average, and by ${o.lead3MaeC} °C three days ahead.`;
}

/** Without a model: the same checked claims, chosen by a fixed rule (every city with a Danger error). */
export function codeNote(report) {
  const picked = report.cities.flatMap((c) => [
    ...(c.danger.misses ? [{ city: city(c), claim: 'missed_danger' }] : []),
    ...(c.danger.falseAlarms ? [{ city: city(c), claim: 'false_alarms' }] : []),
  ]);
  const { accepted } = verifyClaims(picked, report);
  return [overallSentence(report), ...accepted.map((a) => a.sentence)].join(' ');
}

export async function runAuditor({ agentLog, weather, converse, models, allowModel = true, nowMs = () => Date.now(), deadline = Date.now() + 100_000 }) {
  const sol = await agentLog.getState('sol', 'latest');
  const areas = (sol?.areas ?? []).filter((a) => Number.isFinite(a.lat) && Number.isFinite(a.lon));
  if (!areas.length) return { outcome: 'idle', summary: 'No watched cities to audit yet.' };

  const failures = [];
  const cities = (await mapLimit(areas, 2, async (a) => {
    try {
      const { hourly, utcOffsetSeconds } = await weather.getPreviousRuns(a.lat, a.lon);
      const today = new Date(nowMs() + utcOffsetSeconds * 1000).toISOString().slice(0, 10);
      return { place: a.place, lat: a.lat, lon: a.lon, ...verifyPeaks(hourly, today) };
    } catch (err) {
      failures.push({ place: a.place, message: err.message });
      return null;
    }
  })).filter((c) => c?.lead1);
  if (!cities.length) return { outcome: 'error', summary: `Could not audit any city: ${failures[0]?.message ?? 'no data'}.` };

  const report = {
    generatedAt: new Date(nowMs()).toISOString(),
    windowDays: Math.max(...cities.map((c) => c.lead1.days)),
    reference: 'the same model\'s own analysis of each day (not weather-station observations)',
    cities,
    overall: {
      lead1MaeC: avg(cities.map((c) => c.lead1.maeC)),
      lead3MaeC: avg(cities.filter((c) => c.lead3).map((c) => c.lead3.maeC)),
      lead1BiasC: avg(cities.map((c) => c.lead1.biasC)),
    },
    failures,
  };

  let note = codeNote(report);
  let run = null;
  let checked = null;
  if (allowModel) {
    try {
      run = await runAgent({
        agent: {
          name: 'quinn',
          models,
          maxTurns: 1,
          maxTokens: 500,
          system: `You are Quinn, HeatShield's forecast auditor. From a verification report, choose the 3 to 6 facts a team of community health workers most needs, to know how far to trust the heat forecast in each city. Danger calls that went wrong matter most. Each fact is a city and one of these claims:\n${Object.entries(CLAIMS).map(([name, k]) => `- ${name}: ${k.means}`).join('\n')}\nOnly choose claims the numbers support; code checks every one.`,
          tools: [],
        },
        input: `Verification report (daily peak heat index, forecast vs the model's own analysis):\n${JSON.stringify({ windowDays: report.windowDays, overall: report.overall, cities: cities.map(({ place, lead1, lead3, danger }) => ({ city: place.split(',')[0], oneDayAhead: lead1, threeDaysAhead: lead3, dangerCallsOneDayAhead: danger })) })}\n\nReply with ONLY this JSON, with 3 to 6 claims: {"claims":[{"city":"<a city in the report>","claim":"<a claim name>"}]}`,
        converse,
        deadline,
        repairs: 2,
        // Verified while the model can still fix it. (Its first live reply was one claim: the
        // prompt's example, copied.)
        validate: (text) => {
          const result = verifyClaims(parseClaims(text), report);
          const need = Math.min(3, supportedClaims(report));
          if (result.accepted.length < need) {
            const why = result.rejected.map((r) => `${r.city} ${r.claim}: ${r.why}`).join('; ');
            throw new Error(`${result.accepted.length} of your claims hold${why ? ` (${why})` : ''}; choose at least ${need} different claims the numbers support`);
          }
          return result;
        },
      });
      checked = run.value;
      if (checked.accepted.length) note = [overallSentence(report), ...checked.accepted.map((a) => a.sentence)].join(' ');
    } catch {
      run = null; // the code-chosen note stands
    }
  }
  report.note = note;
  report.noteBy = checked?.accepted.length ? 'model' : 'code';
  report.rejectedClaims = checked?.rejected ?? [];
  await agentLog.putState('quinn', 'latest', report);
  return {
    ...(run ?? {}),
    outcome: 'audited',
    summary: `Audited ${cities.length} cities over ${report.windowDays} days: the day-ahead peak forecast was off by ${report.overall.lead1MaeC} °C on average.`,
    detail: { overall: report.overall, rejectedClaims: report.rejectedClaims, cities: cities.map(({ place, lead1, danger }) => ({ place, maeC: lead1.maeC, biasC: lead1.biasC, danger })) },
  };
}
