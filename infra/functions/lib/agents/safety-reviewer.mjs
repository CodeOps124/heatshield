/**
 * VERA — Safety Reviewer agent.
 * Expertise encoded: clinical-safety review against vetted CDC/NIOSH/NWS guidance.
 * Algorithm: deterministic detectors (phone numbers, medicine names, doses) that fire before any
 * model is called, then an LLM-as-judge with a fixed rubric. Each issue carries a rule; code decides
 * which rules are blocking (the first live version rejected "a cup every 15 minutes" because the
 * fact says "15 to 20" — safe, and within the hourly limit — so the verdict is no longer the model's).
 * Decision power: approve, or send the draft back citing the rule it broke.
 */
import { runAgent, extractJson } from '../agent-runtime.mjs';

const clean = (s, n) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');

// International drug names are written the same way across Latin-script languages.
const MEDICINES = /\b(paracetamol|acetaminophen|ibuprofen|aspirin|aspirina|diclofenac|naproxen|salt tablets?|tabletas de sal)\b/iu;
const DOSE = /\b\d+(?:[.,]\d+)?\s?(?:mg|mcg|µg|milligrams?|miligramos?)\b/iu;
const PHONE = /(?:\+?\d[\s-]?){7,}/u; // 7+ digits: a phone number, never a time ("13:00") or range ("15-20")

// Rubric rules and whether a violation blocks publication.
export const RULES = Object.freeze({
  a: { blocking: true, text: 'gives a phone number, or names a medicine or dose' },
  b: { blocking: true, text: 'breaks a safety LIMIT in the vetted facts in a way that could cause harm (for example more than about 1.5 litres of water per hour, or a fan as the main cooling in extreme heat). Small variations inside the safe range (for example "a cup every 15 minutes") are NOT violations' },
  c: { blocking: true, text: 'gives advice that could cause harm (for example alcohol, hot baths, heavy exertion during the risky hours, salt tablets)' },
  d: { blocking: true, text: 'never tells people to call the local emergency number for heat-stroke signs' },
  e: { blocking: false, text: 'tone does not match the risk (alarmist when risk is low, too relaxed when risk is Danger or worse)' },
});

/** Deterministic safety rules. Returns issues; empty means nothing tripped. */
export function detectRuleViolations(guidance) {
  const issues = [];
  for (const part of [guidance.headline, ...guidance.actions, guidance.seekHelp]) {
    const phone = part.match(PHONE);
    if (phone) issues.push({ quote: phone[0].trim(), rule: 'a', severity: 'blocking', problem: 'Contains a phone number; numbers must not be invented.', fix: 'Say "your local emergency number" instead.', detector: 'phone' });
    const med = part.match(MEDICINES);
    if (med) issues.push({ quote: med[0], rule: 'a', severity: 'blocking', problem: 'Names a medicine; medicine advice is outside HeatShield\'s vetted facts.', fix: 'Remove the medicine; suggest asking a doctor or pharmacist.', detector: 'medicine' });
    const dose = part.match(DOSE);
    if (dose) issues.push({ quote: dose[0], rule: 'a', severity: 'blocking', problem: 'Contains a dose.', fix: 'Remove the dose.', detector: 'dose' });
  }
  return issues;
}

export function parseSafetyReview(text) {
  const raw = extractJson(text);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.issues)) throw new Error('Safety review needs an issues array');
  const issues = raw.issues.slice(0, 8).map((i) => {
    const rule = Object.hasOwn(RULES, i?.rule) ? i.rule : 'e';
    return {
      quote: clean(i?.quote, 200),
      rule,
      severity: RULES[rule].blocking ? 'blocking' : 'minor',
      problem: clean(i?.problem, 300),
      fix: clean(i?.fix, 200),
    };
  }).filter((i) => i.problem);
  return { verdict: issues.some((i) => i.severity === 'blocking') ? 'revise' : 'approve', issues };
}

export function createSafetyReviewer({ converse, models }) {
  return {
    name: 'vera',
    async review(guidance, { factsList, situation, deadline }) {
      const ruleIssues = detectRuleViolations(guidance);
      if (ruleIssues.length) {
        return { verdict: 'revise', method: 'rules', issues: ruleIssues, usage: { inputTokens: 0, outputTokens: 0 }, model: null };
      }
      const res = await runAgent({
        agent: {
          name: 'vera',
          models,
          maxTurns: 1,
          maxTokens: 900,
          system: 'You are Vera, HeatShield\'s clinical safety reviewer. You check public heat-safety messages against a fixed list of vetted public-health facts. You judge safety only, not style or completeness. The message may be in any language; read it in that language. Report only real violations of the rules you are given; if there are none, return an empty list.',
          tools: [],
        },
        input: `Vetted facts (the only advice allowed):\n${factsList}\n\nThe person's situation:\n${situation}\n\nMessage to review:\n${JSON.stringify({ headline: guidance.headline, actions: guidance.actions, seekHelp: guidance.seekHelp })}\n\nReport a problem only if the message:\n${Object.entries(RULES).map(([k, r]) => `(${k}) ${r.text};`).join('\n')}\n\nReply with ONLY this JSON (empty "issues" if nothing applies):\n{"issues":[{"quote":"exact words","rule":"a|b|c|d|e","problem":"...","fix":"..."}]}`,
        converse,
        deadline,
        validate: parseSafetyReview,
      });
      return { ...res.value, method: 'rules+llm', usage: res.usage, model: res.model };
    },
  };
}
