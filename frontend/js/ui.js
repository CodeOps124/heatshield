// Shared UI: a tiny DOM builder (text is ALWAYS set via textContent — API data is untrusted),
// icons, tier badges, and the risk / guidance / outlook renderers used by every page.

export const TIER_LABELS = {
  lower: 'Lower risk',
  caution: 'Caution',
  extreme_caution: 'Extreme caution',
  danger: 'Danger',
  extreme_danger: 'Extreme danger',
};

export const TIER_MEANING = {
  lower: 'Heat is not expected to be a problem right now.',
  caution: 'Fatigue is possible with long exposure or physical activity.',
  extreme_caution: 'Heat cramps or heat exhaustion are possible with long exposure or activity.',
  danger: 'Heat cramps or heat exhaustion are likely; heat stroke is possible.',
  extreme_danger: 'Heat stroke is highly likely with continued exposure.',
};

export const PROFILES = {
  outdoor_worker: { label: 'Outdoor worker', icon: 'hardhat', alertTier: 'extreme_caution' },
  elderly: { label: 'Older adult (65+)', icon: 'elder', alertTier: 'caution' },
  chronic_condition: { label: 'Chronic condition', icon: 'heart', alertTier: 'caution' },
  child: { label: 'Young child', icon: 'child', alertTier: 'caution' },
  pregnant: { label: 'Pregnant', icon: 'pregnant', alertTier: 'caution' },
  general: { label: 'General public', icon: 'user', alertTier: 'extreme_caution' },
};

export const LANGUAGES = {
  en: { native: 'English', dir: 'ltr' },
  es: { native: 'Español', dir: 'ltr' },
  fr: { native: 'Français', dir: 'ltr' },
  pt: { native: 'Português', dir: 'ltr' },
  ar: { native: 'العربية', dir: 'rtl' },
  ur: { native: 'اردو', dir: 'rtl' },
  hi: { native: 'हिन्दी', dir: 'ltr' },
  bn: { native: 'বাংলা', dir: 'ltr' },
  zh: { native: '简体中文', dir: 'ltr' },
  vi: { native: 'Tiếng Việt', dir: 'ltr' },
  id: { native: 'Bahasa Indonesia', dir: 'ltr' },
  tl: { native: 'Tagalog', dir: 'ltr' },
  sw: { native: 'Kiswahili', dir: 'ltr' },
};

export const MODEL_NAMES = [
  [/claude-haiku-4-5/, 'Claude Haiku 4.5'],
  [/nova-2-lite/, 'Amazon Nova 2 Lite'],
  [/nova-lite/, 'Amazon Nova Lite'],
  [/nova-micro/, 'Amazon Nova Micro'],
  [/nova-pro/, 'Amazon Nova Pro'],
];
export const modelName = (id) => MODEL_NAMES.find(([re]) => re.test(id ?? ''))?.[1] ?? id;

// ---------------------------------------------------------------- DOM builder
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * el('div', { class: 'x', onclick: fn }, 'text', childNode, [more])
 * Strings become text nodes — never HTML.
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  append(node, children);
  return node;
}

export function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, String(v));
  append(node, children);
  return node;
}

function append(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const clear = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
};

// ---------------------------------------------------------------- icons (original, 24px stroke)
const ICONS = {
  shield: [['path', { d: 'M12 2.5l8 3v6.2c0 4.9-3.4 8.6-8 9.8-4.6-1.2-8-4.9-8-9.8V5.5z' }], ['path', { d: 'M12 7.5v6' }], ['circle', { cx: 12, cy: 15.6, r: 1.6 }]],
  sun: [['circle', { cx: 12, cy: 12, r: 4 }], ['path', { d: 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4' }]],
  moon: [['path', { d: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z' }]],
  pin: [['path', { d: 'M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z' }], ['circle', { cx: 12, cy: 9.5, r: 2.5 }]],
  locate: [['circle', { cx: 12, cy: 12, r: 7 }], ['circle', { cx: 12, cy: 12, r: 2 }], ['path', { d: 'M12 2v3M12 19v3M2 12h3M19 12h3' }]],
  check: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M8 12.5l2.7 2.7L16 9.8' }]],
  triangle: [['path', { d: 'M12 3.5L2.5 20h19z' }], ['path', { d: 'M12 10v4.5M12 17.3v.2' }]],
  triangleFilled: [['path', { d: 'M12 3.5L2.5 20h19z', fill: 'currentColor' }], ['path', { d: 'M12 10v4.5M12 17.3v.2', class: 'knock' }]],
  octagon: [['path', { d: 'M8.2 2.5h7.6l5.7 5.7v7.6l-5.7 5.7H8.2l-5.7-5.7V8.2z' }], ['path', { d: 'M12 7.5v6M12 16.3v.2' }]],
  octagonDouble: [['path', { d: 'M8.2 2.5h7.6l5.7 5.7v7.6l-5.7 5.7H8.2l-5.7-5.7V8.2z' }], ['path', { d: 'M9.6 7.5v6M9.6 16.3v.2M14.4 7.5v6M14.4 16.3v.2' }]],
  sparkle: [['path', { d: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z' }], ['path', { d: 'M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z' }]],
  database: [['ellipse', { cx: 12, cy: 6, rx: 7, ry: 3 }], ['path', { d: 'M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3' }]],
  book: [['path', { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z' }], ['path', { d: 'M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5' }]],
  clock: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 7v5l3 2' }]],
  mail: [['rect', { x: 3, y: 5, width: 18, height: 14, rx: 2 }], ['path', { d: 'M3.5 6.5l8.5 6 8.5-6' }]],
  users: [['circle', { cx: 9, cy: 8, r: 3.5 }], ['path', { d: 'M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.3c2 .7 3.5 2.6 3.5 5.7' }]],
  user: [['circle', { cx: 12, cy: 8, r: 4 }], ['path', { d: 'M4.5 21c0-4.1 3.4-7 7.5-7s7.5 2.9 7.5 7' }]],
  hardhat: [['path', { d: 'M3 17h18v3H3zM5 17v-2.5a7 7 0 0 1 14 0V17M10 8V5h4v3' }]],
  heart: [['path', { d: 'M20.8 8.6a5 5 0 0 0-8.8-3.1 5 5 0 0 0-8.8 3.1c0 5.5 8.8 11.4 8.8 11.4s8.8-5.9 8.8-11.4z' }], ['path', { d: 'M7 12h2.5l1.5-2.5 2 5 1.5-2.5H17' }]],
  child: [['circle', { cx: 12, cy: 6.5, r: 3.5 }], ['path', { d: 'M7.5 21l1.5-8h6l1.5 8M9 14l-3-2.5M15 14l3-2.5' }]],
  elder: [['circle', { cx: 10, cy: 4.8, r: 2.3 }], ['path', { d: 'M10 8.5v6l-2.5 6.5M10 14.5l2.8 6.5M10 10.5l4 2M17 12.5V21M15.5 12.5H17' }]],
  pregnant: [['circle', { cx: 11, cy: 4.8, r: 2.3 }], ['path', { d: 'M10.5 8.5c-1.3 2.5-1 5 0 6.5M10.5 8.5c3.2.8 5.2 3.4 4.4 5.8-.4 1.3-1.9 1.9-3.9 1.9M10.5 15v6M13 16.2V21' }]],
  copy: [['rect', { x: 9, y: 9, width: 11, height: 11, rx: 2 }], ['path', { d: 'M5 15V5a2 2 0 0 1 2-2h8' }]],
  trash: [['path', { d: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13' }]],
  arrow: [['path', { d: 'M5 12h14M13 6l6 6-6 6' }]],
  info: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 11v6M12 7.3v.2' }]],
  phone: [['path', { d: 'M5 3.5h3.5l1.8 4.5-2.3 1.5a11 11 0 0 0 6.5 6.5l1.5-2.3 4.5 1.8V19a2 2 0 0 1-2 2A16.5 16.5 0 0 1 3 5.5a2 2 0 0 1 2-2z' }]],
  refresh: [['path', { d: 'M20 11a8 8 0 0 0-14.3-4.9L4 8M4 3v5h5M4 13a8 8 0 0 0 14.3 4.9L20 16M20 21v-5h-5' }]],
};

export function icon(name, extra = {}) {
  const svg = svgEl('svg', {
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', ...extra,
  });
  for (const [tag, attrs] of ICONS[name] ?? []) svg.append(svgEl(tag, attrs));
  return svg;
}

const TIER_ICON = {
  lower: 'check', caution: 'triangle', extreme_caution: 'triangleFilled', danger: 'octagon', extreme_danger: 'octagonDouble',
};

export function tierBadge(tier, { large = false } = {}) {
  return el('span', { class: `tier ${tier}${large ? ' lg' : ''}` }, icon(TIER_ICON[tier] ?? 'info'), TIER_LABELS[tier] ?? tier);
}

// ---------------------------------------------------------------- formatting
export const cToF = (c) => (c * 9) / 5 + 32;
export const fmtC = (c) => `${Math.round(c)} °C`;
export const fmtF = (c) => `${Math.round(cToF(c))} °F`;
export const fmtBoth = (c) => `${fmtC(c)} (${fmtF(c)})`;
export const hhmm = (iso) => iso.slice(11, 16);

export function dayName(dateStr, todayStr) {
  if (dateStr === todayStr) return 'Today';
  const d = new Date(`${dateStr}T12:00:00Z`);
  const t = new Date(`${todayStr}T12:00:00Z`);
  if ((d - t) / 86400000 === 1) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' });
}

// ---------------------------------------------------------------- theme toggle
export function initThemeToggle(button) {
  if (!button) return;
  const root = document.documentElement;
  const isDark = () =>
    root.dataset.theme === 'dark' || (!root.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const paint = () => {
    clear(button).append(icon(isDark() ? 'sun' : 'moon'));
    button.setAttribute('aria-label', isDark() ? 'Switch to light theme' : 'Switch to dark theme');
  };
  button.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      localStorage.setItem('heatshield-theme', next);
    } catch {
      /* storage unavailable — theme still applies for this visit */
    }
    paint();
    window.dispatchEvent(new Event('heatshield:theme'));
  });
  paint();
}

// ---------------------------------------------------------------- version marker (ship-gate)
export async function showVersion(node) {
  if (!node) return;
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const v = await res.json();
    node.textContent = `Build ${v.version} · deployed ${new Date(v.builtAt).toUTCString()}`;
  } catch {
    /* optional */
  }
}

// ---------------------------------------------------------------- risk summary
export function renderRiskSummary(container, { risk, placeName }) {
  const c = risk.current;
  const alertLabel = TIER_LABELS[risk.profile.alertTier].toLowerCase();
  const heroValue = c.heatIndexApplies ? c.heatIndexC : c.tempC;

  const trendText = risk.trend.rising
    ? `Rising to ${TIER_LABELS[risk.trend.next6hMaxTier]} within ${risk.trend.hoursUntilRise} h`
    : 'Not rising in the next 6 hours';

  const windowCallout = risk.riskWindow
    ? el('div', { class: 'callout alert' }, icon('clock'),
      el('p', {},
        el('strong', {}, `Your risky hours: ${risk.riskWindow.label}`),
        `Your profile is warned from ${alertLabel} upward. Plan work, errands and exercise outside this window.`))
    : el('div', { class: 'callout info' }, icon('info'),
      el('p', {},
        el('strong', {}, 'No risky hours in the next 24 hours for your profile'),
        `You would be warned from ${alertLabel} upward. We keep checking the forecast every hour.`));

  clear(container).append(
    el('div', { class: 'result-head' },
      el('div', {},
        el('p', { class: 'place-title' }, placeName),
        el('p', { class: 'place-meta' }, `Local time ${hhmm(risk.localTime)} · ${risk.timezone} · profile: ${risk.profile.label}`)),
      tierBadge(c.tier, { large: true })),
    el('div', { class: 'hero-figure' },
      el('span', { class: 'value' }, `${Math.round(heroValue)}°`),
      el('span', { class: 'unit' }, `C · ${Math.round(cToF(heroValue))} °F`)),
    el('p', { class: 'hero-caption' },
      c.heatIndexApplies
        ? `Heat index now: how hot it feels in the shade, combining ${Math.round(c.tempC)} °C air and ${c.rh}% humidity. ${TIER_MEANING[c.tier]}`
        : `Air temperature now (${c.rh}% humidity). The heat index only applies from 27 °C / 80 °F. ${TIER_MEANING[c.tier]}`),
    el('div', { class: 'stats' },
      stat('Trend', risk.trend.rising ? 'Rising' : 'Steady', trendText),
      stat(`Peak ${risk.peak24h.isTomorrow ? 'tomorrow' : 'today'}`, fmtC(risk.peak24h.heatIndexC), `around ${risk.peak24h.label} · ${TIER_LABELS[risk.peak24h.tier]}`),
      stat('Tonight', risk.night.lowC === null ? '—' : fmtC(risk.night.lowC), risk.night.tropicalNight ? 'Stays above 20 °C: little relief' : 'Cools down overnight'),
      stat('UV today', risk.uvMaxToday === null ? '—' : String(Math.round(risk.uvMaxToday)), uvWord(risk.uvMaxToday))),
    el('div', { class: 'mt-16' }, windowCallout),
  );
}

function stat(label, value, sub) {
  return el('div', { class: 'stat' }, el('p', { class: 'label' }, label), el('div', { class: 'value' }, value), el('div', { class: 'sub' }, sub));
}

function uvWord(uv) {
  if (uv === null || uv === undefined) return 'Not available';
  if (uv < 3) return 'Low';
  if (uv < 6) return 'Moderate';
  if (uv < 8) return 'High: shade and cover up';
  if (uv < 11) return 'Very high: avoid midday sun';
  return 'Extreme: avoid midday sun';
}

// ---------------------------------------------------------------- guidance
export function renderGuidanceLoading(container, langCode) {
  clear(container).append(
    el('p', { class: 'loading-text', role: 'status' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }),
      `Writing your action plan in ${LANGUAGES[langCode]?.native ?? langCode} with Amazon Bedrock…`),
    el('div', { class: 'skeleton w90' }), el('div', { class: 'skeleton w80' }), el('div', { class: 'skeleton w60' }),
  );
}

export function renderGuidance(container, g) {
  const lang = LANGUAGES[g.language] ?? LANGUAGES.en;
  const body = el('div', { lang: g.language, dir: lang.dir },
    el('p', { class: 'guidance-headline' }, g.headline),
    el('ol', { class: 'guidance-actions' }, g.actions.map((a) => el('li', {}, el('span', {}, a)))),
    el('div', { class: 'callout alert' }, icon('phone'), el('p', {}, g.seekHelp)));

  const source =
    g.source === 'bedrock'
      ? el('span', {}, icon('sparkle'), `Generated just now by ${modelName(g.model)} on Amazon Bedrock`)
      : g.source === 'cache'
        ? el('span', {}, icon('database'), `Generated by ${modelName(g.model)} on Amazon Bedrock · served from cache (same conditions, same advice)`)
        : el('span', {}, icon('book'), 'Pre-written safety guidance (AI guidance is temporarily unavailable)');

  clear(container).append(
    body,
    g.languageFallback ? el('p', { class: 'notice' }, 'Guidance in your language is temporarily unavailable, so it is shown in English.') : null,
    el('div', { class: 'provenance' }, source,
      el('span', {}, icon('info'), 'Based on CDC/NIOSH heat guidance. Not a substitute for medical care.')),
  );
}

// ---------------------------------------------------------------- outlook
export function renderOutlook(container, risk) {
  const today = risk.localTime.slice(0, 10);
  clear(container).append(
    el('div', { class: 'outlook' },
      risk.outlook.map((d) =>
        el('div', { class: 'day' },
          el('div', { class: 'd' }, dayName(d.date, today)),
          el('div', { class: 'v' }, fmtC(d.maxHeatIndexC)),
          tierBadge(d.tier)))),
  );
}

// ---------------------------------------------------------------- misc
export function notice(container, message, kind = 'error') {
  clear(container).append(el('p', { class: `notice ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message));
}

export async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const old = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = old; }, 1600);
  } catch {
    window.prompt('Copy this link:', text);
  }
}

export function linkBox(label, url, id) {
  const input = el('input', { type: 'text', readonly: true, value: url, id, 'aria-label': label });
  const btn = el('button', { type: 'button', class: 'btn secondary small' }, 'Copy');
  btn.addEventListener('click', () => copyText(url, btn));
  input.addEventListener('focus', () => input.select());
  return el('div', {}, el('label', { for: id }, label), el('div', { class: 'linkbox' }, input, btn));
}

/** Read "#a=1&b=2" into an object. Secrets live in the fragment: browsers never send it to servers. */
export const hashParams = () => Object.fromEntries(new URLSearchParams(window.location.hash.slice(1)));
