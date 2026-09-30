/** Quinn (forecast audit), Iris (the team learns from its corrections) and Kai's safest shift. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyPeaks } from '../functions/lib/algorithms/verification.mjs';
import { runAuditor, verifyClaims, codeNote, dangerSentences } from '../functions/lib/agents/auditor.mjs';
import { candidatesFrom, runCoach, mergeGlossary, glossaryLines, createGlossaryLoader, MAX_WORDS, isWordLevel, changedWords } from '../functions/lib/agents/coach.mjs';
import { runSentinel, COOLER_CLAIM, withoutSentences } from '../functions/lib/agents/sentinel.mjs';
import { createStore } from '../functions/lib/store.mjs';
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

test('Quinn 30 Sep: the model called Karachi\'s Danger record "perfect" (it missed 2 days); claims are now checked by code', async () => {
  const karachi = { place: 'Karachi, Pakistan', lead1: { days: 14, maeC: 0.6, biasC: 0, tierAgreement: 0.86 }, lead3: { days: 14, maeC: 1, biasC: 0.3, tierAgreement: 0.71 }, danger: { hits: 4, misses: 2, falseAlarms: 0, correctNegatives: 8 } };
  const dubai = { place: 'Dubai, United Arab Emirates', lead1: { days: 14, maeC: 1.2, biasC: 0.5, tierAgreement: 1 }, lead3: { days: 14, maeC: 2.3, biasC: 1.3, tierAgreement: 1 }, danger: { hits: 14, misses: 0, falseAlarms: 0, correctNegatives: 0 } };
  const report = { windowDays: 14, cities: [karachi, dubai], overall: { lead1MaeC: 0.9, lead3MaeC: 1.7, lead1BiasC: 0.3 } };
  const { accepted, rejected } = verifyClaims([
    { city: 'Karachi', claim: 'reliable_danger_calls' },
    { city: 'Karachi', claim: 'most_accurate' },
    { city: 'Dubai', claim: 'ran_hot' },
    { city: 'Dubai', claim: 'reliable_danger_calls' },
    { city: 'Atlantis', claim: 'ran_hot' },
  ], report);
  assert.deepEqual(accepted.map((a) => a.sentence), [
    'Karachi: the most accurate forecast (off by 0.6 °C on average).',
    'Dubai: the forecast ran hot (+0.5 °C one day ahead, +1.3 °C three days ahead).',
    'Dubai: every day-ahead Danger forecast was right (14 of 14).',
  ]);
  assert.deepEqual(rejected.map((r) => `${r.city}:${r.claim}`), ['Karachi:reliable_danger_calls', 'Atlantis:ran_hot']);
  // The Danger errors are code's to report, for every city, whatever the model picks.
  assert.deepEqual(dangerSentences(report), ['Danger days the day-ahead forecast missed: Karachi 2.']);
  assert.match(codeNote(report), /off by 0\.9 °C on average, and by 1\.7 °C three days ahead\. Danger days the day-ahead forecast missed: Karachi 2\.$/);
  const live = { cities: [['Dhaka', 2, 3, 6], ['Ho Chi Minh City', 1, 2, 1], ['Cuiabá', 1, 1, 2], ['Phoenix', 2, 0, 0]].map(([place, misses, falseAlarms, hits]) => ({ place, danger: { hits, misses, falseAlarms } })) };
  assert.deepEqual(dangerSentences(live), ['Danger days the day-ahead forecast missed: Dhaka 2, Phoenix 2, Cuiabá 1, Ho Chi Minh City 1.', 'Day-ahead Danger forecasts that did not happen: Dhaka 3, Ho Chi Minh City 2, Cuiabá 1.']);
  assert.deepEqual(dangerSentences({ cities: [{ place: 'Lagos', danger: { hits: 0, misses: 0, falseAlarms: 0 } }] }), ['No city had a Danger day to forecast.']);
  assert.deepEqual(dangerSentences({ cities: [dubai] }), ['The day-ahead forecast caught every Danger day (14 of 14).']);
  // Mixed signs are not "ran hot"; "most accurate" needs something to compare with.
  const mixed = { ...dubai, lead1: { ...dubai.lead1, biasC: -0.6 }, lead3: { ...dubai.lead3, biasC: 0.8 } };
  assert.deepEqual(verifyClaims([{ city: 'Dubai', claim: 'ran_hot' }, { city: 'Dubai', claim: 'ran_cold' }], { ...report, cities: [mixed] }).accepted.map((a) => a.claim), ['ran_cold']);
  assert.equal(verifyClaims([{ city: 'Dubai', claim: 'most_accurate' }], { ...report, cities: [dubai] }).accepted.length, 0);
});

test('Quinn end to end: verified claims make the note; an unsupported one is recorded as rejected', async () => {
  const { db, tables } = createFakeDb();
  const agentLog = createAgentLog({ db, table: tables.agentLog });
  await agentLog.putState('sol', 'latest', { areas: [{ place: 'Dhaka, Bangladesh', lat: 23.8, lon: 90.4 }] });
  const days = Array.from({ length: 15 }, (_, i) => new Date(Date.UTC(2026, 8, 16 + i)).toISOString().slice(0, 10));
  const weather = { getPreviousRuns: async () => ({ hourly: previousRuns({ days, truth: days.map(() => 35), lead1: days.map(() => 36), lead3: days.map(() => 37) }), utcOffsetSeconds: 21600 }) };
  const claims = { claims: [{ city: 'Dhaka', claim: 'ran_hot' }, { city: 'Dhaka', claim: 'ran_cold' }, { city: 'Dhaka', claim: 'reliable_danger_calls' }] };
  const r = await runAuditor({ agentLog, weather, converse: async () => text(JSON.stringify(claims)), models: ['m'], nowMs: () => Date.parse('2026-09-30T01:30:00Z') });
  const report = await agentLog.getState('quinn', 'latest');
  assert.equal(r.outcome, 'audited');
  assert.equal(report.noteBy, 'model');
  assert.match(report.note, /^Over the last 14 days[\s\S]*caught every Danger day \(14 of 14\)\. Dhaka: the forecast ran hot[\s\S]*Dhaka: every day-ahead Danger forecast was right \(14 of 14\)/);
  assert.deepEqual(report.rejectedClaims.map((x) => x.claim), ['ran_cold']);
});

test('Quinn 30 Sep: a reply with too few claims (the prompt example, copied) is sent back', async () => {
  const { db, tables } = createFakeDb();
  const agentLog = createAgentLog({ db, table: tables.agentLog });
  await agentLog.putState('sol', 'latest', { areas: [{ place: 'Dhaka, Bangladesh', lat: 23.8, lon: 90.4 }, { place: 'Karachi, Pakistan', lat: 24.9, lon: 67 }] });
  const days = Array.from({ length: 15 }, (_, i) => new Date(Date.UTC(2026, 8, 16 + i)).toISOString().slice(0, 10));
  const weather = { getPreviousRuns: async (lat) => ({ hourly: previousRuns({ days, truth: days.map(() => 35), lead1: days.map(() => (lat > 24 ? 35 : 36)), lead3: days.map(() => 37) }), utcOffsetSeconds: 21600 }) };
  const seen = [];
  const replies = [{ claims: [{ city: 'Karachi', claim: 'ran_cold' }] }, { claims: [{ city: 'Dhaka', claim: 'ran_hot' }, { city: 'Karachi', claim: 'most_accurate' }, { city: 'Dhaka', claim: 'least_accurate' }] }];
  const converse = async ({ messages }) => { seen.push(messages.at(-1).content[0].text); return text(JSON.stringify(replies.shift())); };
  await runAuditor({ agentLog, weather, converse, models: ['m'], nowMs: () => Date.parse('2026-09-30T01:30:00Z') });
  assert.match(seen[1], /0 of your claims hold \(Karachi ran_cold: not supported by the scores\); choose at least 2/);
  const report = await agentLog.getState('quinn', 'latest');
  assert.equal(report.noteBy, 'model');
  assert.match(report.note, /Dhaka: the forecast ran hot[\s\S]*Karachi: the most accurate[\s\S]*Dhaka: the least accurate/);
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

test('Iris 30 Sep: only word-level fixes go on the list; "means X here" and style choices stay out', () => {
  // Real corrections from the first run.
  assert.equal(isWordLevel("'بے ہوشی' means 'unconsciousness', and the context suggests dizziness", 'بے ہوشی', 'چکر آنا'), false, 'would have removed a heat-stroke sign');
  assert.equal(isWordLevel("'Malubhang pag-init' is not the correct term for 'Extreme Caution'", 'malubhang pag-init', 'labis na pag-iingat'), false);
  assert.equal(isWordLevel("'matokeo' means 'results', which does not fit the context", 'matokeo makini sana', 'hatua makini sana'), false);
  assert.equal(isWordLevel("The phrase 'धुंधला दिखना' is not idiomatic.", 'धुंधला दिखना', 'धुंधला दिखाई देना'), false);
  assert.equal(isWordLevel("'تھڑی' is not a correct Urdu word. The correct word for 'midday' is 'دوپہر'.", 'تھڑی دھوپ', 'دوپہر کی دھوپ'), true);
  assert.equal(isWordLevel("Incorrect word; should be 'ठंडा पानी'", 'चंदा पानि', 'ठंडा पानी'), true, 'a small edit of the same phrase');
  assert.equal(isWordLevel("'Mtelezaji' is not a real Swahili word. It seems intended to mean 'anyone'.", 'mtelezaji', 'mtu yeyote'), true);
  // Measured on the changed words only: a swapped word inside a shared phrase is not a spelling fix.
  assert.deepEqual(changedWords('مستوى الخطر شديد', 'مستوى الخطر مرتفع'), ['شديد', 'مرتفع']);
  assert.equal(isWordLevel('Incorrect word choice', 'مستوى الخطر شديد', 'مستوى الخطر مرتفع'), false, 'severe -> high softens a warning');
  assert.equal(isWordLevel('Incorrect word', 'trà nước lạnh', 'nước lạnh'), false, 'dropping "tea" changes what is said');
  assert.equal(isWordLevel('Wrong verb form', 'lome descansos', 'tome descansos'), true);
});

test('Iris: a phrase with two different fixes, or one that is both a fix and a mistake, is left out', () => {
  const run = (issues) => ({ at: '2026-09-30T00:00:00Z', detail: { language: 'tl', issues: issues.map(([quote, fix]) => ({ severity: 'blocking', category: 'word', quote, fix, problem: 'misspelled' })) } });
  const out = candidatesFrom([run([['malalim na init', 'masidhing init'], ['malalim na init', 'malubhang init'], ['inaasahang sa', 'inaasahan sa']])]);
  assert.deepEqual(out.tl.map((c) => c.wrong), ['inaasahang sa']);
  const chain = candidatesFrom([run([['malalim na pag-init', 'malubhang pag-init'], ['malubhang pag-init', 'labis na pag-iingat']])]);
  assert.equal(chain.tl, undefined);
  const againstList = candidatesFrom([run([['mag-ingat', 'mag-iingat']])], { tl: [{ wrong: 'mag-iingat', use: 'mag-ingat', meaning: 'be careful' }] });
  assert.equal(againstList.tl, undefined, 'the list already says the opposite');
});

test('Sol 30 Sep: "Dhaka is cooler than usual" is sent back; if it comes back again, the sentence is dropped', async () => {
  assert.ok(COOLER_CLAIM.test('Ho Chi Minh City and Dhaka are cooler than usual for this time of year.'));
  assert.ok(!COOLER_CLAIM.test('Dhaka is not unusually hot for the season.'));
  assert.equal(withoutSentences('Dubai is hot. Dhaka is cooler than usual. Watch nights.', COOLER_CLAIM), 'Dubai is hot. Watch nights.');
  const { db, tables } = createFakeDb();
  const agentLog = createAgentLog({ db, table: tables.agentLog });
  const store = createStore({ db, tables });
  await db.put({ table: 'locations', item: { locationId: 'l1', lat: 25.2, lon: 55.27, placeName: 'Dubai', profile: 'outdoor_worker' } });
  const dates = Array.from({ length: 38 }, (_, i) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10));
  const weather = { getForecast: async () => makeForecast({ nowHour: 9, temp: diurnal(27, 38), rh: () => 55 }), getDaily: async () => ({ dates, today: dates[31], tmax: Array(38).fill(38), tmin: Array(38).fill(29) }) };
  const reply = (briefing) => text(JSON.stringify({ briefing, events: [{ areaId: 'A1', level: 'warning' }] }));
  const replies = [reply('Dubai has dangerous heat. Lagos is cooler than usual.'), reply('Dubai has dangerous heat. Lagos is colder than normal this week.')];
  await runSentinel({ store, weather, climate: { get: async () => null }, agentLog, converse: async () => replies.shift(), models: ['m'], retryPauseMs: 0 });
  assert.equal((await agentLog.getState('sol', 'latest')).briefing, 'Dubai has dangerous heat.');
  // A briefing that is nothing but the false claim is never published as is.
  const only = [reply('Lagos is cooler than usual.'), reply('Lagos is colder than normal.'), reply('Dubai has dangerous heat on Friday.')];
  await runSentinel({ store, weather, climate: { get: async () => null }, agentLog, converse: async () => only.shift(), models: ['m'], retryPauseMs: 0, nowMs: () => Date.now() + 7 * 3600_000 });
  assert.equal((await agentLog.getState('sol', 'latest')).briefing, 'Dubai has dangerous heat on Friday.');
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
