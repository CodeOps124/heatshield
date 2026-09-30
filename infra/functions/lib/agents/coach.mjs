/**
 * IRIS — Learning Coach agent (daily). Expertise encoded: terminology management for translators.
 * The team learns from its own mistakes: Lexi's corrections of Mira's words become a per-language
 * word list that Mira is given for every later plan in that language.
 * Algorithm (the exact part): from the last 7 days of Lexi's blocking word/grammar issues, keep only
 * term-level corrections (short, in the right script, different from the original), normalise and
 * count repeats, drop what the list already has, rank by how often the mistake recurred.
 * Model (the judgment part): a strict second opinion on each proposed entry. Only entries it
 * confirms are published; Lexi herself was sometimes wrong (she called the standard Vietnamese
 * "bất tỉnh", unconscious, uncommon), so nothing reaches Mira on one reviewer's say-so.
 */
import { runAgent, extractJson } from '../agent-runtime.mjs';
import { LANGUAGES } from '../languages.mjs';

export const MAX_WORDS = 12; // per language; short enough to fit in every prompt
const MAX_CANDIDATES = 10; // per language and run (cost bound)
const clean = (s, n) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const norm = (s) => clean(s, 80).normalize('NFC').toLowerCase().replace(/^[\s"'«»“”‘’.,;:!?()]+|[\s"'«»“”‘’.,;:!?()]+$/g, '');
const words = (s) => s.split(/\s+/).filter(Boolean).length;

/** Term-level corrections from Lexi's runs, counted by (language, wrong, right). */
export function candidatesFrom(runs, glossaries = {}) {
  const found = new Map();
  for (const run of runs) {
    const lang = run.detail?.language;
    if (!LANGUAGES[lang]) continue;
    for (const issue of run.detail?.issues ?? []) {
      if (issue.severity !== 'blocking' || !['word', 'grammar'].includes(issue.category)) continue;
      const wrong = norm(issue.quote);
      const use = norm(issue.fix);
      if (!wrong || !use || wrong === use) continue;
      if (words(wrong) > 3 || words(use) > 3 || wrong.length > 32 || use.length > 32) continue; // phrases are not vocabulary
      if (LANGUAGES[lang].script && !LANGUAGES[lang].script.test(use)) continue; // the fix must be in the language's script
      if ((glossaries[lang] ?? []).some((e) => e.wrong === wrong)) continue;
      const key = `${lang}|${wrong}|${use}`;
      const c = found.get(key) ?? { language: lang, wrong, use, note: clean(issue.problem, 200), seen: 0, lastSeen: run.at };
      c.seen += 1;
      if (run.at > c.lastSeen) c.lastSeen = run.at;
      found.set(key, c);
    }
  }
  const byLang = {};
  for (const c of [...found.values()].sort((a, b) => b.seen - a.seen || b.lastSeen.localeCompare(a.lastSeen))) {
    (byLang[c.language] ??= []).length < MAX_CANDIDATES && byLang[c.language].push(c);
  }
  return byLang;
}

export function parseVerdicts(text, count) {
  const raw = extractJson(text);
  if (!Array.isArray(raw?.verdicts)) throw new Error('Reply needs a verdicts array');
  return Array.from({ length: count }, (_, i) => {
    const v = raw.verdicts.find((x) => Number(x?.id) === i + 1);
    return { approve: v?.approve === true, meaning: clean(v?.meaning, 60) };
  });
}

/** New list = confirmed entries first, then the older ones, capped. */
export function mergeGlossary(existing, confirmed, atIso) {
  const fresh = confirmed.map((c) => ({ wrong: c.wrong, use: c.use, meaning: c.meaning, seen: c.seen, addedAt: atIso }));
  const kept = (existing ?? []).filter((e) => !fresh.some((f) => f.wrong === e.wrong));
  return [...fresh, ...kept].slice(0, MAX_WORDS);
}

export async function runCoach({ agentLog, converse, models, allowModel = true, nowMs = () => Date.now(), deadline = Date.now() + 100_000 }) {
  const since = new Date(nowMs() - 7 * 86_400_000).toISOString();
  const runs = await agentLog.listRunsSince('lexi', since);
  const glossaries = {};
  for (const lang of Object.keys(LANGUAGES)) {
    glossaries[lang] = (await agentLog.getState('iris', `glossary#${lang}`).catch(() => null))?.entries ?? [];
  }
  const byLang = candidatesFrom(runs, glossaries);
  const langs = Object.keys(byLang);
  const reviewed = runs.reduce((n, r) => n + (r.detail?.issues ?? []).filter((i) => i.severity === 'blocking').length, 0);
  if (!langs.length) {
    return { outcome: 'idle', summary: `Read ${reviewed} blocking corrections from the last 7 days: no new term-level mistakes to learn from.` };
  }
  if (!allowModel) {
    return { outcome: 'paused', summary: `${langs.reduce((n, l) => n + byLang[l].length, 0)} candidate words waiting: AI work is paused, and no entry is published without a second opinion.` };
  }

  const usage = { inputTokens: 0, outputTokens: 0 };
  let usedModel = null;
  const added = {};
  let rejected = 0;
  for (const lang of langs) {
    if (deadline - Date.now() < 15_000) break;
    const list = byLang[lang];
    const name = LANGUAGES[lang].name;
    try {
      const run = await runAgent({
        agent: {
          name: 'iris',
          models,
          maxTurns: 1,
          maxTokens: 900,
          system: `You are Iris, HeatShield's language coach. A reviewer corrected words in ${name} heat-safety messages. You decide which corrections go on the word list the writer must follow. Be strict: approve only when the suggested word is correct, everyday ${name} for its meaning, and the original was wrong or misspelled for that meaning. Reject anything you are not sure about.`,
          tools: [],
        },
        input: `Proposed corrections (${name}):\n${list.map((c, i) => `${i + 1}. wrong: "${c.wrong}" -> suggested: "${c.use}" (reviewer's note: ${c.note})`).join('\n')}\n\nReply with ONLY this JSON:\n{"verdicts":[{"id":1,"approve":true,"meaning":"English meaning of the suggested word"}]}`,
        converse,
        deadline,
        validate: (text) => parseVerdicts(text, list.length),
      });
      usage.inputTokens += run.usage.inputTokens;
      usage.outputTokens += run.usage.outputTokens;
      usedModel = run.model;
      const confirmed = list.map((c, i) => ({ ...c, ...run.value[i] })).filter((c) => c.approve && c.meaning);
      rejected += list.length - confirmed.length;
      if (confirmed.length) {
        const entries = mergeGlossary(glossaries[lang], confirmed, new Date(nowMs()).toISOString());
        await agentLog.putState('iris', `glossary#${lang}`, { language: lang, entries });
        added[lang] = confirmed.length;
      }
    } catch {
      // A failed check publishes nothing for this language; next day's run tries again.
    }
  }
  const total = Object.values(added).reduce((a, b) => a + b, 0);
  const list = Object.entries(added).map(([l, n]) => `${l} ${n}`).join(', ');
  const state = { generatedAt: new Date(nowMs()).toISOString(), reviewed, added, rejected, sizes: Object.fromEntries(Object.entries(glossaries).map(([l, e]) => [l, added[l] ? Math.min(MAX_WORDS, e.length + added[l]) : e.length]).filter(([, n]) => n)) };
  await agentLog.putState('iris', 'latest', state);
  return {
    outcome: total ? 'coached' : 'nothing-confirmed',
    summary: `Read ${reviewed} corrections from the last 7 days; added ${total} word(s) to Mira's lists${list ? ` (${list})` : ''}; ${rejected} proposed correction(s) rejected on a second look.`,
    model: usedModel, usage,
    detail: state,
  };
}

/** The lines Mira gets, e.g.  - "दोपहर" (midday), not "दोर्पर" */
export function glossaryLines(entries) {
  return (entries ?? []).map((e) => `- "${e.use}" (${e.meaning}), not "${e.wrong}"`).join('\n');
}

/** Mira's word list per language, read from the agent log at most every 10 minutes per language. */
export function createGlossaryLoader({ agentLog, ttlMs = 600_000, nowMs = () => Date.now() }) {
  const cache = new Map();
  return async (lang) => {
    const hit = cache.get(lang);
    if (hit && nowMs() - hit.at < ttlMs) return hit.value;
    const state = await agentLog.getState('iris', `glossary#${lang}`).catch(() => null);
    const value = glossaryLines(state?.entries);
    cache.set(lang, { at: nowMs(), value });
    return value;
  };
}
