/**
 * LEXI — Language Reviewer agent.
 * Expertise encoded: professional translation review and plain-language editing.
 * Algorithm: naive-Bayes / script language identification (algorithms/langid.mjs) as a free,
 * deterministic first gate, then an LLM literal back-translation + word-level issue list.
 * Decision power: approve, or send the draft back to the Health Advisor with specific fixes.
 */
import { runAgent, extractJson } from '../agent-runtime.mjs';
import { languageMatches } from '../algorithms/langid.mjs';
import { LANGUAGES } from '../languages.mjs';

const clean = (s, n) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const allText = (g) => [g.headline, ...g.actions, g.seekHelp].join(' ');

export function parseLanguageReview(text) {
  const raw = extractJson(text);
  const verdict = raw.verdict === 'approve' ? 'approve' : raw.verdict === 'revise' ? 'revise' : null;
  if (!verdict) throw new Error('Language review had no verdict');
  const bt = raw.backTranslation ?? {};
  return {
    verdict,
    backTranslation: {
      headline: clean(bt.headline, 300),
      actions: Array.isArray(bt.actions) ? bt.actions.map((a) => clean(a, 400)).filter(Boolean).slice(0, 4) : [],
      seekHelp: clean(bt.seekHelp, 400),
    },
    issues: (Array.isArray(raw.issues) ? raw.issues : []).slice(0, 8).map((i) => ({
      quote: clean(i?.quote, 200),
      problem: clean(i?.problem, 300),
      fix: clean(i?.fix, 200),
    })).filter((i) => i.problem),
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
          issues: [{ quote: '', problem: `Text is not in ${LANGUAGES[language].name}: language ID detected "${lm.id.lang}" (${lm.id.method}, confidence ${lm.id.confidence}).`, fix: `Rewrite entirely in ${LANGUAGES[language].name}.` }],
          backTranslation: null,
          usage: { inputTokens: 0, outputTokens: 0 },
          model: null,
        };
      }

      // Gate 2 (LLM): literal back-translation and word-level review.
      const name = LANGUAGES[language].name;
      const res = await runAgent({
        agent: {
          name: 'lexi',
          models,
          maxTurns: 1,
          maxTokens: 1400,
          system: `You are Lexi, HeatShield's language reviewer: a professional translator and plain-language editor. You review short heat-safety messages written for the public in ${name}. Be strict about real words, correct word choice and faithful meaning; be lenient about style.`,
          tools: [],
        },
        input: `Facts the message must match:\n${factsSummary}\n\nMessage (in ${name}):\n${JSON.stringify({ headline: guidance.headline, actions: guidance.actions, seekHelp: guidance.seekHelp })}\n\nDo three things:\n1. Translate the message into English LITERALLY. Keep any mistakes visible in the translation; do not fix them.\n2. List every problem: words that are not real ${name} words or are the wrong word for the meaning, text not in ${name}, grammar a native reader would stumble on, meaning that contradicts the facts (wrong clock times or risk level), or jargon. Quote the exact words.\n3. verdict: "approve" if a native ${name} speaker would find it correct, clear and faithful to the facts; otherwise "revise".\n\nReply with ONLY this JSON:\n{"backTranslation":{"headline":"...","actions":["..."],"seekHelp":"..."},"issues":[{"quote":"exact words","problem":"...","fix":"corrected words in ${name}"}],"verdict":"approve"}`,
        converse,
        deadline,
      });
      return { ...parseLanguageReview(res.text), method: 'langid+llm', detected: lm.id, usage: res.usage, model: res.model };
    },
  };
}
