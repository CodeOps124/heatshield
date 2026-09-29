#!/usr/bin/env node
/**
 * Live evaluation of the plan pipeline: Mira writes, Lexi and Vera review, up to two revisions.
 *   node scripts/eval-guidance.mjs [--shift N] [--base https://<site>]
 *
 * Asks the deployed API for one plan in each of the 13 languages, rotating places and profiles by
 * --shift so each run tests new combinations (an approved plan is cached, and a cached answer says
 * nothing about the reviewers). Prints each plan's outcome and review rounds, then a summary.
 * Cost: at most three rounds of three Bedrock calls per plan, about US$0.01 per plan.
 */
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i === -1 ? fallback : args[i + 1]; };
const BASE = (opt('base', process.env.HEATSHIELD_URL ?? 'https://d3tda9dyutl7ux.cloudfront.net')).replace(/\/$/, '');
const shift = Number(opt('shift', 0));

const PLACES = [
  ['Karachi', 24.86, 67.01], ['Dubai', 25.2, 55.27], ['New Delhi', 28.61, 77.21], ['Cuiabá', -15.6, -56.1],
  ['Phoenix', 33.45, -112.07], ['Lagos', 6.45, 3.39], ['Ho Chi Minh City', 10.82, 106.63], ['Dhaka', 23.81, 90.41],
  ['Mombasa', -4.04, 39.67], ['Manila', 14.6, 120.98],
];
const PROFILES = ['outdoor_worker', 'elderly', 'chronic_condition', 'child', 'pregnant', 'general'];
const LANGS = ['en', 'es', 'fr', 'pt', 'ar', 'ur', 'hi', 'bn', 'zh', 'vi', 'id', 'tl', 'sw'];

const rows = [];
for (const [i, lang] of LANGS.entries()) {
  const [place, lat, lon] = PLACES[(i + shift) % PLACES.length];
  const profile = PROFILES[(i + 2 * shift + 1) % PROFILES.length];
  const started = Date.now();
  const res = await fetch(`${BASE}/api/guidance?lat=${lat}&lon=${lon}&profile=${profile}&lang=${lang}`);
  const g = (await res.json().catch(() => ({}))).guidance ?? {};
  const review = g.review ?? {};
  const row = {
    lang, place, profile, http: res.status, source: g.source ?? 'error', seconds: ((Date.now() - started) / 1000).toFixed(1),
    rounds: (review.rounds ?? []).map((r) => `L${r.language === 'approve' ? '✓' : '✗'}V${r.safety === 'approve' ? '✓' : '✗'}`).join(' '),
    why: g.fallbackReason ?? '',
    blocking: ((review.rounds ?? []).at(-1)?.blocking ?? []).map((b) => b.slice(0, 100)).join(' | '),
  };
  rows.push(row);
  console.log([row.lang.padEnd(3), row.place.padEnd(17), row.profile.padEnd(18), row.source.padEnd(9), `${row.seconds} s`.padEnd(7), row.rounds.padEnd(15), row.why, row.blocking].join(' '));
}
const fresh = rows.filter((r) => r.source !== 'cache');
const published = fresh.filter((r) => r.source === 'bedrock').length;
console.log(`\n${fresh.length} fresh plans: ${published} published as AI plans, ${fresh.filter((r) => r.source === 'fallback').length} pre-written fallbacks; ${rows.length - fresh.length} served from cache.`);
