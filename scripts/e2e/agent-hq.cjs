#!/usr/bin/env node
/**
 * Agent HQ in headless Chrome, against a deployed site.
 *   npm i --no-save playwright-core        (once; it drives your installed Google Chrome)
 *   node scripts/e2e/agent-hq.cjs [https://<site>] [--run-agents]
 *
 * Checks the live office (six desks, speech from real runs, the wall map), the activity feed, an
 * agent's panel, and the phone layout. --run-agents also presses the four buttons, which run real
 * agents on AWS (a few US cents; shared cooldowns may answer "try again in a few minutes", which
 * counts as a pass). Exits 1 on any console error or failed check.
 */
const { chromium } = require('playwright-core');

const args = process.argv.slice(2);
const BASE = (args.find((a) => a.startsWith('http')) ?? process.env.HEATSHIELD_URL ?? 'https://d3tda9dyutl7ux.cloudfront.net').replace(/\/$/, '');
const RUN_AGENTS = args.includes('--run-agents');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const errors = [];
  const step = (msg) => console.log(`  ✔ ${msg}`);
  const fail = (msg) => { throw new Error(msg); };
  const open = async (label, opts) => {
    const p = await (await browser.newContext(opts)).newPage();
    p.on('console', (m) => {
      // A shared cooldown answering 429 is designed behaviour, but Chrome logs any 4xx as an error.
      if (m.type() === 'error' && !(RUN_AGENTS && /status of 429/.test(m.text()))) errors.push(`${label}: ${m.text()}`);
    });
    p.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
    return p;
  };

  console.log(`Agent HQ test: ${BASE}/agents.html`);
  const p = await open('desktop', { viewport: { width: 1280, height: 1000 } });
  const statuses = [];
  p.on('response', (r) => { if (r.request().method() === 'POST' && r.url().includes('/api/')) statuses.push(`${new URL(r.url()).pathname} -> ${r.status()}`); });
  await p.goto(`${BASE}/agents.html`, { waitUntil: 'networkidle' });
  if ((await p.locator('.office-desk').count()) !== 6) fail('expected six desks');
  await p.waitForSelector('.office-bubble:not([hidden])', { timeout: 10_000 });
  step(`office: 6 agents; speaking: "${(await p.textContent('.office-bubble:not([hidden])')).slice(0, 60)}"`);
  const status = await p.textContent('#hq-status');
  if (!/agent runs in the last 24 h/.test(status)) fail(`status line not populated: ${status}`);
  step(`status: ${status}`);
  const feed = await p.locator('#feed .feed-item').count();
  if (!feed) fail('activity feed is empty');
  step(`activity feed: ${feed} runs`);
  await p.locator('.office-desk').nth(5).click();
  await p.waitForFunction(() => document.getElementById('agent-panel').textContent.includes('Otto'));
  step('selecting a desk shows that agent (Otto)');

  if (RUN_AGENTS) {
    await p.click('#task-btn');
    await p.waitForSelector('#task-result .task-plan, #task-result .notice', { timeout: 90_000 });
    step(`task: ${(await p.textContent('#task-result .hint').catch(() => '')).trim().slice(0, 90)}`);
    for (const id of ['otto', 'sol', 'kai']) {
      await p.click(`#${id}-btn`);
      await p.waitForTimeout(id === 'otto' ? 9000 : 12_000);
    }
    const bad = statuses.filter((s) => !/-> (200|429)$/.test(s));
    if (bad.length) fail(`agent buttons failed: ${bad.join(', ')}`);
    step(`agent buttons: ${statuses.join(', ')}`);
  }

  const m = await open('phone', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  await m.goto(`${BASE}/agents.html`, { waitUntil: 'networkidle' });
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) fail(`horizontal overflow on a phone: ${overflow}px`);
  step('phone width: no horizontal overflow');

  await browser.close();
  if (errors.length) { console.error(`\nFAILED:\n${errors.map((e) => `  - ${e}`).join('\n')}`); process.exit(1); }
  console.log('\nAll checks passed.');
})().catch((err) => { console.error(`\nFAILED: ${err.message}`); process.exit(1); });
