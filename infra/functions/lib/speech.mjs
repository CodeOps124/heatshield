/**
 * "Listen to your plan" (Amazon Polly). Many of the people HeatShield is for read with difficulty, and
 * a plan read aloud in their own language is the last step of the last mile.
 *
 * Only words HeatShield wrote and checked can be spoken: a reviewed plan from the cache (by its cache
 * key) or the pre-written guidance (by tier, profile and language). A request never carries text, so
 * the endpoint is not a free text-to-speech service, and the set of texts it can speak (and so the
 * cost) is bounded.
 * The audio file is named by a hash of the exact words and voice: it always matches the plan on
 * screen, each text is synthesized once, and CloudFront serves it from S3 after that.
 *
 * Voices: Polly DescribeVoices in us-east-1, checked 30 Sep 2026, and each one tested with a sentence
 * in its language. Polly has no voice for Urdu, Bengali, Vietnamese, Indonesian, Tagalog or Swahili,
 * so plans in those languages have no Listen button. A voice for another language would mispronounce
 * them, or could not read the script at all.
 */
import { createHash } from 'node:crypto';
import { TIERS, PROFILES } from './heat.mjs';
import { isLanguage } from './languages.mjs';
import { fallbackGuidance } from './fallback-guidance.mjs';
import { HttpError } from './http.mjs';

export const VOICES = Object.freeze({
  en: { voiceId: 'Joanna', engine: 'neural' },
  es: { voiceId: 'Lupe', engine: 'neural' },
  fr: { voiceId: 'Lea', engine: 'neural' },
  pt: { voiceId: 'Camila', engine: 'neural' },
  ar: { voiceId: 'Hala', engine: 'neural', languageCode: 'arb' }, // Modern Standard Arabic
  hi: { voiceId: 'Kajal', engine: 'neural', languageCode: 'hi-IN' }, // a bilingual voice: Hindi, not Indian English
  zh: { voiceId: 'Zhiyu', engine: 'neural' },
});

export const canSpeak = (language) => Object.hasOwn(VOICES, language);

const CACHE_KEY = /^[a-f0-9]{64}$/;
const FALLBACK_KEY = /^fb\.([a-z_]{3,20})\.([a-z_]{3,20})\.([a-z]{2})$/;
const XML = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' };

/** The plan as SSML: the headline, each action, then when to get help, with a pause between them. */
export function toSsml(guidance) {
  const parts = [guidance.headline, ...(guidance.actions ?? []), guidance.seekHelp].map((s) => String(s ?? '').trim()).filter(Boolean);
  return `<speak>${parts.map((p) => p.replace(/[<>&"']/g, (c) => XML[c])).join('<break time="600ms"/>')}</speak>`;
}

/**
 * @param {object} deps
 * @param {{get: Function}} deps.cache           the guidance cache
 * @param {Function} deps.synthesize             ({ssml, voiceId, engine, languageCode}) -> {audio, characters}
 * @param {{exists: Function, put: Function}} deps.storage   where the audio files live (S3 under audio/)
 * @param {Function} [deps.gate]                 operator pause / AI budget brake, as for new plans
 */
export function createSpeechService({ cache, synthesize, storage, gate = null, agentLog = null, nowSeconds = () => Math.floor(Date.now() / 1000) }) {
  async function planFor(key) {
    if (CACHE_KEY.test(key)) {
      const hit = await cache.get(key);
      // A plan that is still being served, in a known language (older cache entries did not store it).
      if (!hit || hit.expiresAt <= nowSeconds() || !hit.language) return null;
      return { guidance: hit.guidance, language: hit.language, fallback: false };
    }
    const m = FALLBACK_KEY.exec(key);
    if (m && TIERS.includes(m[1]) && Object.hasOwn(PROFILES, m[2]) && isLanguage(m[3])) {
      const g = fallbackGuidance({ tier: m[1], profileId: m[2], language: m[3] });
      return { guidance: g, language: g.language, fallback: true }; // English where no pre-written text exists, as on screen
    }
    return null;
  }

  return {
    async speak(key) {
      if (typeof key !== 'string' || !key || key.length > 100) throw new HttpError(400, 'bad_request', 'A plan key is required.');
      const plan = await planFor(key);
      if (!plan) throw new HttpError(404, 'not_found', 'This plan is no longer available. Refresh the page for the current plan.');
      const voice = VOICES[plan.language];
      if (!voice) throw new HttpError(404, 'no_voice', 'Amazon Polly has no voice for this language yet.');

      const ssml = toSsml(plan.guidance);
      const path = `audio/${createHash('sha256').update(JSON.stringify([voice, ssml])).digest('hex').slice(0, 40)}.mp3`;
      const result = { url: `/${path}`, language: plan.language, voice: voice.voiceId };
      if (await storage.exists(path)) return { ...result, cached: true };

      // Stored audio is always served; only new speech waits while AI work is paused or over budget.
      if (gate) {
        const allowed = await gate().catch(() => ({ ok: true }));
        if (!allowed.ok) throw new HttpError(503, allowed.reason, 'Reading plans aloud is paused right now. The written plan is unchanged.');
      }
      const { audio, characters } = await synthesize({ ssml, ...voice });
      await storage.put(path, audio);
      await agentLog?.recordRun('voice', {
        outcome: 'spoken', model: `polly:${voice.engine}`, characters,
        summary: `Read a ${plan.language} ${plan.fallback ? 'pre-written' : 'reviewed'} plan aloud with the ${voice.voiceId} voice (${characters} characters).`,
        detail: { language: plan.language, voice: voice.voiceId, fallback: plan.fallback },
      }).catch(() => {}); // metering must not cost the listener their audio
      return { ...result, cached: false };
    },
  };
}
