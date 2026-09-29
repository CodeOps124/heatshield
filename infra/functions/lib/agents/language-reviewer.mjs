/**
 * LEXI — Language Reviewer agent.
 * Expertise encoded: professional translation review and plain-language editing.
 * Algorithm: naive-Bayes / script language identification (algorithms/langid.mjs) as a free,
 * deterministic first gate, then an LLM literal back-translation + categorised issue list.
 * Decision power: approve, or send the draft back to the Health Advisor with specific fixes.
 *
 * Calibration (from live runs on 2026-09-29): the first version let the model decide the verdict
 * and it rejected correct English over style ("Heat will rise…" vs "Heat risk will rise…"). Now
 * every issue has a category, only real errors are BLOCKING, and CODE computes the verdict.
 */
import { runAgent, extractJson } from '../agent-runtime.mjs';
import { languageMatches } from '../algorithms/langid.mjs';
import { LANGUAGES } from '../languages.mjs';

const BLOCKING = new Set(['word', 'grammar', 'language', 'fact']);
const clean = (s, n) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const allText = (g) => [g.headline, ...g.actions, g.seekHelp].join(' ');

export function parseLanguageReview(text) {
  const raw = extractJson(text);
  if (!raw || typeof raw !== 'object' || !raw.backTranslation || typeof raw.backTranslation !== 'object') {
    throw new Error('Language review needs a backTranslation object');
  }
  const bt = raw.backTranslation;
  const issues = (Array.isArray(raw.issues) ? raw.issues : []).slice(0, 8).map((i) => {
    const category = BLOCKING.has(i?.category) ? i.category : 'style';
    return {
      quote: clean(i?.quote, 200),
      category,
      severity: BLOCKING.has(category) ? 'blocking' : 'minor',
      problem: clean(i?.problem, 300),
      fix: clean(i?.fix, 200),
    };
  }).filter((i) => i.problem);
  return {
    // The model's own verdict is not trusted; blocking issues decide.
    verdict: issues.some((i) => i.severity === 'blocking') ? 'revise' : 'approve',
    backTranslation: {
      headline: clean(bt.headline, 300),
      actions: Array.isArray(bt.actions) ? bt.actions.map((a) => clean(a, 400)).filter(Boolean).slice(0, 4) : [],
      seekHelp: clean(bt.seekHelp, 400),
    },
    issues,
  };
}

export function createLanguageReviewer({ converse, models }) {
  return {
    name: 'lexi',
    async review(guidance, { language, factsSummary, deadline }) {
      // Gate 1 (algorithmic, free): is the text even in the right language?
      const lm = languageMatches(allText(guidance), language);
      if (!lm.ok) {
        return {
          verdict: 'revise',
          method: 'langid',
          detected: lm.id,
          issues: [{ quote: '', category: 'language', severity: 'blocking', problem: `Text is not in ${LANGUAGES[language].name}: language ID detected "${lm.id.lang}" (${lm.id.method}, confidence ${lm.id.confidence}).`, fix: `Rewrite entirely in ${LANGUAGES[language].name}.` }],
          backTranslation: null,
          usage: { inputTokens: 0, outputTokens: 0 },
          model: null,
        };
      }

      // Gate 2 (LLM): literal back-translation and categorised review.
      const name = LANGUAGES[language].name;
      const res = await runAgent({
        agent: {
          name: 'lexi',
          models,
          maxTurns: 1,
          maxTokens: 1400,
          system: `You are Lexi, HeatShield's language reviewer: a professional translator and native-level editor of ${name}. You check short heat-safety messages for the public. You catch real language errors and false statements. You do NOT rewrite for style: correct, clear wording is fine even if you would phrase it differently.`,
          tools: [],
        },
        input: `Facts the message is based on:\n${factsSummary}\n\nMessage (in ${name}):\n${JSON.stringify({ headline: guidance.headline, actions: guidance.actions, seekHelp: guidance.seekHelp })}\n\n1. Translate the message into English LITERALLY. Keep any mistakes visible; do not fix them.\n2. List problems, each with a category:\n   - "word": not a real ${name} word, misspelled, or the wrong word for the meaning (for example a word meaning "old age" where "heat" is meant)\n   - "grammar": grammar a native reader would stumble on\n   - "language": text that is not in ${name} (numbers and clock times are fine)\n   - "fact": a statement the facts CONTRADICT (a wrong clock time, calling the risk low when it is high or high when it is low). Missing detail is NOT a fact error.\n   - "style": anything else (could be clearer, more specific, different wording). Style never needs a rewrite.\n   If the message has no problems, return an empty list.\n\nReply with ONLY this JSON:\n{"backTranslation":{"headline":"...","actions":["..."],"seekHelp":"..."},"issues":[{"quote":"exact words","category":"word|grammar|language|fact|style","problem":"...","fix":"corrected words in ${name}"}]}`,
        converse,
        deadline,
        validate: parseLanguageReview,
      });
      return { ...res.value, method: 'langid+llm', detected: lm.id, usage: res.usage, model: res.model };
    },
  };
}
