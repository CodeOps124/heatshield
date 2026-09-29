#!/usr/bin/env node
/**
 * End-to-end test of the whole product against a deployed site, in headless Chrome.
 *   npm i --no-save playwright-core        (once; it drives your installed Google Chrome)
 *   node scripts/e2e/live-flow.cjs [https://<site>]
 *
 * Check risk (Dubai, Arabic) -> create a group -> join it through the invite link (Karachi, Urdu)
 * -> leader dashboard with Kai's plan -> read-only demo dashboard -> personal page -> delete my data
 * -> delete the group, then a phone-width check. It creates only its own test group and deletes it.
 * Exits 1 on any console error, failed step, or "null/undefined/NaN" in visible text.
 */
const { chromium } = require('playwright-core');
const os = require('node:os');
const path = require('node:path');

const BASE = (process.argv[2] ?? process.env.HEATSHIELD_URL ?? 'https://d3tda9dyutl7ux.cloudfront.net').replace(/\/$/, '');
const OUT = path.join(os.tmpdir(), 'heatshield-e2e');

(async () => {
  require('node:fs').mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  const errors = [];
  const pages = [];
  const step = (msg) => console.log(`  ✔ ${msg}`);
  async function page(label, opts) {
    const p = await (await browser.newContext(opts)).newPage();
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`${label}: ${m.text()}`); });
    p.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
    p.on('dialog', (d) => d.accept()); // confirm() before deleting
    pages.push([label, p]);
    return p;
  }

  console.log(`HeatShield end-to-end test: ${BASE}`);
  const home = await page('home', { viewport: { width: 1280, height: 900 } });
  await home.goto(BASE, { waitUntil: 'networkidle' });
  step('home page loaded');
  await home.click('#try-row button:nth-of-type(2)'); // Dubai · Arabic
  await home.waitForSelector('#risk-card .hero-figure', { timeout: 20_000 });
  await home.waitForSelector('#guidance .guidance-headline', { timeout: 60_000 });
  const lang = await home.getAttribute('#guidance [lang]', 'lang');
  const source = (await home.textContent('#guidance .provenance')).trim();
  step(`risk + plan for Dubai (plan language: ${lang}; ${source.slice(0, 70)})`);
  await home.screenshot({ path: path.join(OUT, '01-dubai-ar.png'), fullPage: true });

  await home.fill('#group-name', 'E2E test group (deleted by the test)');
  await home.click('#group-form button[type=submit]');
  await home.waitForSelector('#dashboard-link', { timeout: 15_000 });
  const dashboard = await home.inputValue('#dashboard-link');
  const invite = await home.inputValue('#invite-link');
  step('group created');

  const join = await page('join', { viewport: { width: 1280, height: 900 } });
  await join.goto(invite, { waitUntil: 'networkidle' });
  await join.fill('#place-search input[type=search]', 'Karachi');
  await join.waitForSelector('.combo-list li', { timeout: 15_000 });
  await join.keyboard.press('Enter');
  await join.fill('#reg-name', 'E2E tester');
  await join.selectOption('#reg-lang', 'ur');
  await join.check('#reg-consent');
  await join.click('#register button[type=submit]');
  await join.waitForSelector('#personal-link', { timeout: 15_000 });
  const personal = await join.inputValue('#personal-link');
  step('joined through the invite link');

  const dash = await page('dashboard', { viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  await dash.goto(dashboard, { waitUntil: 'networkidle' });
  await dash.waitForSelector('#members tbody tr', { timeout: 20_000 });
  await dash.waitForSelector('#plan-card:not([hidden])', { timeout: 20_000 });
  if (await dash.locator('#danger-card').isHidden()) throw new Error('delete-group card missing on an ordinary group');
  step(`leader dashboard: ${await dash.locator('#members tbody tr').count()} member, Kai's plan card shown`);

  const demoHref = await home.getAttribute('#demo-link', 'href');
  const demo = await page('demo', { viewport: { width: 1280, height: 900 } });
  await demo.goto(`${BASE}${demoHref}`, { waitUntil: 'networkidle' });
  await demo.waitForSelector('#members tbody tr', { timeout: 30_000 });
  await demo.waitForSelector('#plan-card:not([hidden])', { timeout: 20_000 });
  if (await demo.locator('#members button').count()) throw new Error('read-only demo shows remove buttons');
  if (await demo.locator('#danger-card').isVisible()) throw new Error('read-only demo shows the delete-group card');
  step(`read-only demo dashboard: ${await demo.locator('#members tbody tr').count()} members, ${await demo.locator('.checkins li').count()} planned check-ins`);

  const me = await page('me', { viewport: { width: 1280, height: 900 } });
  await me.goto(personal, { waitUntil: 'networkidle' });
  await me.waitForSelector('#details table', { timeout: 15_000 });
  await me.waitForSelector('#guidance .guidance-headline, #guidance .notice', { timeout: 60_000 });
  await me.click('#details button.btn.danger');
  await me.waitForFunction(() => document.getElementById('title').textContent.includes('deleted'), null, { timeout: 15_000 });
  step('personal page: "delete my data" worked');

  await dash.reload({ waitUntil: 'networkidle' });
  await dash.waitForSelector('#danger-card button', { timeout: 20_000 });
  await dash.click('#danger-card button');
  await dash.waitForFunction(() => document.getElementById('group-name').textContent === 'Group deleted', null, { timeout: 15_000 });
  const gone = await fetch(`${BASE}/api/groups/${new URLSearchParams(new URL(dashboard).hash.slice(1)).get('g')}/dashboard`,
    { headers: { 'x-admin-key': new URLSearchParams(new URL(dashboard).hash.slice(1)).get('k') } });
  if (gone.status !== 403) throw new Error(`deleted group still answers (${gone.status})`);
  step('group deleted from the dashboard; its link no longer works');

  const phone = await page('phone', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  await phone.goto(`${BASE}/?place=Karachi%2C%20Pakistan&lat=24.86&lon=67.01&profile=outdoor_worker&lang=ur`, { waitUntil: 'networkidle' });
  await phone.waitForSelector('#guidance .guidance-headline', { timeout: 60_000 });
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) throw new Error(`horizontal overflow on a phone: ${overflow}px`);
  step('phone width: no horizontal overflow');

  for (const [label, p] of pages) {
    const bad = await p.evaluate(() => document.body.innerText.match(/\b(null|undefined|NaN)\b/g) ?? []).catch(() => []);
    if (bad.length) errors.push(`${label}: visible text contains ${bad.join(', ')}`);
  }
  await browser.close();
  if (errors.length) { console.error(`\nFAILED:\n${errors.map((e) => `  - ${e}`).join('\n')}`); process.exit(1); }
  console.log(`\nAll steps passed. Screenshots: ${OUT}`);
})().catch((err) => { console.error(`\nFAILED: ${err.message}`); process.exit(1); });
