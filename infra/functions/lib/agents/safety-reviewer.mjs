/**
 * VERA — Safety Reviewer agent.
 * Expertise encoded: clinical-safety review against vetted CDC/NIOSH/NWS guidance.
 * Algorithm: deterministic detectors (phone numbers, medicine names, doses) that fire before any
 * model is called, then an LLM-as-judge with a fixed five-rule rubric.
 * Decision power: approve, or send the draft back with the rule it broke and a fix.
 */
import { runAgent, extractJson } from '../agent-runtime.mjs';

const clean = (s, n) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');

// International drug names are written the same way across Latin-script languages.
const MEDICINES = /\b(paracetamol|acetaminophen|ibuprofen|aspirin|aspirina|diclofenac|naproxen|salt tablets?|tabletas de sal)\b/iu;
const DOSE = /\b\d+(?:[.,]\d+)?\s?(?:mg|mcg|µg|milligrams?|miligramos?)\b/iu;
const PHONE = /(?:\+?\d[\s-]?){7,}/u; // 7+ digits: a phone number, never a time ("13:00") or range ("15-20")

/** Deterministic safety rules. Returns issues; empty means nothing tripped. */
export function detectRuleViolations(guidance) {
  const issues = [];
  for (const part of [guidance.headline, ...guidance.actions, guidance.seekHelp]) {
    const phone = part.match(PHONE);
    if (phone) issues.push({ quote: phone[0].trim(), rule: 'a', problem: 'Contains a phone number; numbers must not be invented.', fix: 'Say "your local emergency number" instead.', detector: 'phone' });
    const med = part.match(MEDICINES);
    if (med) issues.push({ quote: med[0], rule: 'a', problem: 'Names a medicine; medicine advice is outside HeatShield\'s vetted facts.', fix: 'Remove the medicine; suggest asking a doctor or pharmacist.', detector: 'medicine' });
    const dose = part.match(DOSE);
    if (dose) issues.push({ quote: dose[0], rule: 'a', problem: 'Contains a dose.', fix: 'Remove the dose.', detector: 'dose' });
  }
  return issues;
}

export function parseSafetyReview(text) {
  const raw = extractJson(text);
  const verdict = raw.verdict === 'approve' ? 'approve' : raw.verdict === 'revise' ? 'revise' : null;
  if (!verdict) throw new Error('Safety review had no verdict');
  return {
    verdict,
    issues: (Array.isArray(raw.issues) ? raw.issues : []).slice(0, 8).map((i) => ({
      quote: clean(i?.quote, 200),
      rule: clean(i?.rule, 2),
      problem: clean(i?.problem, 300),
      fix: clean(i?.fix, 200),
    })).filter((i) => i.problem),
  };
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
          system: 'You are Vera, HeatShield\'s clinical safety reviewer. You check public heat-safety messages against a fixed list of vetted public-health facts. You judge safety only, not style. The message may be in any language; read it in that language.',
          tools: [],
        },
        input: `Vetted facts (the only advice allowed):\n${factsList}\n\nThe person's situation:\n${situation}\n\nMessage to review:\n${JSON.stringify({ headline: guidance.headline, actions: guidance.actions, seekHelp: guidance.seekHelp })}\n\nFlag anything that:\n(a) gives a phone number, or names a medicine or dose;\n(b) contradicts a vetted fact (for example more than about 1.5 litres of water per hour, or a fan as the main cooling in extreme heat);\n(c) could cause harm (for example alcohol, hot baths, heavy exertion during the risky hours, salt tablets);\n(d) fails to say what to do in an emergency (it must tell people to call the local emergency number for heat-stroke signs);\n(e) is alarmist when risk is low, or too relaxed when risk is Danger or worse.\nverdict: "approve" if none apply; otherwise "revise".\n\nReply with ONLY this JSON:\n{"issues":[{"quote":"exact words","rule":"a","problem":"...","fix":"..."}],"verdict":"approve"}`,
        converse,
        deadline,
      });
      return { ...parseSafetyReview(res.text), method: 'rules+llm', usage: res.usage, model: res.model };
    },
  };
}
