// "Listen to your plan": Amazon Polly reads only what HeatShield wrote, once per text, in a real voice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechService, toSsml, canSpeak } from '../functions/lib/speech.mjs';
import { createPublicApi } from '../functions/lib/public-routes.mjs';
import { runCost, measureSpend } from '../functions/lib/spend.mjs';
import { createAgentLog } from '../functions/lib/agent-log.mjs';
import { createFakeDb, apiEvent, parse, makeForecast, diurnal } from './helpers.mjs';

const NOW = 1_790_000_000;
const KEY = 'a'.repeat(64);
const plan = { headline: 'Dangerous heat today', actions: ['Drink water & rest', 'Stay <inside> from 12 to 4'], seekHelp: 'Confusion is an emergency' };

function world({ cache = {}, gate = null } = {}) {
  const { db, tables } = createFakeDb();
  const agentLog = createAgentLog({ db, table: tables.agentLog });
  const files = new Map();
  const synthCalls = [];
  const speech = createSpeechService({
    cache: { get: async (k) => cache[k] ?? null },
    synthesize: async (req) => { synthCalls.push(req); return { audio: new Uint8Array([1, 2, 3]), characters: 120 }; },
    storage: { exists: async (p) => files.has(p), put: async (p, body) => { files.set(p, body); } },
    gate: gate && (() => gate()),
    agentLog,
    nowSeconds: () => NOW,
  });
  return { speech, files, synthCalls, agentLog };
}
const code = async (promise) => promise.then(() => null, (err) => `${err.status} ${err.code}`);

test('Listen: a reviewed plan is read once, in its own language\'s voice, then served from storage', async () => {
  const w = world({ cache: { [KEY]: { guidance: plan, language: 'hi', expiresAt: NOW + 60 } } });
  const first = await w.speech.speak(KEY);
  assert.match(first.url, /^\/audio\/[a-f0-9]{40}\.mp3$/);
  assert.deepEqual({ voice: first.voice, cached: first.cached }, { voice: 'Kajal', cached: false });
  assert.deepEqual(w.synthCalls.map(({ voiceId, engine, languageCode }) => ({ voiceId, engine, languageCode })), [{ voiceId: 'Kajal', engine: 'neural', languageCode: 'hi-IN' }], 'a bilingual voice is told to speak Hindi');
  assert.ok(w.files.has(first.url.slice(1)));
  const again = await w.speech.speak(KEY);
  assert.deepEqual({ url: again.url, cached: again.cached }, { url: first.url, cached: true });
  assert.equal(w.synthCalls.length, 1, 'synthesized once');
  const runs = await w.agentLog.listRuns('voice');
  assert.deepEqual(runs.map((r) => [r.model, r.characters]), [['polly:neural', 120]], 'metered with the characters Polly billed');
});

test('Listen speaks only HeatShield\'s own words: no free text, no expired or unknown plans, no borrowed voices', async () => {
  const w = world({ cache: {
    [KEY]: { guidance: plan, language: 'ur', expiresAt: NOW + 60 },
    ['b'.repeat(64)]: { guidance: plan, language: 'en', expiresAt: NOW - 1 },
    ['c'.repeat(64)]: { guidance: plan, expiresAt: NOW + 60 }, // stored before the cache kept the language
  } });
  assert.equal(await code(w.speech.speak(undefined)), '400 bad_request');
  assert.equal(await code(w.speech.speak('Please read this sentence aloud')), '404 not_found');
  assert.equal(await code(w.speech.speak('b'.repeat(64))), '404 not_found', 'expired');
  assert.equal(await code(w.speech.speak('c'.repeat(64))), '404 not_found', 'language unknown');
  assert.equal(await code(w.speech.speak('d'.repeat(64))), '404 not_found', 'never cached');
  assert.equal(await code(w.speech.speak('fb.danger.robot.en')), '404 not_found');
  assert.equal(await code(w.speech.speak('fb.boiling.elderly.en')), '404 not_found');
  assert.equal(await code(w.speech.speak(KEY)), '404 no_voice', 'Polly has no Urdu voice; a Hindi one is not used instead');
  assert.equal(w.synthCalls.length, 0);
  assert.deepEqual(['en', 'es', 'fr', 'pt', 'ar', 'hi', 'zh'].filter(canSpeak).length, 7);
  assert.deepEqual(['ur', 'bn', 'vi', 'id', 'tl', 'sw'].filter(canSpeak), []);
});

test('Listen: pre-written guidance is read as shown, English where the language has no pre-written text', async () => {
  const w = world();
  const es = await w.speech.speak('fb.danger.outdoor_worker.es');
  assert.deepEqual([es.language, es.voice], ['es', 'Lupe']);
  const hi = await w.speech.speak('fb.danger.outdoor_worker.hi'); // shown in English on screen, with a notice
  const en = await w.speech.speak('fb.danger.outdoor_worker.en');
  assert.deepEqual([hi.language, hi.voice], ['en', 'Joanna']);
  assert.equal(hi.url, en.url, 'the same words are one file');
  assert.equal(en.cached, true);
  assert.equal(w.synthCalls.length, 2);
});

test('Listen: SSML is escaped and paced; a pause stops new speech but never stored audio', async () => {
  assert.equal(toSsml(plan), '<speak>Dangerous heat today<break time="600ms"/>Drink water &amp; rest<break time="600ms"/>Stay &lt;inside&gt; from 12 to 4<break time="600ms"/>Confusion is an emergency</speak>');
  let allowed = { ok: true };
  const w = world({ cache: { [KEY]: { guidance: plan, language: 'en', expiresAt: NOW + 60 } }, gate: async () => allowed });
  await w.speech.speak(KEY);
  allowed = { ok: false, reason: 'budget_paused' };
  assert.equal((await w.speech.speak(KEY)).cached, true, 'stored audio costs nothing and is still served');
  assert.equal(await code(w.speech.speak('fb.danger.elderly.en')), '503 budget_paused');
  assert.equal(w.synthCalls.length, 1);
});

test('Polly is on the AI bill: priced per character and counted in the daily spend that trips the brake', async () => {
  assert.equal(runCost({ model: 'polly:neural', characters: 1_000_000 }), 16);
  assert.equal(runCost({ model: 'polly:standard', characters: 500_000 }), 2);
  assert.equal(runCost({ model: 'polly:unknown', characters: 10 }), null);
  const { db, tables } = createFakeDb();
  const agentLog = createAgentLog({ db, table: tables.agentLog });
  await agentLog.recordRun('voice', { outcome: 'spoken', model: 'polly:neural', characters: 50_000 });
  await agentLog.recordRun('sol', { outcome: 'briefed', model: 'us.amazon.nova-2-lite-v1:0', inputTokens: 1_000_000, outputTokens: 0 });
  const spend = await measureSpend({ agentLog, sinceMs: Date.now() - 60_000 });
  assert.equal(spend.spentUsd, 1.13); // 0.80 of speech + 0.33 of Nova 2 Lite
  assert.deepEqual(spend.byAgent, { sol: 0.33, voice: 0.8 });
  assert.equal(spend.byModel['polly:neural'].characters, 50_000);
});

test('GET /api/guidance says when a plan can be listened to; GET /api/speech returns the audio address', async () => {
  const w = world({ cache: { [KEY]: { guidance: plan, language: 'hi', expiresAt: NOW + 60 } } });
  const weather = { getForecast: async () => makeForecast({ nowHour: 13, temp: diurnal(30, 41), rh: () => 50 }) };
  const guidance = { getGuidance: async (_risk, lang) => ({ ...plan, language: lang, source: 'cache', speechKey: KEY }) };
  const pub = createPublicApi({ weather, guidance, version: 't', region: 'r', speech: w.speech });
  const listen = async (lang) => parse(await pub(apiEvent('GET /api/guidance', { query: { lat: '1', lon: '1', lang } }))).body.guidance.listen;
  assert.equal(await listen('hi'), true);
  assert.equal(await listen('ur'), false);
  const ok = parse(await pub(apiEvent('GET /api/speech', { query: { key: KEY } })));
  assert.equal(ok.status, 200);
  assert.match(ok.body.url, /^\/audio\/[a-f0-9]{40}\.mp3$/);
  assert.equal(parse(await pub(apiEvent('GET /api/speech', { query: { key: 'read this' } }))).status, 404);
  const none = createPublicApi({ weather, guidance, version: 't', region: 'r' });
  assert.equal(parse(await none(apiEvent('GET /api/guidance', { query: { lat: '1', lon: '1', lang: 'hi' } }))).body.guidance.listen, false);
});
