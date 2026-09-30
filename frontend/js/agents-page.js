// Agent HQ: live office + activity feed + agent details + buttons that run real agents.
import { api, qs } from './api.js';
import { el, clear, notice, initThemeToggle, showVersion, PROFILES, LANGUAGES, TIER_LABELS, modelName, fallbackText, showSiteNotice, renderGuidance } from './ui.js';
import { mountOffice, AGENT_META } from './office-live.js';
import { OFFICE_W } from './pixel-office.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 20_000;

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
  const everyone = [...data.agents, ...(data.workers ?? [])];
  const runs = everyone.reduce((s, a) => s + (a.runs24h ?? 0), 0);
  const plus = everyone.some((a) => a.atLeast) ? '+' : ''; // only the latest runs are read: a lower bound
  const word = { healthy: 'All systems healthy', degraded: 'Degraded', down: 'Site down' }[w?.status] ?? 'Status unknown';
  const up = w?.uptime;
  const paused = data.control?.paused ?? [];
  const parts = [
    `${word}${w?.checkedAt ? ` (Otto checked ${ago(w.checkedAt)})` : ''}`,
    up?.upPct != null ? `available ${up.upPct}% of ${up.checks} checks in ${up.windowDays} days` : null,
    `${runs.toLocaleString()}${plus} agent runs in the last 24 h`,
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
        el('p', { class: 'hint' }, `${a.status === 'working' ? 'Working now' : a.status === 'error' ? 'Last run failed' : a.status === 'waiting' ? 'Has not run yet' : 'Ready'} · ${a.runs24h}${a.atLeast ? '+' : ''} runs and ${a.tokens24h.toLocaleString()}${a.atLeast ? '+' : ''} tokens in 24 h`))),
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

// ---------------------------------------------------------------- Ask the team
// A person's own question. On the server, Kai assigns it to the agents' real tools and code checks
// every number in the answer; here the office replays the steps they actually took.
const EXAMPLES = [
  'When should my construction crew in Karachi start work tomorrow?',
  'Is it safe to go for a run in Phoenix this evening?',
  'Write a heat plan for my grandmother in Delhi, in Hindi',
  'How accurate is the heat forecast in Dhaka?',
  'My coworker is confused and his skin is hot and dry. What do I do?',
  'هل الحر خطير في دبي اليوم؟',
  'Is HeatShield working right now?',
];
const conversationLog = []; // [{ role, text }], sent back so follow-up questions have context
const agentName = (id) => AGENT_META[id]?.name ?? id;

function who(id) {
  const tag = el('span', { class: 'ask-who' }, agentName(id));
  if (AGENT_META[id]?.color) tag.style.setProperty('--agent', AGENT_META[id].color); // CSSOM: the CSP allows no inline styles
  return tag;
}

/** The answer as text, line by line; only HeatShield's own pages become links. */
function answerBody(text, lang, dir) {
  const box = el('div', { class: 'ask-answer', lang, dir });
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const p = el('p', {});
    // Links: "/page" only, never "//host" (a protocol-relative URL leaves the site).
    for (const part of line.split(/(\[[^\]]+\]\(\/(?!\/)[^)\s]*\)|(?<![\w/])\/[?#][^\s)]+)/g)) {
      if (!part) continue;
      const md = part.match(/^\[([^\]]+)\]\((\/(?!\/)[^)\s]*)\)$/);
      if (md) p.append(el('a', { href: md[2] }, md[1]));
      else if (/^\/[?#]/.test(part)) p.append(el('a', { href: part }, part.startsWith('/#groups') ? 'Create a group' : 'Open this check and sign up for alerts'));
      else p.append(part);
    }
    box.append(p);
  }
  return box;
}

function traceList(trace) {
  const items = [];
  for (const t of trace) {
    items.push(el('li', {}, who(t.agent), ` ${t.action}${t.ok ? '' : ' (did not work)'}`, el('span', { class: 'hint' }, ` · ${(t.ms / 1000).toFixed(1)} s`)));
    for (const s of t.steps ?? []) items.push(el('li', { class: 'ask-sub' }, who(s.agent), ` ${s.action}`));
  }
  return el('ol', { class: 'ask-trace' }, items);
}

/** Replays the real steps in the office: Kai hands each task to the agent who did it. */
async function replay(res) {
  for (const t of res.trace) {
    if (t.agent !== 'kai') { live.office.passPaper('kai', t.agent); await sleep(700); }
    live.office.setTemp(t.agent, 'working', 1400);
    live.say(t.agent, t.action, t.ok ? 'done' : 'error', 10_000);
    for (const s of t.steps ?? []) {
      live.office.passPaper(t.agent, s.agent);
      await sleep(650);
      live.say(s.agent, s.action, 'done', 9000);
    }
    await sleep(450);
  }
  live.office.setTemp('kai', 'idle', 1);
  const helpers = res.agents.filter((a) => a !== 'kai').map(agentName);
  live.say('kai', `Answered in ${(res.durationMs / 1000).toFixed(1)} s${helpers.length ? ` with ${helpers.join(', ')}` : ''}.`, 'done', 12_000);
  for (const id of res.agents) live.office.celebrate(id);
}

async function askTeam(question) {
  const log = $('ask-log');
  const input = $('ask-input');
  const send = $('ask-send');
  log.append(el('div', { class: 'ask-msg user', dir: 'auto' }, question));
  const pending = el('div', { class: 'ask-msg team', 'aria-busy': 'true' },
    el('p', { class: 'loading-text' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Kai is reading your question and assigning it to the team…'));
  log.append(pending);
  pending.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  send.disabled = true;
  input.disabled = true;
  live.office.setTemp('kai', 'working', 30_000);
  live.say('kai', 'Reading a question and assigning it to the team…', 'working', 0);
  try {
    const res = await api('/api/ask', { method: 'POST', body: { message: question, history: conversationLog.slice(-4), language: (navigator.language || 'en').slice(0, 2) } });
    conversationLog.push({ role: 'user', text: question }, { role: 'assistant', text: res.answer.slice(0, 500) });
    replay(res); // the office catches up while the answer is already readable
    const helpers = res.agents.filter((a) => a !== 'kai').map(agentName);
    pending.removeAttribute('aria-busy');
    // Mira's plan, exactly as Lexi and Vera approved it (with Listen where Polly has a voice).
    let planCard = null;
    if (res.plan) {
      planCard = el('div', { class: 'ask-plan' });
      renderGuidance(planCard, res.plan);
    }
    pending.replaceChildren(...[
      answerBody(res.answer, res.language, res.dir),
      planCard,
      el('details', { class: 'ask-how' },
        el('summary', {}, `${helpers.length ? `Kai asked ${helpers.join(', ')}` : 'Kai answered directly'} · ${(res.durationMs / 1000).toFixed(1)} s`),
        res.trace.length ? traceList(res.trace) : null,
        el('p', { class: 'hint' }, `Coordinated by ${modelName(res.model)} on Amazon Bedrock. Every number was checked against what the tools returned${res.checks.rewrites ? '; the first answer was sent back to be fixed' : ''}${res.checks.removedSentences ? `; ${res.checks.removedSentences} sentence(s) that could not be verified were removed` : ''}${res.checks.unvetted ? '. This answer did not use the vetted health facts: check it with a health worker' : ''}.`)),
    ].filter(Boolean)); // DOM replaceChildren would print "null"
  } catch (err) {
    live.office.setTemp('kai', 'idle', 1);
    live.say('kai', err.message, err.status === 429 ? 'info' : 'error', 10_000);
    pending.removeAttribute('aria-busy');
    pending.replaceChildren(el('p', { class: 'notice error' }, err.message));
  } finally {
    send.disabled = false;
    input.disabled = false;
    input.value = '';
    poll();
  }
}

$('ask-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const question = $('ask-input').value.trim();
  if (question && !$('ask-send').disabled) askTeam(question);
});
$('ask-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('ask-form').requestSubmit(); }
});
$('ask-examples').append(...EXAMPLES.map((q) => {
  const b = el('button', { type: 'button', class: 'ask-example', dir: 'auto' }, q);
  b.addEventListener('click', () => { if (!$('ask-send').disabled) { $('ask-input').value = q; askTeam(q); } });
  return b;
}));
$('task-btn').addEventListener('click', () => {
  $('ask').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('ask-input').focus({ preventScroll: true });
});

// ---------------------------------------------------------------- boot
initThemeToggle($('theme-toggle'));
showSiteNotice();
showVersion($('version'));
poll();
setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
window.addEventListener('resize', () => { if (window.innerWidth < OFFICE_W) renderPanel(); });
