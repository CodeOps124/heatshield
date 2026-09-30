/**
 * QUINN — Forecast Auditor agent (daily). Expertise encoded: forecast verification.
 * Algorithm: for each city Sol watches, the day-ahead and 3-day-ahead forecasts of the daily peak
 * heat index over the last 14 days are scored against the same model's own analysis
 * (algorithms/verification.mjs): mean error, bias, tier agreement, and Danger hits / misses /
 * false alarms. Sol receives the scores, so a briefing can say how far to trust the forecast.
 * Model: writes a short note for the team. Code rejects any note containing a number the
 * verification did not produce; after one retry, a code-written note is used instead.
 */
import { runAgent, extractJson } from '../agent-runtime.mjs';
import { verifyPeaks } from '../algorithms/verification.mjs';
import { mapLimit } from '../util.mjs';

const clean = (s, n) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

/** Every number the note may use: the scores themselves, as written (1 decimal, or whole percent). */
export function allowedNumbers(report) {
  const nums = new Set(['1', '3', String(report.windowDays)]);
  const add = (x) => {
    if (!Number.isFinite(x)) return;
    nums.add(String(x));
    nums.add(String(Math.abs(x)));
    nums.add(x.toFixed(1));
    nums.add(Math.abs(x).toFixed(1));
  };
  const addScore = (s) => {
    if (!s) return;
    add(s.maeC); add(s.biasC); add(s.days);
    add(Math.round(s.tierAgreement * 100));
  };
  for (const c of report.cities) {
    addScore(c.lead1); addScore(c.lead3);
    for (const v of Object.values(c.danger)) add(v);
  }
  add(report.overall.lead1MaeC); add(report.overall.lead3MaeC); add(report.overall.lead1BiasC);
  return nums;
}

export function parseAuditNote(text, report) {
  const raw = extractJson(text);
  const note = clean(raw.note, 700);
  if (!note) throw new Error('the note is empty');
  const allowed = allowedNumbers(report);
  const bad = (note.match(/-?\d+(?:\.\d+)?/g) ?? []).filter((n) => !allowed.has(n) && !allowed.has(n.replace(/^-/, '')));
  if (bad.length) throw new Error(`the note uses numbers the verification did not produce (${[...new Set(bad)].join(', ')}); use only the numbers given`);
  return { note };
}

export function codeNote(report) {
  const o = report.overall;
  const worst = [...report.cities].filter((c) => c.lead1).sort((a, b) => b.lead1.maeC - a.lead1.maeC)[0];
  const misses = report.cities.filter((c) => c.danger.misses + c.danger.falseAlarms > 0)
    .map((c) => `${c.place.split(',')[0]} (${c.danger.misses} missed, ${c.danger.falseAlarms} false)`);
  return [
    `Over the last ${report.windowDays} days, the day-ahead forecast of each day's peak heat index was off by ${o.lead1MaeC} °C on average, and by ${o.lead3MaeC} °C three days ahead.`,
    worst ? `Least accurate: ${worst.place.split(',')[0]} (${worst.lead1.maeC} °C).` : '',
    misses.length ? `Danger calls that went wrong one day ahead: ${misses.join(', ')}.` : 'No Danger call went wrong one day ahead.',
  ].filter(Boolean).join(' ');
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
  if (allowModel) {
    try {
      run = await runAgent({
        agent: {
          name: 'quinn',
          models,
          maxTurns: 1,
          maxTokens: 600,
          system: 'You are Quinn, HeatShield\'s forecast auditor. You explain to a small team of community health workers, in plain words, how far to trust the heat forecast in each city, based on a verification report. Use only the numbers in the report, exactly as written. Do not write dates. Mention the cities where the forecast ran hot or cold, or where Danger calls went wrong.',
          tools: [],
        },
        input: `Verification report (daily peak heat index, forecast vs the model's own analysis):\n${JSON.stringify({ windowDays: report.windowDays, overall: report.overall, cities: cities.map(({ place, lead1, lead3, danger }) => ({ place, oneDayAhead: lead1, threeDaysAhead: lead3, dangerCallsOneDayAhead: danger })) })}\n\nReply with ONLY this JSON: {"note":"3-5 plain sentences"}`,
        converse,
        deadline,
        validate: (text) => parseAuditNote(text, report),
      });
      note = run.value.note;
    } catch {
      run = null; // the code-written note stands
    }
  }
  report.note = note;
  report.noteBy = run ? 'model' : 'code';
  await agentLog.putState('quinn', 'latest', report);
  return {
    ...(run ?? {}),
    outcome: 'audited',
    summary: `Audited ${cities.length} cities over ${report.windowDays} days: the day-ahead peak forecast was off by ${report.overall.lead1MaeC} °C on average.`,
    detail: { overall: report.overall, cities: cities.map(({ place, lead1, danger }) => ({ place, maeC: lead1.maeC, biasC: lead1.biasC, danger })) },
  };
}
