// Agent HQ: live office + activity feed + agent details + buttons that run real agents.
import { api, qs } from './api.js';
import { el, clear, notice, initThemeToggle, showVersion, PROFILES, LANGUAGES, TIER_LABELS, modelName, fallbackText, showSiteNotice } from './ui.js';
import { mountOffice, AGENT_META } from './office-live.js';
import { OFFICE_W } from './pixel-office.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 20_000;

// Real, hot places (the same ones the read-only demo group watches).
const PLACES = [
  { name: 'Karachi', lat: 24.86, lon: 67.01 }, { name: 'Dubai', lat: 25.2, lon: 55.27 },
  { name: 'New Delhi', lat: 28.61, lon: 77.21 }, { name: 'Cuiabá', lat: -15.6, lon: -56.1 },
  { name: 'Phoenix', lat: 33.45, lon: -112.07 }, { name: 'Lagos', lat: 6.45, lon: 3.39 },
  { name: 'Ho Chi Minh City', lat: 10.82, lon: 106.63 }, { name: 'Dhaka', lat: 23.81, lon: 90.41 },
  { name: 'Mombasa', lat: -4.04, lon: 39.67 }, { name: 'Manila', lat: 14.6, lon: 120.98 },
];

// Profiles as they read in a sentence ("a plan for a pregnant person", not "for pregnant").
const WHO = {
  outdoor_worker: 'an outdoor worker', elderly: 'an older adult', chronic_condition: 'someone with a chronic condition',
  child: 'a young child', pregnant: 'a pregnant person', general: 'the general public',
};

let data = null;
let selected = 'sol';

function ago(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
function until(iso) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`; // daily agents
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
const outcomeClass = (o) => (o === 'error' ? 'bad' : ['revise', 'degraded-reported', 'down-reported', 'partial'].includes(o) ? 'warn' : 'ok');

// ---------------------------------------------------------------- office
const live = mountOffice($('office'), { onSelect: (id) => { selected = id; renderPanel(); $('agent-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } });

async function poll() {
  try {
    data = await api('/api/agents');
    live.sync(data);
    renderStatus();
    renderFeed();
    renderPanel();
  } catch (err) {
    $('hq-status').textContent = `Could not reach the agents: ${err.message}`;
  }
}

function renderStatus() {
  const w = data.watchdog;
  const runs = [...data.agents, ...(data.workers ?? [])].reduce((s, a) => s + (a.runs24h ?? 0), 0);
  const word = { healthy: 'All systems healthy', degraded: 'Degraded', down: 'Site down' }[w?.status] ?? 'Status unknown';
  const up = w?.uptime;
  const paused = data.control?.paused ?? [];
  const parts = [
    `${word}${w?.checkedAt ? ` (Otto checked ${ago(w.checkedAt)})` : ''}`,
    up?.upPct != null ? `available ${up.upPct}% of ${up.checks} checks in ${up.windowDays} days` : null,
    `${runs} agent runs in the last 24 h`,
    data.control?.aiPaused ? 'new AI work paused by the operator or the daily budget' : null,
    paused.length ? `paused: ${paused.map((id) => AGENT_META[id]?.name ?? id).join(', ')}` : null,
    data.sentinel ? `Sol is watching ${data.sentinel.areas.length} areas, ${data.sentinel.events.length} heat event(s)` : null,
  ].filter(Boolean);
  $('hq-status').textContent = parts.join(' · ');
}

function renderFeed() {
  const items = [...data.agents, ...(data.workers ?? [])]
    .flatMap((a) => (a.recent ?? []).map((r) => ({ ...r, id: a.id, name: a.name })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 24);
  const feed = clear($('feed'));
  if (!items.length) feed.append(el('li', { class: 'hint' }, 'No runs yet.'));
  for (const r of items) {
    const meta = AGENT_META[r.id];
    feed.append(el('li', { class: 'feed-item' },
      el('span', { class: 'feed-chip', dataset: { agent: r.id } }, meta?.name ?? r.name),
      el('div', { class: 'feed-body' },
        el('p', { class: 'feed-summary' }, r.summary || r.outcome),
        el('p', { class: 'feed-meta' },
          el('span', { class: `feed-outcome ${outcomeClass(r.outcome)}` }, r.outcome),
          ` · ${r.trigger} · ${ago(r.at)}`,
          r.durationMs ? ` · ${(r.durationMs / 1000).toFixed(1)} s` : '',
          r.model ? ` · ${modelName(r.model)}` : '',
          r.tokens ? ` · ${r.tokens} tokens` : ''))));
  }
}

// ---------------------------------------------------------------- agent panel
function portrait(id) {
  const canvas = el('canvas', { class: 'portrait', width: 28, height: 30, 'aria-hidden': 'true' });
  const seat = live.SEATS[id];
  const top = seat.row === 0 ? 104 : 160;
  const office = $('office').querySelector('canvas');
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(office, seat.cx - 14, top - 28, 28, 30, 0, 0, 28, 30);
  return canvas;
}

function row(label, value) {
  return value ? el('div', { class: 'kv' }, el('dt', {}, label), el('dd', {}, value)) : null;
}

function specialFor(a) {
  const d = a.lastRun?.detail;
  switch (a.id) {
    case 'sol': {
      const s = data.sentinel;
      if (!s) return null;
      const stale = (s.areas ?? []).filter((x) => x.stale);
      return el('div', { class: 'panel-block' },
        el('h3', {}, 'Latest briefing'),
        s.briefedAt ? el('p', { class: 'hint' }, `Written ${ago(s.briefedAt)}; Sol re-checked the forecast ${ago(s.generatedAt)}.`) : null,
        el('p', {}, s.briefing),
        el('ul', { class: 'plain-list' }, (s.events ?? []).map((e) => el('li', {},
          el('span', { class: `level ${e.level}` }, e.level), ' ', el('strong', {}, e.place), ` · ${e.trend} · ${e.headline.replace(/^[^:]+:\s*/, '')}`,
          e.stale ? el('span', { class: 'hint' }, ' (earlier data: the forecast service refused this hour’s refresh)') : null))),
        stale.length ? el('p', { class: 'hint' }, `${stale.length} area(s) kept from earlier data this hour: ${stale.map((a) => a.place.split(',')[0]).join(', ')}. Open-Meteo refused the refresh, and Sol keeps the last good forecast for up to 3 hours instead of dropping an area.`) : null);
    }
    case 'mira':
      return d?.headline ? el('div', { class: 'panel-block' }, el('h3', {}, 'Last plan headline'), el('p', { lang: d.language, dir: LANGUAGES[d.language]?.dir ?? 'ltr' }, d.headline),
        el('p', { class: 'hint' }, `Facts retrieved by BM25: ${(d.factsUsed ?? []).join(', ')}`)) : null;
    case 'lexi':
    case 'vera': {
      const reviews = (data.reviews ?? []).filter((r) => r.agent === a.id).slice(0, 3);
      if (!reviews.length) return null;
      return el('div', { class: 'panel-block' }, el('h3', {}, 'Recent reviews'),
        el('ul', { class: 'plain-list' }, reviews.map((r) => el('li', {},
          el('span', { class: `feed-outcome ${r.verdict === 'approve' ? 'ok' : 'warn'}` }, r.verdict === 'approve' ? 'approved' : 'sent back'),
          ` ${LANGUAGES[r.language]?.native ?? r.language} · ${ago(r.at)}`,
          r.backTranslationHeadline ? el('div', { class: 'hint' }, `Back-translation: "${r.backTranslationHeadline}"`) : null,
          (r.issues ?? []).filter((i) => i.severity !== 'minor').slice(0, 2).map((i) => el('div', { class: 'hint' }, `Blocking: ${i.problem}`))))));
    }
    case 'kai':
      return el('div', { class: 'panel-block' }, el('h3', {}, 'Where to see the plans'),
        el('p', {}, 'Kai\'s check-in plans live on each leader\'s private dashboard. The demo group\'s plan is public: '),
        el('p', {}, el('a', { href: '/group.html', id: 'kai-demo-link' }, 'Open the demo dashboard')));
    case 'otto': {
      const w = data.watchdog;
      if (!w) return null;
      return el('div', { class: 'panel-block' }, el('h3', {}, 'Latest checks'),
        el('table', { class: 'data-table' },
          el('thead', {}, el('tr', {}, el('th', {}, 'Probe'), el('th', {}, 'Result'), el('th', {}, 'Latency'), el('th', {}, 'Moving avg'))),
          el('tbody', {}, (w.probes ?? []).map((p) => el('tr', {},
            el('td', {}, p.id), el('td', {}, p.ok ? (p.anomaly ? 'slow' : 'ok') : `failed (${p.status})`),
            el('td', { class: 'num' }, `${p.ms} ms`), el('td', { class: 'num' }, p.avgMs ? `${p.avgMs} ms` : '—'))))),
        el('p', { class: 'hint' }, `Heartbeats: ${(w.heartbeats ?? []).map((h) => `${h.agent} ${h.minutesAgo ?? '—'} min ago`).join(' · ')}`),
        w.uptime?.upPct != null ? el('p', { class: 'hint' }, `Availability, last ${w.uptime.windowDays} days: ${w.uptime.upPct}% up, ${w.uptime.healthyPct}% fully healthy (${w.uptime.checks} checks since ${w.uptime.since}).`) : null,
        (w.remediations ?? []).length ? el('p', { class: 'hint' }, `Self-repair on the last check: ${w.remediations.map((r) => `re-ran ${AGENT_META[r.agent]?.name ?? r.agent}${r.ok ? '' : ' (failed)'}`).join(', ')}.`) : null,
        (w.issues ?? []).filter((i) => i.severity === 'info').map((i) => el('p', { class: 'hint' }, `Note: ${i.detail}`)),
        w.incident ? el('div', { class: 'callout info mt-6' }, el('p', {}, el('strong', {}, `Last incident: ${w.incident.title}`), `${w.incident.summary} Likely cause: ${w.incident.likelyCause}`)) : null);
    }
    case 'quinn': {
      const q = data.auditor;
      const quinnByline = (a) => {
        const rejected = a.rejectedClaims ?? [];
        const picked = a.noteBy === 'model'
          ? ` Quinn picked the other facts and code checked each one${rejected.length ? `, rejecting ${rejected.length} the numbers do not support (${rejected.map((r) => `${r.city}: ${String(r.claim).replace(/_/g, ' ')}`).join('; ')})` : ''}.`
          : '';
        return `Missed and false Danger calls are counted and written by code.${picked} Compared with ${a.reference}.`;
      };
      if (!q) return el('div', { class: 'panel-block' }, el('p', { class: 'hint' }, 'Quinn audits the forecast once a day at 01:30 UTC; the first report appears after the first run.'));
      return el('div', { class: 'panel-block' }, el('h3', {}, `Forecast track record, last ${q.windowDays} days`),
        el('p', {}, q.note),
        el('p', { class: 'hint' }, quinnByline(q)),
        el('div', { class: 'table-scroll' }, el('table', { class: 'data-table' },
          el('thead', {}, el('tr', {}, el('th', {}, 'City'), el('th', { class: 'num' }, 'Day-ahead error'), el('th', { class: 'num' }, 'Bias'), el('th', { class: 'num' }, 'Right tier'), el('th', {}, 'Danger calls'))),
          el('tbody', {}, q.cities.map((c) => el('tr', {},
            el('td', {}, c.place.split(',')[0]),
            el('td', { class: 'num' }, `${c.lead1.maeC} °C`),
            el('td', { class: 'num' }, `${c.lead1.biasC > 0 ? '+' : ''}${c.lead1.biasC} °C`),
            el('td', { class: 'num' }, `${Math.round(c.lead1.tierAgreement * 100)}%`),
            el('td', {}, `${c.danger.hits} right · ${c.danger.misses} missed · ${c.danger.falseAlarms} false`)))))));
    }
    case 'iris': {
      const c = data.coach;
      if (!c) return el('div', { class: 'panel-block' }, el('p', { class: 'hint' }, 'Iris coaches once a day at 02:30 UTC; the first word lists appear after the first run.'));
      const langs = Object.entries(c.sizes ?? {});
      return el('div', { class: 'panel-block' }, el('h3', {}, 'Mira\'s word lists'),
        el('p', {}, `From ${c.reviewed} corrections in the last 7 days, Iris added ${Object.values(c.added ?? {}).reduce((a, b) => a + b, 0)} word(s) and rejected ${c.rejected} on a second look.`),
        langs.length ? el('ul', { class: 'plain-list' }, langs.map(([lang, n]) => el('li', {},
          el('strong', {}, el('bdi', { lang }, LANGUAGES[lang]?.native ?? lang), `: ${n} word(s)`),
          (c.samples?.[lang] ?? []).map((e) => el('div', { class: 'hint' },
            '"', el('bdi', { lang }, e.use), `" (${e.meaning}), not "`, el('bdi', { lang }, e.wrong), '"'))))) : el('p', { class: 'hint' }, 'No word lists yet.'));
    }
    default: return null;
  }
}

function renderPanel() {
  if (!data) return;
  const a = data.agents.find((x) => x.id === selected);
  if (!a) return;
  const panel = clear($('agent-panel'));
  panel.append(
    el('div', { class: 'panel-head' }, portrait(a.id),
      el('div', {}, el('h2', { id: 'agent-title' }, `${a.name} · ${a.role}`),
        el('p', { class: 'hint' }, `${a.status === 'working' ? 'Working now' : a.status === 'error' ? 'Last run failed' : a.status === 'waiting' ? 'Has not run yet' : 'Ready'} · ${a.runs24h} runs and ${a.tokens24h.toLocaleString()} tokens in 24 h`))),
    el('dl', { class: 'kv-list' },
      row('Expertise', a.expertise),
      row('Algorithm', a.algorithm),
      row('Decides', a.decides),
      row('Model', a.model),
      row('Tools', a.tools?.length ? a.tools.join(', ') : 'none (single reasoning step)'),
      row('Runs', a.trigger),
      row('Next run', a.nextRunAt ? el('span', { class: 'countdown', dataset: { at: a.nextRunAt } }, `in ${until(a.nextRunAt)}`) : 'on demand')),
    a.lastRun ? el('div', { class: 'panel-block' }, el('h3', {}, `Last run · ${ago(a.lastRun.at)}`), el('p', {}, a.lastRun.summary)) : null,
    specialFor(a),
  );
  loadDemoLink();
}

setInterval(() => {
  for (const c of document.querySelectorAll('.countdown')) c.textContent = `in ${until(c.dataset.at)}`;
}, 1000);

// ---------------------------------------------------------------- demo group (for Kai)
let demo = null;
async function loadDemo() {
  if (demo) return demo;
  const d = await fetch('/demo.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!d?.dashboardPath) return null;
  const p = new URLSearchParams(d.dashboardPath.split('#')[1]);
  demo = { groupId: p.get('g'), key: p.get('k'), path: d.dashboardPath };
  return demo;
}
async function loadDemoLink() {
  const link = document.getElementById('kai-demo-link');
  if (!link) return;
  const d = await loadDemo();
  if (d) link.href = d.path;
}

// ---------------------------------------------------------------- buttons
function busy(button, ms) {
  button.disabled = true;
  setTimeout(() => { button.disabled = false; }, ms);
}

$('sol-btn').addEventListener('click', async (e) => {
  busy(e.currentTarget, 15_000);
  live.office.setTemp('sol', 'working', 25_000);
  live.say('sol', `Scanning every watched area against its own 30-year climate…`, 'working', 0);
  try {
    const res = await api('/api/agents/sol/run', { method: 'POST' });
    live.office.setTemp('sol', 'idle', 1);
    live.say('sol', res.result.summary, 'done', 14_000);
    live.office.celebrate('sol');
  } catch (err) {
    live.office.setTemp('sol', 'idle', 1);
    live.say('sol', err.message, err.status === 429 ? 'info' : 'error', 10_000);
    live.office.attention('sol');
  }
  poll();
});

$('otto-btn').addEventListener('click', async (e) => {
  busy(e.currentTarget, 10_000);
  live.office.setTemp('otto', 'working', 20_000);
  live.say('otto', 'Probing the site, the API and the weather provider…', 'working', 0);
  try {
    const res = await api('/api/agents/otto/run', { method: 'POST' });
    live.office.setTemp('otto', 'idle', 1);
    live.say('otto', res.result.summary, res.result.outcome === 'healthy' ? 'done' : 'info', 14_000);
    if (res.result.outcome === 'healthy') live.office.celebrate('otto'); else live.office.attention('otto');
  } catch (err) {
    live.office.setTemp('otto', 'idle', 1);
    live.say('otto', err.message, err.status === 429 ? 'info' : 'error', 10_000);
    live.office.attention('otto');
  }
  poll();
});

$('kai-btn').addEventListener('click', async (e) => {
  busy(e.currentTarget, 15_000);
  const d = await loadDemo();
  if (!d) { live.say('kai', 'The demo group is not available right now.', 'error'); return; }
  live.office.setTemp('kai', 'working', 25_000);
  live.say('kai', 'Scoring urgency and scheduling check-ins, earliest deadline first…', 'working', 0);
  try {
    const res = await api(`/api/groups/${encodeURIComponent(d.groupId)}/plan`, { method: 'POST', headers: { 'x-admin-key': d.key } });
    const c = res.coordinator;
    const first = c?.checkIns?.[0];
    live.office.setTemp('kai', 'idle', 1);
    live.say('kai', c?.allClear ? c.summary : `${c.checkIns.length} check-ins planned. First: ${first.name}, ${first.checkInBy}. ${first.action}`, 'done', 16_000);
    live.office.celebrate('kai');
  } catch (err) {
    live.office.setTemp('kai', 'idle', 1);
    live.say('kai', err.message, err.status === 429 ? 'info' : 'error', 10_000);
  }
  poll();
});

// "Give the team a task": a REAL action plan request. Mira writes, Lexi and Vera review; the office
// replays the review rounds the server actually ran (returned with the plan).
let lastTask = '';
$('task-btn').addEventListener('click', async (e) => {
  busy(e.currentTarget, 12_000);
  let place; let profile; let lang;
  do {
    place = PLACES[Math.floor(Math.random() * PLACES.length)];
    profile = Object.keys(PROFILES)[Math.floor(Math.random() * Object.keys(PROFILES).length)];
    lang = Object.keys(LANGUAGES)[Math.floor(Math.random() * Object.keys(LANGUAGES).length)];
  } while (`${place.name}${profile}${lang}` === lastTask);
  lastTask = `${place.name}${profile}${lang}`;
  const who = WHO[profile] ?? PROFILES[profile].label.toLowerCase();
  const langName = LANGUAGES[lang].native;

  const out = $('task-result');
  out.hidden = false;
  clear(out).append(el('h2', {}, `Task: an action plan for ${who} in ${place.name}, in ${langName}`),
    el('p', { class: 'loading-text' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Mira is writing; Lexi and Vera will review before anything is shown…'));

  live.office.setTemp('mira', 'working', 60_000);
  live.say('mira', `Writing a plan for ${who} in ${place.name}, in ${langName}…`, 'working', 0);
  live.say('lexi', 'Waiting for Mira\'s draft…', 'info', 0);
  live.say('vera', 'Waiting for Mira\'s draft…', 'info', 0);

  let res;
  try {
    res = await api(`/api/guidance?${qs({ lat: place.lat, lon: place.lon, profile, lang })}`);
  } catch (err) {
    live.office.setTemp('mira', 'idle', 1);
    live.say('mira', err.message, 'error', 10_000);
    live.say('lexi', '');
    live.say('vera', '');
    notice(out, err.message);
    return;
  }
  const g = res.guidance;
  const review = g.review ?? {};
  const secs = g.durationMs ? `${(g.durationMs / 1000).toFixed(1)} s` : '';

  if (g.source === 'cache') {
    live.office.setTemp('mira', 'idle', 1);
    live.say('mira', `Same situation already written and approved earlier; reused in ${secs}.`, 'done', 12_000);
    live.say('lexi', 'Approved earlier ✓', 'done', 8000);
    live.say('vera', 'Approved earlier ✓', 'done', 8000);
  } else {
    // Replay each real review round.
    const rounds = review.rounds?.length ? review.rounds : [{ language: review.language?.verdict, safety: review.safety?.verdict, blocking: [] }];
    for (let i = 0; i < rounds.length; i += 1) {
      const r = rounds[i];
      live.say('mira', i === 0 ? 'Draft ready. Sending it for review.' : `Revision ${i} ready. Sending it back.`, 'working', 0);
      live.office.passPaper('mira', 'lexi');
      live.office.passPaper('mira', 'vera');
      await sleep(950);
      live.office.setTemp('lexi', 'working', 1600);
      live.office.setTemp('vera', 'working', 1600);
      await sleep(1600);
      const blocked = (r.blocking ?? [])[0];
      live.say('lexi', r.language === 'approve' ? 'Language ✓ real words, right meaning' : `Sent back: ${blocked ?? 'language problem'}`, r.language === 'approve' ? 'done' : 'error', 0);
      live.say('vera', r.safety === 'approve' ? 'Safety ✓ matches the vetted facts' : `Sent back: ${blocked ?? 'safety problem'}`, r.safety === 'approve' ? 'done' : 'error', 0);
      if (r.language !== 'approve') live.office.attention('lexi', 1500);
      if (r.safety !== 'approve') live.office.attention('vera', 1500);
      await sleep(1700);
    }
    live.office.setTemp('mira', 'idle', 1);
    if (g.source === 'bedrock') {
      live.say('mira', `Published after ${review.revisions ?? 0} revision(s), ${secs}.`, 'done', 12_000);
      for (const id of ['mira', 'lexi', 'vera']) live.office.celebrate(id);
    } else {
      live.say('mira', 'The reviewers rejected my drafts, so safe pre-written advice is shown instead.', 'error', 12_000);
    }
    setTimeout(() => { live.say('lexi', '', 'info', 1); live.say('vera', '', 'info', 1); }, 9000);
  }

  // Result card: the plan, in its language, with the reviewer's English back-translation.
  const dir = LANGUAGES[g.language]?.dir ?? 'ltr';
  const bt = review.language?.backTranslation;
  clear(out).append(
    el('h2', {}, `Task: an action plan for ${who} in ${place.name}, in ${langName}`),
    el('p', { class: 'hint' },
      g.source === 'cache' ? `Reused an approved plan (${secs}).`
        : g.source === 'bedrock' ? `Written by ${modelName(g.model)}, ${review.status === 'approved' ? 'approved by Lexi and Vera' : review.status}${review.revisions ? ` after ${review.revisions} revision(s)` : ''} · ${secs}`
          : `Pre-written safety guidance (${fallbackText(g.fallbackReason)}) · ${secs}`,
      ` · Heat now: ${TIER_LABELS[res.risk.current.tier]}`),
    el('div', { class: 'task-plan', lang: g.language, dir },
      el('p', { class: 'guidance-headline' }, g.headline),
      el('ol', { class: 'guidance-actions' }, g.actions.map((x) => el('li', {}, el('span', {}, x)))),
      el('div', { class: 'callout alert' }, el('p', {}, g.seekHelp))),
    bt && g.language !== 'en' ? el('details', { class: 'table-view', open: true }, el('summary', {}, 'Lexi\'s literal English back-translation'),
      el('p', {}, el('strong', {}, bt.headline)), el('ul', { class: 'plain-list' }, bt.actions.map((x) => el('li', {}, x))), el('p', {}, bt.seekHelp)) : null,
    (review.rounds ?? []).length ? el('details', { class: 'table-view' }, el('summary', {}, 'Review rounds'),
      el('ol', { class: 'plain-list' }, review.rounds.map((r, i) => el('li', {}, `Round ${i + 1}: Lexi ${r.language === 'approve' ? '✓' : '✗'} · Vera ${r.safety === 'approve' ? '✓' : '✗'}${r.blocking?.length ? ` · ${r.blocking.join(' / ')}` : ''}`)))) : null,
    el('p', { class: 'mt-16' }, el('a', { href: `/?${qs({ place: place.name, lat: place.lat, lon: place.lon, profile, lang })}#check` }, `Open the full check for ${place.name}`)),
  );
  poll();
});

// ---------------------------------------------------------------- boot
initThemeToggle($('theme-toggle'));
showSiteNotice();
showVersion($('version'));
poll();
setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
window.addEventListener('resize', () => { if (window.innerWidth < OFFICE_W) renderPanel(); });
