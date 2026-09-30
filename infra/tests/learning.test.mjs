/** Quinn (forecast audit), Iris (the team learns from its corrections) and Kai's safest shift. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyPeaks } from '../functions/lib/algorithms/verification.mjs';
import { runAuditor, parseAuditNote, codeNote } from '../functions/lib/agents/auditor.mjs';
import { candidatesFrom, runCoach, mergeGlossary, glossaryLines, createGlossaryLoader, MAX_WORDS } from '../functions/lib/agents/coach.mjs';
import { bestShift } from '../functions/lib/agents/coordinator.mjs';
import { buildSystemPrompt, createGuidanceService } from '../functions/lib/guidance.mjs';
import { createAgentLog } from '../functions/lib/agent-log.mjs';
import { assessRisk } from '../functions/lib/heat.mjs';
import { createFakeDb, makeForecast, diurnal, silentLog } from './helpers.mjs';

const text = (t) => ({ stopReason: 'end_turn', output: { message: { role: 'assistant', content: [{ text: t }] } }, usage: { inputTokens: 10, outputTokens: 5 } });
const hoursOf = (day) => Array.from({ length: 24 }, (_, h) => `${day}T${String(h).padStart(2, '0')}:00`);

function previousRuns({ days, truth, lead1, lead3 }) {
  const time = days.flatMap(hoursOf);
  const series = (perDay) => days.flatMap((d, i) => Array(24).fill(perDay[i]));
  return {
    time,
    temperature_2m: series(truth), relative_humidity_2m: series(truth.map(() => 50)),
    temperature_2m_previous_day1: series(lead1), relative_humidity_2m_previous_day1: series(lead1.map(() => 50)),
    temperature_2m_previous_day3: series(lead3), relative_humidity_2m_previous_day3: series(lead3.map(() => 50)),
  };
}

// ---------------------------------------------------------------- Quinn
test('verification: error, bias, tier agreement and Danger hits / misses / false alarms; today is not judged', () => {
  const hourly = previousRuns({
    days: ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30'],
    truth: [36, 30, 36, 36], // heat index Danger, not, Danger, (today)
    lead1: [36, 36, 30, 40],
    lead3: [34, 30, 36, 36],
  });
  const v = verifyPeaks(hourly, '2026-09-30');
  assert.equal(v.from, '2026-09-27');
  assert.equal(v.to, '2026-09-29');
  assert.equal(v.lead1.days, 3);
  assert.deepEqual(v.danger, { hits: 1, misses: 1, falseAlarms: 1, correctNegatives: 0 });
  assert.equal(v.lead1.tierAgreement, 0.33);
  assert.ok(v.lead1.maeC > 0 && v.lead3.maeC < v.lead1.maeC);
});

test('Quinn: a note with a number the verification did not produce is rejected; the code note is the fallback', async () => {
  const { db, tables } = createFakeDb();
  const agentLog = createAgentLog({ db, table: tables.agentLog });
  await agentLog.putState('sol', 'latest', { areas: [{ place: 'Dhaka, Bangladesh', lat: 23.8, lon: 90.4 }] });
  const days = Array.from({ length: 15 }, (_, i) => new Date(Date.UTC(2026, 8, 16 + i)).toISOString().slice(0, 10));
  const weather = { getPreviousRuns: async () => ({ hourly: previousRuns({ days, truth: days.map(() => 35), lead1: days.map(() => 36), lead3: days.map(() => 37) }), utcOffsetSeconds: 21600 }) };
  const nowMs = () => Date.parse('2026-09-30T01:30:00Z');

  const r = await runAuditor({ agentLog, weather, converse: async () => text('{"note":"The forecast was off by 7.5 degrees in Dhaka."}'), models: ['m'], nowMs });
  const report = await agentLog.getState('quinn', 'latest');
  assert.equal(r.outcome, 'audited');
  assert.equal(report.noteBy, 'code', 'an invented number sends the note back, then the code note stands');
  assert.equal(report.cities[0].lead1.days, 14);
  assert.match(report.note, /off by/);

  const ok = parseAuditNote(JSON.stringify({ note: `In Dhaka the day-ahead peak was off by ${report.cities[0].lead1.maeC} °C over ${report.windowDays} days.` }), report);
  assert.match(ok.note, /Dhaka/);
  assert.throws(() => parseAuditNote('{"note":"Off by 9.9 °C."}', report), /did not produce/);
  assert.match(codeNote(report), /No Danger call went wrong|went wrong one day ahead/);
});

// ---------------------------------------------------------------- Iris
const lexiRun = (language, issues, at = '2026-09-29T12:00:00Z') => ({ at, detail: { language, issues } });
const issue = (quote, fix, category = 'word', severity = 'blocking') => ({ quote, fix, category, severity, problem: 'not a real word' });

test('Iris keeps only short, repeated, right-script corrections as candidates', () => {
  const runs = [
    lexiRun('hi', [issue('दोर्पर', 'दोपहर'), issue('धुंधला दिखना', 'धुंधला दिखाई देना', 'word'), issue('x', 'y', 'style', 'minor')]),
    lexiRun('hi', [issue('दोर्पर', 'दोपहर')]),
    lexiRun('hi', [issue('गर्मी', 'heat')]), // the fix is not in Devanagari
    lexiRun('ur', [issue('اگر کوئی بے ہوش ہو جائے یا بہت جوش ہو جائے تو', 'شدید تکلیف')]), // a phrase, not vocabulary
    lexiRun('tl', [issue('Mabalahibong', 'Labis na')]),
  ];
  const c = candidatesFrom(runs);
  assert.deepEqual(Object.keys(c).sort(), ['hi', 'tl']);
  assert.equal(c.hi[0].wrong, 'दोर्पर');
  assert.equal(c.hi[0].seen, 2, 'repeats are counted and ranked first');
  assert.ok(!c.hi.some((x) => x.use === 'heat'));
  assert.equal(candidatesFrom(runs, { hi: [{ wrong: 'दोर्पर' }] }).hi.some((x) => x.wrong === 'दोर्पर'), false, 'already on the list');
});

test('Iris publishes only what the second opinion confirms, and Mira then gets the word list', async () => {
  const { db, tables } = createFakeDb();
  const now = Date.parse('2026-09-30T02:30:00Z');
  const agentLog = createAgentLog({ db, table: tables.agentLog, nowMs: () => now });
  await agentLog.recordRun('lexi', { detail: { language: 'hi', issues: [issue('दोर्पर', 'दोपहर'), issue('दोंगे', 'लोग')] } });
  const verdicts = { verdicts: [{ id: 1, approve: true, meaning: 'midday' }, { id: 2, approve: false, meaning: 'people' }] };
  const r = await runCoach({ agentLog, converse: async () => text(JSON.stringify(verdicts)), models: ['m'], nowMs: () => now });
  assert.equal(r.outcome, 'coached');
  assert.match(r.summary, /added 1 word/);
  const list = await agentLog.getState('iris', 'glossary#hi');
  assert.deepEqual(list.entries.map((e) => [e.wrong, e.use, e.meaning]), [['दोर्पर', 'दोपहर', 'midday']]);

  const loader = createGlossaryLoader({ agentLog });
  const lines = await loader('hi');
  assert.equal(lines, '- "दोपहर" (midday), not "दोर्पर"');
  assert.match(buildSystemPrompt('Hindi', [], lines), /corrected in your earlier Hindi drafts[\s\S]*"दोपहर" \(midday\), not "दोर्पर"/);
  assert.doesNotMatch(buildSystemPrompt('Hindi', []), /corrected in your earlier/);

  let system = '';
  const good = { headline: 'आज बहुत गर्मी है।', actions: ['सुबह जल्दी काम करें।', 'दोपहर में छाया में आराम करें।', 'बार-बार पानी पिएं।'], seekHelp: 'भ्रम या बेहोशी हो तो स्थानीय आपातकालीन नंबर पर कॉल करें।' };
  const svc = createGuidanceService({ converse: async (p) => { system = p.system[0].text; return text(JSON.stringify(good)); }, cache: { get: async () => null, put: async () => {} }, models: ['w'], log: silentLog, glossary: loader });
  await svc.getGuidance(assessRisk(makeForecast({ nowHour: 9, temp: diurnal(27, 38), rh: () => 55 }), 'general'), 'hi');
  assert.match(system, /"दोपहर" \(midday\), not "दोर्पर"/);
});

test('the word list stays short: newest confirmed entries first, capped', () => {
  const old = Array.from({ length: MAX_WORDS }, (_, i) => ({ wrong: `w${i}`, use: `u${i}`, meaning: 'm' }));
  const merged = mergeGlossary(old, [{ wrong: 'new', use: 'NEW', meaning: 'n', seen: 3 }], '2026-09-30T00:00:00Z');
  assert.equal(merged.length, MAX_WORDS);
  assert.equal(merged[0].wrong, 'new');
  assert.equal(glossaryLines([]), '');
});

// ---------------------------------------------------------------- Kai's safest shift
test('Kai finds the 8-hour shift with the fewest Danger hours and compares it with 07:00-15:00', () => {
  // Midday heat: 36 °C at 50% humidity (Danger) from 10:00 to 16:59, mild otherwise.
  const hours = Array.from({ length: 36 }, (_, i) => {
    const t = new Date(Date.UTC(2026, 9, 1, i)).toISOString().slice(0, 16);
    const hour = i % 24;
    return { time: t, tempC: hour >= 10 && hour <= 16 ? 36 : 29, rh: 50 };
  });
  const s = bestShift(hours);
  assert.equal(s.day, '2026-10-01');
  assert.deepEqual(s.best, { start: '04:00', end: '12:00', dangerHours: 2, extremeCautionHours: 0 });
  assert.equal(s.standard.start, '07:00');
  assert.equal(s.standard.dangerHours, 5);
  const mild = hours.map((h) => ({ ...h, tempC: 24 }));
  assert.equal(bestShift(mild), null, 'no advice when the choice does not matter');
});
