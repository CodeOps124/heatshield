// Admin console. Sign-in: Amazon Cognito hosted page, authorization code + PKCE, with state and
// nonce checks. The ID token lives in sessionStorage only (gone when the tab closes) and is sent
// as a bearer token; API Gateway verifies it, the admin API requires the "admins" group.
import { api } from './api.js';
import { el, clear, notice, initThemeToggle, showVersion, LANGUAGES, TIER_LABELS } from './ui.js';

const $ = (id) => document.getElementById(id);
const SESSION = 'hs-admin-session';
const PKCE = 'hs-admin-pkce';
let config = null;
let session = null;
let data = null;

// ---------------------------------------------------------------- sign-in
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const challenge = async (verifier) => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
const redirectUri = () => `${location.origin}/admin.html`;

function decodeJwt(token) {
  const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function signIn() {
  const verifier = random(48);
  const state = random(24);
  const nonce = random(24);
  sessionStorage.setItem(PKCE, JSON.stringify({ verifier, state, nonce }));
  const url = new URL(`https://${config.authDomain}/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: config.clientId, redirect_uri: redirectUri(), scope: 'openid email',
    state, nonce, code_challenge: await challenge(verifier), code_challenge_method: 'S256',
  });
  location.assign(url);
}

async function completeSignIn(params) {
  const saved = JSON.parse(sessionStorage.getItem(PKCE) ?? 'null');
  sessionStorage.removeItem(PKCE);
  history.replaceState(null, '', '/admin.html');
  if (!saved || params.get('state') !== saved.state) throw new Error('The sign-in response did not match this browser session. Please sign in again.');
  const res = await fetch(`https://${config.authDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: config.clientId, code: params.get('code'), redirect_uri: redirectUri(), code_verifier: saved.verifier }),
  });
  if (!res.ok) throw new Error('Sign-in could not be completed (the code may have expired). Please sign in again.');
  const tokens = await res.json();
  const claims = decodeJwt(tokens.id_token);
  if (claims.nonce !== saved.nonce || claims.aud !== config.clientId) throw new Error('The sign-in token was not issued for this session. Please sign in again.');
  session = { idToken: tokens.id_token, email: claims.email, exp: claims.exp * 1000 };
  sessionStorage.setItem(SESSION, JSON.stringify(session));
}

function storedSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION) ?? 'null');
    return s && s.exp - Date.now() > 60_000 ? s : null;
  } catch {
    return null;
  }
}

function signOut() {
  sessionStorage.removeItem(SESSION);
  const url = new URL(`https://${config.authDomain}/logout`);
  url.search = new URLSearchParams({ client_id: config.clientId, logout_uri: redirectUri() });
  location.assign(url);
}

function showSignIn(message) {
  $('console').hidden = true;
  $('signin').hidden = false;
  if (message) notice($('admin-status'), message, 'error');
}

async function adminApi(path, opts = {}) {
  try {
    return await api(path, { ...opts, headers: { authorization: `Bearer ${session.idToken}` } });
  } catch (err) {
    if (err.status === 401) {
      sessionStorage.removeItem(SESSION);
      session = null;
      showSignIn('Your session has ended. Please sign in again.');
    }
    throw err;
  }
}

// ---------------------------------------------------------------- helpers
const money = (x) => `US$${(x ?? 0).toFixed(2)}`;
function ago(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
const stat = (label, value, sub, cls = '') => el('div', { class: `stat ${cls}` }, el('p', { class: 'label' }, label), el('div', { class: 'value' }, value), sub ? el('div', { class: 'sub' }, sub) : null);
function busy(button, text) {
  const old = button.textContent;
  button.disabled = true;
  button.textContent = text;
  return () => { button.disabled = false; button.textContent = old; };
}
async function saveSettings(patch, button, label = 'Saving…') {
  const done = button ? busy(button, label) : () => {};
  try {
    await adminApi('/api/admin/settings', { method: 'PUT', body: patch });
    await load();
  } catch (err) {
    notice($('admin-status'), err.message, 'error');
  } finally {
    done();
  }
}

// ---------------------------------------------------------------- panels
function renderSystem(o) {
  const w = o.watchdog;
  const alarms = o.alarms ?? [];
  const firing = alarms.filter((a) => a.state === 'ALARM');
  clear($('status-tiles')).append(
    stat('Site', w ? w.status : 'unknown', w ? `Otto checked ${ago(w.checkedAt)}` : null, w?.status === 'healthy' ? 'ok' : 'warn'),
    stat('Availability, 7 days', w?.uptime?.upPct != null ? `${w.uptime.upPct}%` : '—', w?.uptime ? `${w.uptime.checks} checks · ${w.uptime.healthyPct}% fully healthy` : null),
    stat('CloudWatch alarms', `${firing.length} firing`, `${alarms.length} alarms watched`, firing.length ? 'warn' : 'ok'),
    stat('Failed scheduled runs', o.failedRuns == null ? '—' : String(o.failedRuns), 'retried once, then queued', o.failedRuns ? 'warn' : 'ok'),
  );
  const list = el('details', { class: 'table-view' }, el('summary', {}, firing.length ? `Alarms (${firing.length} firing)` : 'Alarms (all OK)'),
    el('ul', { class: 'plain-list' }, alarms.map((a) => el('li', {}, el('span', { class: `pill ${a.state === 'ALARM' ? 'alarm' : ''}` }, a.state), ` ${a.name}: ${a.description}`))));
  if (firing.length) list.open = true;
  clear($('alarms')).append(list);
  if (w?.incident) $('alarms').append(el('div', { class: 'callout info mt-16' }, el('p', {}, el('strong', {}, `Last incident: ${w.incident.title}`), `${w.incident.summary} Likely cause: ${w.incident.likelyCause}`)));

  const failed = clear($('failed-runs'));
  if (o.failedRuns) {
    const show = el('button', { type: 'button', class: 'btn secondary small' }, 'Show failed runs');
    const purge = el('button', { type: 'button', class: 'btn danger small' }, 'Clear the queue');
    const out = el('ul', { class: 'plain-list' });
    show.addEventListener('click', async () => {
      const done = busy(show, 'Loading…');
      try {
        const { runs } = await adminApi('/api/admin/failed-runs');
        clear(out).append(...runs.map((r) => el('li', {}, `${r.function ?? 'unknown function'} · ${ago(r.at)} · ${r.attempts ?? '?'} attempts · ${r.error || r.condition || 'no error text'}`)));
      } finally { done(); }
    });
    purge.addEventListener('click', async () => {
      if (!window.confirm('Delete every message in the failed-runs queue?')) return;
      const done = busy(purge, 'Clearing…');
      try { await adminApi('/api/admin/failed-runs', { method: 'DELETE' }); await load(); } finally { done(); }
    });
    failed.append(el('div', { class: 'admin-bar-actions' }, show, purge), out);
  }
}

function renderBudget(o) {
  const b = o.budget;
  const s = o.settings;
  const pct = Math.min(100, Math.round((b.spentUsd / b.budgetUsd) * 100));
  const meter = el('div', { class: 'meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(b.budgetUsd), 'aria-valuenow': String(b.spentUsd), 'aria-label': 'AI spend today' },
    el('div', { class: `meter-fill${b.tripped ? ' tripped' : ''}` }));
  meter.firstChild.style.width = `${pct}%`;

  const toggle = el('button', { type: 'button', class: s.aiPaused ? 'btn small' : 'btn danger small' }, s.aiPaused ? 'Resume AI work' : 'Pause all AI now');
  toggle.addEventListener('click', () => saveSettings({ aiPaused: !s.aiPaused }, toggle));

  const form = el('form', { class: 'admin-row', novalidate: true },
    el('div', {}, el('label', { for: 'budget-input' }, 'Daily budget (US$)'),
      el('input', { id: 'budget-input', type: 'number', min: '0.5', max: '100', step: '0.5', value: String(s.budgetUsd) })),
    el('div', { class: 'admin-row-end' }, el('button', { class: 'btn secondary small', type: 'submit' }, 'Save')));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    saveSettings({ budgetUsd: Number($('budget-input').value) }, form.querySelector('button'));
  });

  // 7-day spend: one series, so no legend; bars anchored to the baseline, value on hover, table below.
  const max = Math.max(...o.spend7d.map((d) => d.usd), 0.01);
  const bars = el('div', { class: 'bars', role: 'img', 'aria-label': `AI spend per day, last 7 days: ${o.spend7d.map((d) => `${d.day} ${money(d.usd)}`).join(', ')}` },
    o.spend7d.map((d) => {
      const bar = el('div', { class: 'bar', title: `${d.day}: ${money(d.usd)}` }, el('span', { class: 'bar-fill' }), el('span', { class: 'bar-label' }, d.day.slice(5)));
      bar.firstChild.style.height = `${Math.max(2, Math.round((d.usd / max) * 100))}%`;
      return bar;
    }));
  const byAgent = Object.entries(b.byAgent ?? {}).sort((x, y) => y[1] - x[1]);

  clear($('budget')).append(
    el('p', { class: 'admin-big' }, `${money(b.spentUsd)} `, el('span', { class: 'hint' }, `of ${money(b.budgetUsd)} today (UTC)`)),
    meter,
    b.tripped ? el('p', { class: 'notice error mt-6' }, 'Budget reached: new AI plans and agent model calls are paused until 00:00 UTC. Heat alerts continue with cached or pre-written advice. Raise the budget to resume now.') : null,
    s.aiPaused ? el('p', { class: 'notice error mt-6' }, 'All AI work is paused by an operator. Alerts continue with cached or pre-written advice.') : null,
    el('div', { class: 'admin-bar-actions mt-16' }, toggle),
    form,
    el('h3', { class: 'mt-16' }, 'Spend by agent today'),
    byAgent.length ? el('ul', { class: 'plain-list' }, byAgent.map(([agent, usd]) => el('li', {}, `${agent}: ${money(usd)}`))) : el('p', { class: 'hint' }, 'No model calls yet today.'),
    el('h3', { class: 'mt-16' }, 'AI spend per day, last 7 days'),
    bars,
    el('details', { class: 'table-view' }, el('summary', {}, 'Table'),
      el('table', { class: 'data-table' }, el('thead', {}, el('tr', {}, el('th', {}, 'Day (UTC)'), el('th', { class: 'num' }, 'Spend'))),
        el('tbody', {}, o.spend7d.map((d) => el('tr', {}, el('td', {}, d.day), el('td', { class: 'num' }, money(d.usd))))))),
    el('p', { class: 'hint mt-6' }, 'Measured from the agent log: every run records its model and tokens; prices from the AWS Price List API.'),
  );
}

function renderNotice(o) {
  const n = o.settings.notice;
  clear($('notice-current')).append(n
    ? el('div', { class: `site-notice ${n.level} admin-preview` }, el('strong', {}, 'Live now: '), n.text, n.until ? el('span', { class: 'hint' }, ` (until ${new Date(n.until).toLocaleString()})`) : null)
    : el('p', { class: 'hint' }, 'No notice is showing.'));
}

function renderAgents(o) {
  const tbody = clear($('agents-table').tBodies[0]);
  for (const a of o.agents) {
    const paused = Boolean(o.settings.paused[a.id]);
    const actions = el('div', { class: 'admin-bar-actions' });
    if (a.pausable) {
      const b = el('button', { type: 'button', class: 'btn secondary small' }, paused ? 'Resume' : 'Pause');
      b.addEventListener('click', () => saveSettings({ paused: { [a.id]: !paused } }, b));
      actions.append(b);
    }
    if (a.runnable) {
      const r = el('button', { type: 'button', class: 'btn secondary small' }, 'Run now');
      r.addEventListener('click', async () => {
        const done = busy(r, 'Running…');
        try {
          const res = await adminApi(`/api/admin/agents/${a.id}/run`, { method: 'POST' });
          notice($('admin-status'), res.started ? `${a.name} started in the background.` : `${a.name}: ${res.result?.summary ?? res.result?.outcome ?? 'done'}`, 'ok');
          await load();
        } catch (err) {
          notice($('admin-status'), `${a.name}: ${err.message}`, 'error');
        } finally { done(); }
      });
      actions.append(r);
    }
    tbody.append(el('tr', {},
      el('td', {}, el('div', { class: 'member-name' }, a.name), el('div', { class: 'member-sub' }, a.role)),
      el('td', {}, el('span', { class: `pill ${paused ? 'alarm' : ''}` }, paused ? 'paused' : a.status)),
      el('td', {}, el('div', {}, a.lastRun ? ago(a.lastRun.at) : 'never'), el('div', { class: 'member-sub' }, a.lastRun?.summary ?? '')),
      el('td', { class: 'num' }, String(a.runs24h ?? 0)),
      el('td', {}, actions)));
  }
}

function renderQuality(o) {
  const row = (label, q) => el('tr', {}, el('td', {}, label), el('td', { class: 'num' }, String(q.total)), el('td', { class: 'num' }, String(q.published ?? 0)), el('td', { class: 'num' }, String(q.fallback ?? 0)),
    el('td', { class: 'num' }, q.total ? `${Math.round(((q.published ?? 0) / q.total) * 100)}%` : '—'));
  const q7 = o.quality.last7d;
  const langs = Object.entries(q7.byLanguage).sort((a, b) => b[1].total - a[1].total);
  const reasons = Object.entries(q7.reasons);
  clear($('quality')).append(
    el('p', { class: 'hint' }, 'New plans people asked for (cached ones are not counted): published after review, or pre-written advice instead.'),
    el('div', { class: 'table-scroll' }, el('table', { class: 'data-table' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Window'), el('th', { class: 'num' }, 'Plans'), el('th', { class: 'num' }, 'Published'), el('th', { class: 'num' }, 'Pre-written'), el('th', { class: 'num' }, 'Rate'))),
      el('tbody', {}, row('Last 24 h', o.quality.last24h), row('Last 7 days', q7)))),
    el('h3', { class: 'mt-16' }, 'By language, 7 days'),
    langs.length ? el('ul', { class: 'plain-list' }, langs.map(([lang, v]) => el('li', {}, `${LANGUAGES[lang]?.native ?? lang}: ${v.published} of ${v.total} published`))) : el('p', { class: 'hint' }, 'No new plans yet.'),
    reasons.length ? el('p', { class: 'hint mt-6' }, `Why pre-written advice was shown: ${reasons.map(([r, n]) => `${r.replace(/_/g, ' ')} ${n}`).join(' · ')}`) : null,
  );
}

async function loadPlans() {
  const { plans } = await adminApi('/api/admin/plans');
  const list = clear($('plans'));
  if (!plans.length) list.append(el('li', { class: 'hint' }, 'No plans yet.'));
  for (const p of plans.slice(0, 15)) {
    const li = el('li', {},
      el('span', { class: `pill ${p.outcome === 'published' ? '' : 'alarm'}` }, p.outcome), ' ',
      `${LANGUAGES[p.language]?.native ?? p.language} · ${p.profile?.replace(/_/g, ' ')} · ${TIER_LABELS[p.tier] ?? p.tier} · ${ago(p.at)}`,
      p.headline ? el('div', { class: 'member-sub', lang: p.language, dir: LANGUAGES[p.language]?.dir ?? 'ltr' }, p.headline) : null,
      p.reason ? el('div', { class: 'member-sub' }, `reason: ${p.reason.replace(/_/g, ' ')}`) : null);
    if (p.cacheKey) {
      const b = el('button', { type: 'button', class: 'btn danger small mt-6' }, 'Recall');
      b.addEventListener('click', async () => {
        if (!window.confirm('Remove this plan from the cache? The next person in this situation gets a newly written and reviewed plan.')) return;
        const done = busy(b, 'Recalling…');
        try {
          await adminApi(`/api/admin/plans/${p.cacheKey}`, { method: 'DELETE' });
          b.replaceWith(el('span', { class: 'hint' }, ' recalled'));
          await load();
        } catch (err) {
          done();
          notice($('admin-status'), err.message, 'error');
        }
      });
      li.append(el('div', {}, b));
    }
    list.append(li);
  }
}

function renderAudit(o) {
  const list = clear($('audit'));
  if (!o.audit.length) list.append(el('li', { class: 'hint' }, 'No changes yet.'));
  for (const a of o.audit) list.append(el('li', {}, `${new Date(a.at).toLocaleString()} · ${a.actor}: ${a.action}`));
}

// ---------------------------------------------------------------- boot
async function load() {
  data = await adminApi('/api/admin/overview');
  clear($('admin-status'));
  $('whoami').textContent = `Signed in as ${data.me.email}`;
  renderSystem(data);
  renderBudget(data);
  renderNotice(data);
  renderAgents(data);
  renderQuality(data);
  renderAudit(data);
  await loadPlans();
}

$('notice-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('notice-text').value.trim();
  if (!text) return notice($('admin-status'), 'Write the message first.', 'error');
  const hours = Number($('notice-hours').value);
  saveSettings({ notice: { text, level: $('notice-level').value, until: hours ? new Date(Date.now() + hours * 3600_000).toISOString() : null } }, e.submitter);
});
$('notice-clear').addEventListener('click', (e) => saveSettings({ notice: null }, e.currentTarget));
$('refresh-btn').addEventListener('click', async (e) => {
  const done = busy(e.currentTarget, 'Refreshing…');
  try { await load(); } catch (err) { notice($('admin-status'), err.message, 'error'); } finally { done(); }
});
$('signout-btn').addEventListener('click', signOut);
$('signin-btn').addEventListener('click', signIn);

initThemeToggle($('theme-toggle'));
showVersion($('version'));

(async () => {
  try {
    config = await fetch('/admin-config.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null));
    if (!config?.clientId) {
      notice($('admin-status'), 'The admin console is not configured on this deployment.', 'error');
      return;
    }
    const params = new URLSearchParams(location.search);
    if (params.get('error')) {
      history.replaceState(null, '', '/admin.html');
      showSignIn(`Sign-in failed: ${params.get('error_description') ?? params.get('error')}`);
      return;
    }
    if (params.get('code')) await completeSignIn(params);
    session = session ?? storedSession();
    if (!session) {
      showSignIn();
      return;
    }
    $('signin').hidden = true;
    $('console').hidden = false;
    notice($('admin-status'), 'Loading…', 'ok');
    await load();
    setInterval(() => { if (!document.hidden && session) load().catch(() => {}); }, 60_000);
  } catch (err) {
    showSignIn(err.message);
  }
})();
