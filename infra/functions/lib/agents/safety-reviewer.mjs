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
import { sameText } from '../util.mjs';

// Omissions are not violations, except the emergency advice (rule d). Live, the model still filed
// "does not specify the amount of water, which could lead to overhydration" under rule b.
const OMISSION = /\b(?:does not|doesn't|did not|fails to|no mention|not mention|missing|lacks|should (?:also )?(?:advise|mention|specify|include|say|state))\b/i;

const clean = (s, n) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');

// Rule (d) is the one omission that blocks: the emergency advice. These are the words each language
// uses for it in live plans and in the reviewers' quotes (30 Sep; Urdu writes "امدادی نمبر", an aid
// number, Swahili "simu ya dharura" or "nambari ya msaada"); Indonesian and Tagalog from standard
// usage, with no live sample yet. When the help sentence has one, "never tells people to call the
// local emergency number" is refuted by the message itself, and what remains is a completeness note
// (30 Sep, Arabic: "should also list other heat-stroke signs" sent a correct plan to the fallback).
const EMERGENCY = {
  en: /emergency/i, es: /emergencia/i, fr: /urgence/i, pt: /emerg[êe]ncia/i,
  ar: /طوارئ|إسعاف|اسعاف/u, ur: /امداد|ایمرجنسی|ہنگامی/u, hi: /आपात/u, bn: /জরুরি/u,
  zh: /紧急|急救/u, vi: /khẩn cấp|cấp cứu/iu, id: /darurat/i, tl: /emergency|emerhensi?ya/i, sw: /dharura|msaada/i,
};
export const namesEmergencyNumber = (guidance, language) => Boolean(EMERGENCY[language]?.test(String(guidance?.seekHelp ?? '').normalize('NFC')));

/** Objections the message itself refutes become notes. */
export function refuteByMessage(issues, guidance, language) {
  for (const i of issues) {
    if (i.severity !== 'blocking' || i.detector) continue;
    if (sameText(i.quote, i.fix)) Object.assign(i, { severity: 'minor', problem: `${i.problem} (the suggested fix is the text as written)` });
    else if (i.rule === 'd' && namesEmergencyNumber(guidance, language)) Object.assign(i, { severity: 'minor', problem: `${i.problem} (the help sentence does tell people to call the emergency number)` });
  }
  return issues;
}

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
    const problem = clean(i?.problem, 300);
    return {
      quote: clean(i?.quote, 200),
      rule,
      severity: RULES[rule].blocking && (rule === 'd' || !OMISSION.test(problem)) ? 'blocking' : 'minor',
      problem,
      fix: clean(i?.fix, 200),
    };
  }).filter((i) => i.problem);
  return { verdict: issues.some((i) => i.severity === 'blocking') ? 'revise' : 'approve', issues };
}

// Chain-of-verification for harm objections (rules b and c). Seen live on an Arabic plan: Vera blocked
// "cold water as the main cooling" and "a fan as the main cooling" while quoting a sentence about
// light clothing that mentions neither. A blocking harm objection now has to survive a second reading
// that copies the exact words giving the harmful advice, and code checks those words are really there.
// Compared without punctuation or diacritics, so evidence that drops an Arabic kasra still matches.
const norm = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();

export function evidenceInMessage(evidence, guidance) {
  const e = norm(evidence);
  return e.length >= 4 && norm([guidance.headline, ...guidance.actions, guidance.seekHelp].join(' ')).includes(e);
}

export function parseVerification(text, count) {
  const raw = extractJson(text);
  if (!Array.isArray(raw?.verdicts)) throw new Error('Verification needs a verdicts array');
  return Array.from({ length: count }, (_, i) => {
    const v = raw.verdicts.find((x) => Number(x?.id) === i + 1);
    return { confirmed: v?.confirmed === true, evidence: clean(v?.evidence, 300) };
  });
}

export function createSafetyReviewer({ converse, models }) {
  return {
    name: 'vera',
    async review(guidance, { factsList, situation, deadline, language }) {
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
          system: 'You are Vera, HeatShield\'s clinical safety reviewer. You check public heat-safety messages against a fixed list of vetted public-health facts. You judge safety only, not style or completeness. The message may be in any language; read it in that language. Advice the vetted facts recommend (water, shade, rest, loose light clothing, a hat or head covering, cool showers, checking on others) is never a violation, and you do not invent risks the facts do not mention. Everyday words for a risk level are fine, and a missing detail is not a violation unless it is the emergency advice in rule (d). Report only real violations of the rules you are given; if there are none, return an empty list. Write each "problem" in English; "quote" and "fix" stay in the message\'s own language.',
          tools: [],
        },
        input: `Vetted facts (the standard: advice that agrees with any of them is correct, even when worded or rounded differently):\n${factsList}\n\nThe person's situation:\n${situation}\n\nMessage to review:\n${JSON.stringify({ headline: guidance.headline, actions: guidance.actions, seekHelp: guidance.seekHelp })}\n\nReport a problem only if the message:\n${Object.entries(RULES).map(([k, r]) => `(${k}) ${r.text};`).join('\n')}\n\nReply with ONLY this JSON (empty "issues" if nothing applies):\n{"issues":[{"quote":"exact words","rule":"a|b|c|d|e","problem":"...","fix":"..."}]}`,
        converse,
        deadline,
        validate: parseSafetyReview,
      });
      const out = { ...res.value, method: 'rules+llm', usage: { ...res.usage }, model: res.model };
      refuteByMessage(out.issues, guidance, language);
      out.verdict = out.issues.some((i) => i.severity === 'blocking') ? 'revise' : 'approve';
      const harm = out.issues.filter((i) => i.severity === 'blocking' && (i.rule === 'b' || i.rule === 'c'));
      if (harm.length && deadline - Date.now() > 4000) {
        try {
          const check = await runAgent({
            agent: {
              name: 'vera',
              models,
              maxTurns: 1,
              maxTokens: 600,
              system: 'You double-check objections to a heat-safety message. For each objection, decide whether the message really gives the harmful advice or breaks the limit described. Advice to reduce, limit or avoid something is not advice to do it. If it does, copy the exact words from the message that give that advice, in the message\'s own language. If no words in the message give it, the objection is not confirmed.',
              tools: [],
            },
            input: `Message:\n${JSON.stringify({ headline: guidance.headline, actions: guidance.actions, seekHelp: guidance.seekHelp })}\n\nObjections:\n${harm.map((i, k) => `${k + 1}. ${i.problem}`).join('\n')}\n\nReply with ONLY this JSON:\n{"verdicts":[{"id":1,"confirmed":true,"evidence":"exact words from the message"}]}`,
            converse,
            deadline,
            validate: (t) => parseVerification(t, harm.length),
          });
          check.value.forEach((v, k) => {
            if (!(v.confirmed && evidenceInMessage(v.evidence, guidance))) {
              Object.assign(harm[k], { severity: 'minor', problem: `${harm[k].problem} (not confirmed on a second reading)` });
            }
          });
          out.usage.inputTokens += check.usage.inputTokens;
          out.usage.outputTokens += check.usage.outputTokens;
          out.verified = harm.length;
        } catch {
          // The objections stand as they were: when in doubt, block.
        }
        out.verdict = out.issues.some((i) => i.severity === 'blocking') ? 'revise' : 'approve';
      }
      return out;
    },
  };
}
