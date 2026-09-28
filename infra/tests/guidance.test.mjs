import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk } from '../functions/lib/heat.mjs';
import {
  buildGuidanceInput, cacheKeyFor, buildUserPrompt, buildSystemPrompt, parseGuidance, createGuidanceService,
} from '../functions/lib/guidance.mjs';
import { fallbackGuidance } from '../functions/lib/fallback-guidance.mjs';
import { makeForecast, diurnal, silentLog } from './helpers.mjs';

const risk = (profile = 'outdoor_worker') =>
  assessRisk(makeForecast({ nowHour: 9, temp: diurnal(27, 38), rh: () => 55 }), profile);

const GOOD = { headline: 'Dangerous heat this afternoon.', actions: ['Start early.', 'Rest in shade at 13:00.', 'Drink water.'], seekHelp: 'Confusion means call for help.' };
const reply = (obj) => ({ stopReason: 'end_turn', output: { message: { content: [{ text: JSON.stringify(obj) }] } }, usage: {} });

function memoryCache() {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, put: async (e) => { m.set(e.cacheKey, e); } };
}

test('guidance input contains only bounded, enumerated values (no user text)', () => {
  const input = buildGuidanceInput(risk(), 'ar');
  for (const [k, v] of Object.entries(input)) {
    assert.ok(v === null || ['string', 'number', 'boolean'].includes(typeof v), `${k} has type ${typeof v}`);
    if (typeof v === 'string') assert.ok(v.length <= 20, `${k} is suspiciously long: ${v}`);
  }
  const prompt = buildUserPrompt(input);
  assert.match(prompt, /Arabic/);
  assert.match(prompt, /15:00/);
});

test('cache key is deterministic and sensitive to every input', () => {
  const a = buildGuidanceInput(risk(), 'es');
  assert.equal(cacheKeyFor(a), cacheKeyFor({ ...a }));
  assert.equal(cacheKeyFor(a), cacheKeyFor(Object.fromEntries(Object.entries(a).reverse())), 'key order must not matter');
  assert.notEqual(cacheKeyFor(a), cacheKeyFor({ ...a, language: 'fr' }));
  assert.notEqual(cacheKeyFor(a), cacheKeyFor({ ...a, peakHour: '14:00' }));
});

test('system prompt grounds the model and forbids invented numbers', () => {
  const s = buildSystemPrompt('Hindi');
  assert.match(s, /Hindi/);
  assert.match(s, /local emergency number/);
  assert.match(s, /15 to 20 minutes/);
  assert.match(s, /ONLY a JSON object/);
});

test('parseGuidance accepts fenced JSON and trims whitespace', () => {
  const g = parseGuidance('```json\n{"headline":"  Hot  day ","actions":["a","b","c"],"seekHelp":"x"}\n```', 'en');
  assert.equal(g.headline, 'Hot day');
  assert.equal(g.actions.length, 3);
});

test('parseGuidance rejects malformed or wrong-language output', () => {
  assert.throws(() => parseGuidance('Sorry, I cannot help', 'en'));
  assert.throws(() => parseGuidance('{"headline":"x","actions":["only one"],"seekHelp":"y"}', 'en'));
  assert.throws(() => parseGuidance(JSON.stringify(GOOD), 'ar'), /script/, 'English text requested as Arabic must be rejected');
  const arabic = { headline: 'حرارة خطيرة اليوم', actions: ['اشرب الماء', 'استرح في الظل'], seekHelp: 'اتصل بالطوارئ' };
  assert.equal(parseGuidance(JSON.stringify(arabic), 'ar').headline, 'حرارة خطيرة اليوم');
});

test('service: model success is returned and cached; second call hits the cache', async () => {
  const cache = memoryCache();
  let calls = 0;
  const svc = createGuidanceService({
    converse: async () => { calls += 1; return reply(GOOD); }, cache, models: ['primary'], log: silentLog,
  });
  const first = await svc.getGuidance(risk(), 'en');
  assert.equal(first.source, 'bedrock');
  assert.equal(first.model, 'primary');
  const second = await svc.getGuidance(risk(), 'en');
  assert.equal(second.source, 'cache');
  assert.equal(calls, 1);
});

test('service: expired cache entries are ignored', async () => {
  const cache = memoryCache();
  let now = 1000;
  let calls = 0;
  const svc = createGuidanceService({
    converse: async () => { calls += 1; return reply(GOOD); }, cache, models: ['m'], log: silentLog, nowSeconds: () => now,
  });
  await svc.getGuidance(risk(), 'en');
  now += 7 * 3600;
  assert.equal((await svc.getGuidance(risk(), 'en')).source, 'bedrock');
  assert.equal(calls, 2);
});

test('service: primary model failure falls through to the fallback model', async () => {
  const seen = [];
  const svc = createGuidanceService({
    converse: async ({ modelId }) => {
      seen.push(modelId);
      if (modelId === 'claude') throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      return reply(GOOD);
    },
    cache: memoryCache(),
    models: ['claude', 'nova'],
    log: silentLog,
  });
  const g = await svc.getGuidance(risk(), 'en');
  assert.deepEqual(seen, ['claude', 'nova']);
  assert.equal(g.model, 'nova');
});

test('service: truncated or invalid output never reaches the user; static fallback does', async () => {
  const svc = createGuidanceService({
    converse: async () => ({ stopReason: 'max_tokens', output: { message: { content: [{ text: '{"headline":' }] } } }),
    cache: { get: async () => { throw new Error('ddb down'); }, put: async () => {} },
    models: ['m1', 'm2'],
    log: silentLog,
  });
  const g = await svc.getGuidance(risk('elderly'), 'es');
  assert.equal(g.source, 'fallback');
  assert.equal(g.language, 'es');
  assert.equal(g.languageFallback, false);
  assert.ok(g.actions.length >= 2);
});

test('static fallback: hand-written languages, honest English fallback for the rest', () => {
  const fr = fallbackGuidance({ tier: 'danger', profileId: 'outdoor_worker', language: 'fr' });
  assert.match(fr.headline, /Chaleur dangereuse/);
  assert.match(fr.actions[0], /15 à 20 minutes/);
  const sw = fallbackGuidance({ tier: 'danger', profileId: 'child', language: 'sw' });
  assert.equal(sw.language, 'en');
  assert.equal(sw.languageFallback, true);
  assert.match(sw.actions[0], /parked car/);
});
