// Mounts the pixel office with crisp HTML overlays (name tags, speech bubbles, desk buttons) and
// keeps it in sync with the live agent log. Used by Agent HQ and the home-page teaser.
import { createOffice, OFFICE_W, OFFICE_H, SEATS } from './pixel-office.js';
import { el, clear } from './ui.js';

export const AGENT_META = {
  sol: { name: 'Sol', role: 'Heat Sentinel', color: '#eb6834' },
  mira: { name: 'Mira', role: 'Health Advisor', color: '#1baf7a' },
  lexi: { name: 'Lexi', role: 'Language Reviewer', color: '#7b5ea7' },
  vera: { name: 'Vera', role: 'Safety Reviewer', color: '#2f4b7c' },
  kai: { name: 'Kai', role: 'Community Coordinator', color: '#3a9d5d' },
  otto: { name: 'Otto', role: 'Ops Watchdog', color: '#3987e5' },
};

// Bubbles are speech, not reports: short and cut at a word. The activity feed has the full text.
function shortLine(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > n * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:(-]+$/, '')}…`;
}

// "(9 h ago)" on older runs, so a quiet agent never looks like it is doing old work right now.
function age(iso) {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(min) || min < 30) return '';
  return min < 90 ? `${min} min ago` : min < 36 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} d ago`;
}

export function mountOffice(root, { compact = false, onSelect = null } = {}) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canvas = el('canvas', { class: 'office-canvas', role: 'img', 'aria-label': 'Pixel-art office where HeatShield\'s six AI agents work' });
  const overlay = el('div', { class: 'office-overlay' });
  const stage = el('div', { class: `office-stage${compact ? ' compact' : ''}` }, canvas, overlay);
  clear(root).append(stage);
  const office = createOffice(canvas, { reducedMotion });
  const anchors = office.anchors();

  const bubbles = {};
  const tags = {};
  const timers = {};
  let scale = 1;
  for (const [id, meta] of Object.entries(AGENT_META)) {
    const a = anchors[id];
    // Bubbles and tags repeat what the feed and the desk buttons already say, so screen readers skip them.
    const bubble = el('div', { class: 'office-bubble', hidden: true, 'aria-hidden': 'true' }, el('span', { class: 'office-bubble-text' }));
    const tag = el('div', { class: 'office-tag', 'aria-hidden': 'true' }, el('strong', {}, meta.name), compact ? null : el('span', { class: 'office-tag-role' }, meta.role));
    const button = el('button', { type: 'button', class: 'office-desk', 'aria-label': `${meta.name}, ${meta.role}` });
    if (onSelect) button.addEventListener('click', () => onSelect(id));
    else button.tabIndex = -1;
    overlay.append(button, tag, bubble);
    // Office pixels. A bubble's bottom edge sits just above the speaker's head (head top = desk top - 21).
    Object.assign(bubble.dataset, { ax: a.x, ay: a.top - 22 });
    Object.assign(tag.dataset, { x: a.x, y: a.top + 11 });
    Object.assign(button.dataset, { x: a.x - 34, y: a.top - 28, w: 68, h: 50 });
    bubbles[id] = bubble;
    tags[id] = tag;
  }

  // Keeps the whole bubble inside the office; the tail still points at the speaker.
  function place(b) {
    const x = Number(b.dataset.ax) * scale;
    const w = b.offsetWidth;
    const left = Math.min(Math.max(4, x - w / 2), OFFICE_W * scale - w - 4);
    b.style.left = `${left}px`;
    b.style.top = `${Number(b.dataset.ay) * scale}px`;
    b.style.setProperty('--tail', `${Math.round(x - left)}px`);
  }

  function layout() {
    const width = stage.parentElement?.clientWidth || OFFICE_W;
    // Integer scaling keeps pixels crisp; small screens fall back to fitting the width.
    scale = width >= OFFICE_W * 2 ? Math.min(4, Math.floor(width / OFFICE_W)) : width / OFFICE_W;
    stage.style.width = `${OFFICE_W * scale}px`;
    stage.style.height = `${OFFICE_H * scale}px`;
    stage.style.setProperty('--scale', String(scale));
    stage.classList.toggle('narrow', scale < 2);
    for (const node of overlay.children) {
      const d = node.dataset;
      if (d.ax) { if (!node.hidden) place(node); continue; }
      node.style.left = `${Number(d.x) * scale}px`;
      node.style.top = `${Number(d.y) * scale}px`;
      if (d.w) { node.style.width = `${Number(d.w) * scale}px`; node.style.height = `${Number(d.h) * scale}px`; }
    }
  }
  layout();
  new ResizeObserver(layout).observe(root);

  const maxChars = () => (compact || scale < 2 ? 60 : 84);

  /** Shows a speech bubble; empty text hides it. ms = 0 keeps it until the next say(). */
  function say(id, text, kind = 'info', ms = 9000) {
    const b = bubbles[id];
    if (!b) return;
    clearTimeout(timers[id]);
    if (!text) { b.hidden = true; return; }
    b.className = `office-bubble ${kind}`;
    b.firstChild.textContent = shortLine(text, maxChars());
    b.hidden = false;
    place(b);
    if (ms) timers[id] = setTimeout(() => { b.hidden = true; }, ms);
  }

  // Ambient chatter: while nobody is talking, one agent at a time says what it last did.
  // Every line is a real run from the agent log.
  let latest = [];
  let turn = 0;
  let quietSince = 0;
  function chatter() {
    const a = latest[turn % latest.length];
    turn += 1;
    const when = age(a.lastRun.at);
    const line = when ? `${shortLine(a.lastRun.summary, maxChars() - when.length - 3)} (${when})` : a.lastRun.summary;
    say(a.id, line, a.lastRun.outcome === 'error' ? 'error' : 'info', 5200);
  }
  setInterval(() => {
    // Next speaker after a short pause; never over a visitor's task or a fresh run.
    if (document.hidden || !latest.length || Object.values(bubbles).some((b) => !b.hidden)) { quietSince = 0; return; }
    if (!quietSince) { quietSince = Date.now(); return; }
    if (Date.now() - quietSince >= 1200) { quietSince = 0; chatter(); }
  }, 400);

  // Tracks the newest run we have seen per agent, to animate genuinely new work.
  const seen = {};
  let firstSync = true;

  function sync(data) {
    for (const a of data.agents ?? []) {
      office.setBase(a.id, a.status === 'working' ? 'working' : a.status === 'error' ? 'error' : a.status === 'waiting' || a.status === 'paused' ? 'waiting' : 'idle');
      tags[a.id]?.classList.toggle('paused', a.status === 'paused');
      const at = a.lastRun?.at;
      if (at && seen[a.id] && at !== seen[a.id] && !firstSync) {
        // A run finished since the last poll: show the agent working, then what it did.
        office.setTemp(a.id, 'working', 3500);
        setTimeout(() => {
          say(a.id, a.lastRun.summary, a.lastRun.outcome === 'error' ? 'error' : 'done', 10000);
          if (a.lastRun.outcome !== 'error') office.celebrate(a.id);
        }, 3200);
      }
      if (at) seen[a.id] = at;
    }
    latest = (data.agents ?? []).filter((a) => a.lastRun?.summary);
    if (firstSync && latest.length) setTimeout(chatter, 700);
    firstSync = false;
    office.setBoard({
      areas: data.sentinel?.areas ?? [],
      events: data.sentinel?.events ?? [],
      status: data.watchdog?.status ?? 'unknown',
    });
  }

  return { office, say, sync, stage, SEATS };
}
