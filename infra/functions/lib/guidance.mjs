/**
 * MIRA — Health Advisor agent, plus the multi-agent review loop that guards her output.
 *
 *   forecast → risk ──► Mira drafts (Claude Haiku 4.5 → Nova 2 Lite)
 *                           │    facts retrieved by BM25 from a vetted CDC/NIOSH/NWS library
 *                           ▼
 *            ┌── Lexi (language: langid + back-translation) ──┐
 *            └── Vera (safety: rule detectors + LLM judge) ───┘  in parallel
 *                           │ both approve → cache + show
 *                           │ either says "revise" → Mira rewrites once with their exact issues
 *                           ▼ still rejected → pre-written safe guidance (never a blank screen)
 *
 * Design decisions (README "Why the AI layer is built this way"):
 *  1. The prompt contains ONLY enumerated / bucketed values derived from the forecast (tiers,
 *     clock hours, profile, language). No free text a user typed ever reaches a model.
 *  2. Because the input space is bounded, a cache keyed on a hash of the prompt inputs is exact
 *     and caps Bedrock spend. Only reviewer-APPROVED guidance is cached.
 *  3. The writer is grounded in facts retrieved from a vetted library and told not to invent
 *     numbers, medicines or phone numbers; the Safety Reviewer enforces it.
 */
import { createHash } from 'node:crypto';
import { TIER_LABELS, maxTier } from './heat.mjs';
import { LANGUAGES, matchesScript } from './languages.mjs';
import { fallbackGuidance } from './fallback-guidance.mjs';
import { createBm25Index } from './algorithms/bm25.mjs';
import { FACTS } from './agents/facts.mjs';

export const PROMPT_VERSION = 'v3'; // v3: BM25-retrieved facts + reviewer loop
const CACHE_TTL_SECONDS = 6 * 60 * 60;
const MODEL_TIMEOUT_MS = 9000;
const DEFAULT_BUDGET_MS = 22_000;

const PROFILE_DESCRIPTIONS = {
  outdoor_worker: 'an outdoor worker doing physical work (for example construction, farming, delivery)',
  elderly: 'an older adult (65 or over), who may live alone',
  chronic_condition: 'a person with a chronic health condition (for example heart, lung, or kidney disease, or diabetes)',
  child: 'a parent or caregiver of a young child',
  pregnant: 'a pregnant person',
  general: 'a member of the general public',
};

// BM25 query terms per profile; situation terms are added from the forecast.
const PROFILE_QUERY = {
  outdoor_worker: 'worker outdoor work crew shift water rest break sun',
  elderly: 'elderly older adult alone check home fan cool shower',
  chronic_condition: 'chronic condition medicine heart home cooling check',
  child: 'child infant car vehicle shade water',
  pregnant: 'pregnant water rest cool risk',
  general: 'general outdoor activity water shade morning evening',
};

const factIndex = createBm25Index(FACTS.filter((f) => !f.pinned), { field: (f) => `${f.text} ${f.tags}` });
const PINNED = FACTS.filter((f) => f.pinned);

/** Health Advisor retrieval step: BM25 top-k facts for this person + the pinned life-safety facts. */
export function retrieveFacts(input, k = 6) {
  const q = [
    PROFILE_QUERY[input.profileId],
    input.tropicalNight ? 'night warm sleep' : '',
    ['high', 'very high', 'extreme'].includes(input.uv) ? 'sun midday shade' : '',
    ['danger', 'extreme_danger'].includes(input.next12hTier) ? 'danger extreme rest break hottest hours' : '',
    input.partOfDay === 'night' || input.partOfDay === 'evening' ? 'night evening' : 'morning',
  ].join(' ');
  return [...factIndex.search(q, k).map((h) => h.doc), ...PINNED];
}

function uvBucket(uv) {
  if (uv === null || uv === undefined) return 'unknown';
  if (uv < 3) return 'low';
  if (uv < 6) return 'moderate';
  if (uv < 8) return 'high';
  if (uv < 11) return 'very high';
  return 'extreme';
}

/**
 * Reduce a risk assessment to the bounded set of values the prompt is allowed to see.
 * Everything here is an enum or a clock hour — this object IS the cache key.
 */
export function buildGuidanceInput(risk, language) {
  const [, tomorrow, dayAfter] = risk.outlook ?? [];
  return {
    promptVersion: PROMPT_VERSION,
    language,
    profileId: risk.profile.id,
    partOfDay: risk.partOfDay,
    localHour: risk.localHour,
    currentTier: risk.current.tier,
    next12hTier: risk.alert.levelTier,
    rising: risk.trend.rising,
    hoursUntilRise: risk.trend.hoursUntilRise,
    risingTo: risk.trend.rising ? risk.trend.next6hMaxTier : null,
    peakTier: risk.peak24h.tier,
    peakHour: risk.peak24h.label,
    peakIsTomorrow: risk.peak24h.isTomorrow,
    alertTier: risk.profile.alertTier,
    // e.g. "now until 13:00 tomorrow" — derived only from clock hours and day offsets (bounded).
    window: risk.riskWindow?.label ?? null,
    tropicalNight: risk.night.tropicalNight,
    tomorrowTier: tomorrow?.tier ?? null,
    dayAfterTier: dayAfter?.tier ?? null,
    uv: uvBucket(risk.uvMaxToday),
  };
}

export function cacheKeyFor(input) {
  const canonical = JSON.stringify(Object.keys(input).sort().map((k) => [k, input[k]]));
  return createHash('sha256').update(canonical).digest('hex');
}

export const factsAsList = (facts) => facts.map((f) => `- ${f.text} (${f.source})`).join('\n');

export function buildSystemPrompt(languageName, facts = [...FACTS]) {
  return `You are Mira, HeatShield's health advisor. You write heat-safety action messages for a free public heat early-warning service.
Each message is for one specific person and must be based only on the forecast facts you are given.

Rules:
- Write everything in ${languageName}. Use plain, everyday words that someone with basic reading skills can follow. No jargon. No "consult your physician" hedging.
- Be specific to this person's situation and to the clock times in the data: say when to act, what to do before, during and after the risky hours.
- Do not repeat temperature or heat-index numbers; the person already sees them.
- Only give advice consistent with the public-health facts below. Do not invent statistics, products, medicines or phone numbers. Say "your local emergency number", never a specific number.
- If the risk is low, say so calmly and give light precautions. Do not alarm people unnecessarily.

Public-health facts you may rely on (retrieved for this person from HeatShield's vetted library):
${factsAsList(facts)}

Reply with ONLY a JSON object and nothing else, in exactly this shape:
{"headline": "...", "actions": ["...", "...", "..."], "seekHelp": "..."}
- headline: one short sentence (at most 15 words) telling them how serious the heat is for them today.
- actions: exactly 3 short, concrete steps for the coming hours (at most 30 words each), most important first.
- seekHelp: one sentence naming the warning signs that mean they, or someone near them, must get help now.
All text must be in ${languageName}.`;
}

const tierText = (t) => (t ? TIER_LABELS[t] : 'not available');

export function situationLines(input) {
  return [
    `Person: ${PROFILE_DESCRIPTIONS[input.profileId]}.`,
    `Their personal alert level starts at: ${TIER_LABELS[input.alertTier]}.`,
    `Local time now: ${String(input.localHour).padStart(2, '0')}:00 (${input.partOfDay}).`,
    `Heat risk right now (US National Weather Service scale: Lower risk < Caution < Extreme Caution < Danger < Extreme Danger): ${TIER_LABELS[input.currentTier]}.`,
    `Worst risk in the next 12 hours: ${TIER_LABELS[input.next12hTier]}.`,
    input.rising
      ? `Trend: rising to ${TIER_LABELS[input.risingTo]} within ${input.hoursUntilRise} hour(s).`
      : 'Trend: not rising in the next 6 hours.',
    `Hottest point in the next 24 hours: ${TIER_LABELS[input.peakTier]} around ${input.peakHour}${input.peakIsTomorrow ? ' tomorrow' : ' today'}.`,
    input.window
      ? `Hours at or above their alert level: ${input.window}.`
      : 'Hours at or above their alert level: none in the next 24 hours.',
    input.tropicalNight
      ? 'Tonight: stays warm (above 20 °C), so there is little relief overnight.'
      : 'Tonight: cools down, giving some relief overnight.',
    `Tomorrow's worst risk: ${tierText(input.tomorrowTier)}. The day after: ${tierText(input.dayAfterTier)}.`,
    `UV index today: ${input.uv}.`,
  ].map((l) => `- ${l}`).join('\n');
}

export function buildUserPrompt(input, feedback = null) {
  let prompt = `Forecast facts for this person:\n${situationLines(input)}\n\nWrite their message now, in ${LANGUAGES[input.language].name}.`;
  if (feedback) {
    prompt += `\n\nYour previous draft was sent back by HeatShield's reviewers:\n${JSON.stringify(feedback.draft)}\nFix every issue they raised:\n${feedback.issues.map((i) => `- ${i.quote ? `"${i.quote}": ` : ''}${i.problem}${i.fix ? ` Fix: ${i.fix}` : ''}`).join('\n')}\nWrite the corrected message.`;
  }
  return prompt;
}

const clean = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

/** Parse and validate model output. Throws on anything we would not show a person. */
export function parseGuidance(text, language) {
  if (typeof text !== 'string') throw new Error('Model returned no text');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Model output contained no JSON object');
  const raw = JSON.parse(text.slice(start, end + 1));

  const headline = clean(raw.headline);
  const seekHelp = clean(raw.seekHelp);
  const actions = Array.isArray(raw.actions) ? raw.actions.map(clean).filter(Boolean).slice(0, 4) : [];

  if (!headline || headline.length > 240) throw new Error('Invalid headline');
  if (!seekHelp || seekHelp.length > 400) throw new Error('Invalid seekHelp');
  if (actions.length < 2 || actions.some((a) => a.length > 400)) throw new Error('Invalid actions');

  const guidance = { headline, actions, seekHelp };
  if (!matchesScript(guidance, language)) throw new Error(`Output is not in the ${language} script`);
  return guidance;
}

const summarizeReview = (r) =>
  r
    ? {
        verdict: r.verdict,
        model: r.model ?? null,
        method: r.method ?? null,
        issues: (r.issues ?? []).map(({ quote, problem, fix, rule }) => ({ quote, problem, fix, rule })),
        ...(r.backTranslation ? { backTranslation: r.backTranslation } : {}),
        ...(r.detected ? { detected: r.detected } : {}),
        ...(r.error ? { error: r.error } : {}),
      }
    : null;

/**
 * @param {object} deps
 * @param {Function} deps.converse   Bedrock Converse call
 * @param {{get: Function, put: Function}} deps.cache   guidance cache (DynamoDB in production)
 * @param {string[]} deps.models     writer models, in preference order
 * @param {object} [deps.reviewers]  { language, safety } reviewer agents; omit to skip review
 * @param {object} [deps.agentLog]   records each agent's run for the Agent Console
 */
export function createGuidanceService({
  converse, cache, models, log, reviewers = null, agentLog = null,
  nowSeconds = () => Math.floor(Date.now() / 1000), nowMs = () => Date.now(),
}) {
  const record = (agent, run) => (agentLog ? agentLog.recordRun(agent, run).catch((err) => log.warn('agent_log_failed', { agent, message: err.message })) : null);

  async function write(input, facts, deadline, feedback) {
    let lastErr;
    for (const modelId of models.filter(Boolean)) {
      const started = nowMs();
      try {
        const timeout = Math.min(MODEL_TIMEOUT_MS, deadline - nowMs());
        if (timeout < 1500) throw new Error('No time left to write guidance');
        const res = await converse(
          {
            modelId,
            system: [{ text: buildSystemPrompt(LANGUAGES[input.language].name, facts) }],
            messages: [{ role: 'user', content: [{ text: buildUserPrompt(input, feedback) }] }],
            inferenceConfig: { maxTokens: 1000, temperature: 0.3 },
          },
          { abortSignal: AbortSignal.timeout(timeout) },
        );
        if (res.stopReason === 'max_tokens') throw new Error('Model output was truncated');
        const text = (res.output?.message?.content ?? []).map((c) => c.text ?? '').join('');
        const guidance = parseGuidance(text, input.language);
        const latencyMs = nowMs() - started;
        log.info('bedrock_guidance_generated', {
          modelId, language: input.language, latencyMs, inputTokens: res.usage?.inputTokens, outputTokens: res.usage?.outputTokens, revision: Boolean(feedback),
        });
        await record('mira', {
          trigger: feedback ? 'revision' : 'new-plan',
          outcome: 'ok',
          durationMs: latencyMs,
          model: modelId,
          inputTokens: res.usage?.inputTokens ?? 0,
          outputTokens: res.usage?.outputTokens ?? 0,
          summary: `${feedback ? 'Revised' : 'Wrote'} a ${LANGUAGES[input.language].name} plan for ${PROFILE_DESCRIPTIONS[input.profileId].split(' (')[0]} (${TIER_LABELS[input.next12hTier]}).`,
          detail: { language: input.language, profile: input.profileId, factsUsed: facts.map((f) => f.id), headline: guidance.headline },
        });
        return { guidance, model: modelId };
      } catch (err) {
        lastErr = err;
        log.warn('bedrock_guidance_failed', { modelId, error: err.name, message: err.message });
      }
    }
    throw lastErr ?? new Error('No writer model available');
  }

  async function review(draft, ctx) {
    if (!reviewers) return { approved: true, skipped: true, language: null, safety: null };
    const run = async (who, reviewer) => {
      const started = nowMs();
      try {
        const r = await reviewer.review(draft, ctx);
        await record(who, {
          trigger: 'review',
          outcome: r.verdict,
          durationMs: nowMs() - started,
          model: r.model,
          inputTokens: r.usage?.inputTokens ?? 0,
          outputTokens: r.usage?.outputTokens ?? 0,
          summary: r.verdict === 'approve'
            ? `Approved the ${LANGUAGES[ctx.language].name} plan${r.method ? ` (${r.method})` : ''}.`
            : `Sent the ${LANGUAGES[ctx.language].name} plan back: ${r.issues.length} issue(s)${r.issues[0] ? `, e.g. ${r.issues[0].problem}` : ''}`,
          detail: {
            language: ctx.language,
            verdict: r.verdict,
            method: r.method,
            issues: r.issues.slice(0, 4),
            ...(r.backTranslation ? { backTranslationHeadline: r.backTranslation.headline } : {}),
            ...(r.detected ? { detected: r.detected } : {}),
          },
        });
        return r;
      } catch (err) {
        await record(who, { trigger: 'review', outcome: 'error', durationMs: nowMs() - started, summary: `Review failed: ${err.message}` });
        return { verdict: 'error', error: err.message, issues: [] };
      }
    };
    const [language, safety] = await Promise.all([run('lexi', reviewers.language), run('vera', reviewers.safety)]);
    return {
      approved: language.verdict === 'approve' && safety.verdict === 'approve',
      rejected: language.verdict === 'revise' || safety.verdict === 'revise',
      language,
      safety,
    };
  }

  async function getGuidance(risk, language, { budgetMs = DEFAULT_BUDGET_MS } = {}) {
    const deadline = nowMs() + budgetMs;
    const input = buildGuidanceInput(risk, language);
    const key = cacheKeyFor(input);

    try {
      const hit = await cache.get(key);
      if (hit && hit.expiresAt > nowSeconds()) {
        return {
          ...hit.guidance, language, languageFallback: false, source: 'cache', model: hit.model,
          review: hit.review ?? null, factsUsed: hit.factsUsed ?? [],
        };
      }
    } catch (err) {
      log.warn('guidance_cache_read_failed', { error: err.message });
    }

    const facts = retrieveFacts(input);
    const ctx = {
      language,
      deadline,
      factsSummary: situationLines(input),
      factsList: factsAsList(facts),
      situation: situationLines(input),
    };
    const fallback = (why, reviewResult = null) => {
      const tier = maxTier([risk.current.tier, risk.alert.levelTier]);
      return {
        ...fallbackGuidance({ tier, profileId: input.profileId, language }),
        source: 'fallback', model: null, fallbackReason: why,
        review: reviewResult, factsUsed: facts.map((f) => f.id),
      };
    };

    let draft;
    try {
      draft = await write(input, facts, deadline);
    } catch {
      return fallback('writer_unavailable');
    }

    let verdict = await review(draft.guidance, ctx);
    let revised = false;

    if (verdict.rejected && deadline - nowMs() > 10_000) {
      const issues = [...(verdict.language.issues ?? []), ...(verdict.safety.issues ?? [])];
      try {
        draft = await write(input, facts, deadline, { draft: draft.guidance, issues });
        revised = true;
        verdict = await review(draft.guidance, ctx);
      } catch {
        return fallback('revision_failed', { status: 'rejected', language: summarizeReview(verdict.language), safety: summarizeReview(verdict.safety) });
      }
    }

    const reviewSummary = {
      status: verdict.skipped ? 'skipped' : verdict.approved ? 'approved' : verdict.rejected ? 'rejected' : 'unreviewed',
      revised,
      language: summarizeReview(verdict.language),
      safety: summarizeReview(verdict.safety),
    };

    if (verdict.rejected) return fallback('reviewers_rejected', reviewSummary);

    // Only approved (or review-skipped) guidance is cached; "unreviewed" (a reviewer was down) is
    // shown with an honest label and retried on the next request.
    if (verdict.approved || verdict.skipped) {
      try {
        await cache.put({
          cacheKey: key,
          guidance: draft.guidance,
          model: draft.model,
          review: reviewSummary,
          factsUsed: facts.map((f) => f.id),
          createdAt: nowSeconds(),
          expiresAt: nowSeconds() + CACHE_TTL_SECONDS,
        });
      } catch (err) {
        log.warn('guidance_cache_write_failed', { error: err.message });
      }
    }

    return {
      ...draft.guidance, language, languageFallback: false, source: 'bedrock', model: draft.model,
      review: reviewSummary, factsUsed: facts.map((f) => f.id),
    };
  }

  return { getGuidance };
}
