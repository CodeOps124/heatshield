/**
 * Amazon Bedrock guidance layer: turns a structured risk assessment into a short, specific,
 * localized action plan for one person.
 *
 * Design decisions (see README "Why the AI layer is built this way"):
 *  1. The prompt contains ONLY enumerated / bucketed values derived from the forecast (tiers,
 *     clock hours, profile, language). No free text a user typed ever reaches the model, so
 *     there is no prompt-injection surface, and the space of distinct prompts is bounded.
 *  2. Because the input space is bounded, a cache keyed on a hash of the exact prompt inputs
 *     is always correct AND caps Bedrock spend: an attacker cannot mint unlimited cache misses.
 *  3. The model is grounded in a fixed list of public-health facts (CDC / NIOSH / NWS) and told
 *     not to invent numbers, medicines, or phone numbers.
 *  4. Output is structured JSON, validated (shape, length, script); on any failure we try the
 *     next model, then fall back to static pre-written guidance. Never a blank screen.
 *
 * Uses the Bedrock Converse API so the primary (Anthropic Claude) and fallback (Amazon Nova)
 * models share one code path.
 */
import { createHash } from 'node:crypto';
import { TIER_LABELS, maxTier } from './heat.mjs';
import { LANGUAGES, matchesScript } from './languages.mjs';
import { fallbackGuidance } from './fallback-guidance.mjs';

export const PROMPT_VERSION = 'v2'; // v2: risky-hours window names its day ("now until 13:00 tomorrow")
const CACHE_TTL_SECONDS = 6 * 60 * 60;
const MODEL_TIMEOUT_MS = 9000;

const PROFILE_DESCRIPTIONS = {
  outdoor_worker: 'an outdoor worker doing physical work (for example construction, farming, delivery)',
  elderly: 'an older adult (65 or over), who may live alone',
  chronic_condition: 'a person with a chronic health condition (for example heart, lung, or kidney disease, or diabetes)',
  child: 'a parent or caregiver of a young child',
  pregnant: 'a pregnant person',
  general: 'a member of the general public',
};

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

export function buildSystemPrompt(languageName) {
  return `You write heat-safety action messages for HeatShield, a free public heat early-warning service.
Each message is for one specific person and must be based only on the forecast facts you are given.

Rules:
- Write everything in ${languageName}. Use plain, everyday words that someone with basic reading skills can follow. No jargon. No "consult your physician" hedging.
- Be specific to this person's situation and to the clock times in the data: say when to act, what to do before, during and after the risky hours.
- Do not repeat temperature or heat-index numbers; the person already sees them.
- Only give advice consistent with the public-health facts below. Do not invent statistics, products, medicines or phone numbers. Say "your local emergency number", never a specific number.
- If the risk is low, say so calmly and give light precautions. Do not alarm people unnecessarily.

Public-health facts you may rely on (CDC, NIOSH, US National Weather Service):
- Heat index values assume shade. In direct sun it can feel up to about 8 °C (15 °F) hotter.
- Workers doing moderate activity in heat: about one cup (240 ml) of water every 15 to 20 minutes. No more than about 1.5 litres (6 cups) per hour. If sweating for several hours, drinks with electrolytes help.
- Take rest breaks in shade whenever feeling heat discomfort; as heat rises, work shorter periods and rest longer. Use a buddy system so workers watch each other for signs of heat illness.
- People new to working in heat, or returning after time away, need to build up gradually over about two weeks.
- Older adults should be checked on at least twice a day during heat. A fan should not be the main way to cool down when it is very hot. Cool showers or baths help. If home is hot, spend the hottest hours in an air-conditioned place such as a cooling centre.
- Never leave a child, or anyone, in a parked vehicle.
- Heat exhaustion signs: headache, nausea, dizziness, weakness, heavy sweating, thirst. Stop, move somewhere cooler, sip cool water, and get medical care if it does not improve.
- Heat stroke is an emergency: confusion, slurred speech, fainting, seizures, very high body temperature, hot skin. Call the local emergency number, move the person somewhere cool, and cool them with water and cold cloths while waiting.

Reply with ONLY a JSON object and nothing else, in exactly this shape:
{"headline": "...", "actions": ["...", "...", "..."], "seekHelp": "..."}
- headline: one short sentence (at most 15 words) telling them how serious the heat is for them today.
- actions: exactly 3 short, concrete steps for the coming hours (at most 30 words each), most important first.
- seekHelp: one sentence naming the warning signs that mean they, or someone near them, must get help now.
All text must be in ${languageName}.`;
}

const tierText = (t) => (t ? TIER_LABELS[t] : 'not available');

export function buildUserPrompt(input) {
  const lines = [
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
  ];
  return `Forecast facts for this person:\n${lines.map((l) => `- ${l}`).join('\n')}\n\nWrite their message now, in ${LANGUAGES[input.language].name}.`;
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

/**
 * @param {object} deps
 * @param {(params: object, opts?: object) => Promise<object>} deps.converse  Bedrock Converse call
 * @param {{get: Function, put: Function}} deps.cache  guidance cache (DynamoDB in production)
 * @param {string[]} deps.models  model / inference-profile IDs, in preference order
 * @param {{info: Function, warn: Function}} deps.log
 */
export function createGuidanceService({ converse, cache, models, log, nowSeconds = () => Math.floor(Date.now() / 1000) }) {
  async function callModel(modelId, input) {
    const languageName = LANGUAGES[input.language].name;
    const started = Date.now();
    const res = await converse(
      {
        modelId,
        system: [{ text: buildSystemPrompt(languageName) }],
        messages: [{ role: 'user', content: [{ text: buildUserPrompt(input) }] }],
        inferenceConfig: { maxTokens: 1000, temperature: 0.3 },
      },
      { abortSignal: AbortSignal.timeout(MODEL_TIMEOUT_MS) },
    );
    if (res.stopReason === 'max_tokens') throw new Error('Model output was truncated');
    const text = (res.output?.message?.content ?? []).map((c) => c.text ?? '').join('');
    const guidance = parseGuidance(text, input.language);
    log.info('bedrock_guidance_generated', {
      modelId,
      language: input.language,
      latencyMs: Date.now() - started,
      inputTokens: res.usage?.inputTokens,
      outputTokens: res.usage?.outputTokens,
    });
    return guidance;
  }

  async function getGuidance(risk, language) {
    const input = buildGuidanceInput(risk, language);
    const key = cacheKeyFor(input);

    try {
      const hit = await cache.get(key);
      if (hit && hit.expiresAt > nowSeconds()) {
        return { ...hit.guidance, language, languageFallback: false, source: 'cache', model: hit.model };
      }
    } catch (err) {
      log.warn('guidance_cache_read_failed', { error: err.message });
    }

    for (const modelId of models.filter(Boolean)) {
      try {
        const guidance = await callModel(modelId, input);
        // Awaited on purpose: Lambda may freeze the sandbox as soon as the handler returns.
        try {
          await cache.put({
            cacheKey: key,
            guidance,
            model: modelId,
            createdAt: nowSeconds(),
            expiresAt: nowSeconds() + CACHE_TTL_SECONDS,
          });
        } catch (err) {
          log.warn('guidance_cache_write_failed', { error: err.message });
        }
        return { ...guidance, language, languageFallback: false, source: 'bedrock', model: modelId };
      } catch (err) {
        log.warn('bedrock_guidance_failed', { modelId, error: err.name, message: err.message });
      }
    }

    const tier = maxTier([risk.current.tier, risk.alert.levelTier]);
    return { ...fallbackGuidance({ tier, profileId: input.profileId, language }), source: 'fallback', model: null };
  }

  return { getGuidance };
}
