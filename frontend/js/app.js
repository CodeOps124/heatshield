// Home page: check risk -> live assessment + Bedrock action plan -> optional alerts; create a group.
import { api, qs } from './api.js';
import {
  el, clear, notice, initThemeToggle, showVersion, renderRiskSummary, renderGuidance, renderGuidanceLoading,
  renderOutlook, linkBox, PROFILES, LANGUAGES,
} from './ui.js';
import { renderHeatChart } from './chart.js';
import { createPlaceSearch } from './place-search.js';
import { profileChips, languageSelect, createRegisterForm } from './register-form.js';

// Live examples: real hot places, each shown with a different profile and language.
const EXAMPLES = [
  { label: 'Karachi · Urdu', placeName: 'Karachi, Pakistan', countryCode: 'PK', lat: 24.86, lon: 67.01, profile: 'outdoor_worker', lang: 'ur' },
  { label: 'Dubai · Arabic', placeName: 'Dubai, United Arab Emirates', countryCode: 'AE', lat: 25.2, lon: 55.27, profile: 'outdoor_worker', lang: 'ar' },
  { label: 'Delhi · Hindi', placeName: 'New Delhi, India', countryCode: 'IN', lat: 28.61, lon: 77.21, profile: 'elderly', lang: 'hi' },
  { label: 'Cuiabá · Portuguese', placeName: 'Cuiabá, Brazil', countryCode: 'BR', lat: -15.6, lon: -56.1, profile: 'elderly', lang: 'pt' },
  { label: 'Phoenix · Spanish', placeName: 'Phoenix, United States', countryCode: 'US', lat: 33.45, lon: -112.07, profile: 'outdoor_worker', lang: 'es' },
  { label: 'Lagos · English', placeName: 'Lagos, Nigeria', countryCode: 'NG', lat: 6.45, lon: 3.39, profile: 'child', lang: 'en' },
];

const state = { place: null, profile: 'general', lang: 'en' };
let riskController = null;
let guidanceController = null;

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- form controls
const search = createPlaceSearch($('place-search'), {
  label: 'Where are you, or the person you care about?',
  onSelect: (place) => {
    state.place = place;
    runCheck();
  },
});

$('check-profile').append(profileChips('check-profile', state.profile, (p) => {
  state.profile = p;
  if (state.place) runCheck();
}));

const checkLang = languageSelect('check-lang', state.lang, (l) => setLanguage(l));
const guidanceLang = languageSelect('guidance-lang', state.lang, (l) => setLanguage(l));
$('check-lang-slot').append(checkLang);
$('guidance-lang-slot').append(guidanceLang);

function setLanguage(lang) {
  state.lang = lang;
  checkLang.value = lang;
  guidanceLang.value = lang;
  if (state.place) {
    updateUrl();
    loadGuidance();
  }
}

$('check-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!state.place) {
    notice($('check-error'), 'Search for a place (or use your location) first.');
    search.focus();
    return;
  }
  runCheck();
});

for (const ex of EXAMPLES) {
  const b = el('button', { type: 'button' }, ex.label);
  b.addEventListener('click', () => applyExample(ex));
  $('try-row').append(b);
}

function applyExample(ex) {
  state.place = { lat: ex.lat, lon: ex.lon, placeName: ex.placeName, countryCode: ex.countryCode };
  state.profile = ex.profile;
  document.querySelector(`input[name="check-profile"][value="${ex.profile}"]`).checked = true;
  search.setPlace(state.place);
  setLanguage(ex.lang);
  runCheck();
}

// ---------------------------------------------------------------- check flow
function updateUrl() {
  const p = state.place;
  const query = qs({ place: p.placeName, lat: p.lat, lon: p.lon, cc: p.countryCode, profile: state.profile, lang: state.lang });
  history.replaceState(null, '', `?${query}#check`);
}

async function runCheck() {
  clear($('check-error'));
  updateUrl();
  const result = $('result');
  const firstShow = result.hidden;
  result.hidden = false;

  const riskCard = $('risk-card');
  if (firstShow) {
    clear(riskCard).append(el('p', { class: 'loading-text' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Reading the live forecast…'));
  } else {
    riskCard.classList.add('is-stale');
  }
  loadGuidance();
  if (firstShow) {
    // Built once, so re-checking another place or profile never wipes what someone typed.
    createRegisterForm($('register'), () => state.place, { profile: state.profile, language: state.lang });
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  riskController?.abort();
  riskController = new AbortController();
  try {
    const { risk } = await api(`/api/risk?${qs({ lat: state.place.lat, lon: state.place.lon, profile: state.profile })}`, { signal: riskController.signal });
    riskCard.classList.remove('is-stale');
    renderRiskSummary(riskCard, { risk, placeName: state.place.placeName });
    renderHeatChart($('chart'), risk.hourly);
    renderOutlook($('outlook'), risk);
  } catch (err) {
    if (err.name === 'AbortError') return;
    riskCard.classList.remove('is-stale');
    notice(riskCard, err.message);
  }
}

async function loadGuidance() {
  const box = $('guidance');
  renderGuidanceLoading(box, state.lang);
  guidanceController?.abort();
  guidanceController = new AbortController();
  try {
    const { guidance } = await api(`/api/guidance?${qs({ lat: state.place.lat, lon: state.place.lon, profile: state.profile, lang: state.lang })}`, { signal: guidanceController.signal });
    renderGuidance(box, guidance);
  } catch (err) {
    if (err.name !== 'AbortError') notice(box, err.message);
  }
}

// ---------------------------------------------------------------- groups
$('group-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('group-result');
  const name = $('group-name').value.trim();
  if (!name) return notice(out, 'Give your group a name.');
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const g = await api('/api/groups', { method: 'POST', body: { name } });
    const invite = `${location.origin}/join.html#g=${encodeURIComponent(g.groupId)}`;
    const dashboard = `${location.origin}/group.html#g=${encodeURIComponent(g.groupId)}&k=${encodeURIComponent(g.adminKey)}`;
    e.target.hidden = true;
    clear(out).append(
      el('p', { class: 'notice ok', role: 'status' }, el('strong', {}, `“${g.name}” is ready.`), ' Share the invite link with your group. Keep the dashboard link to yourself: it is shown only once and cannot be recovered.'),
      el('div', { class: 'stack mt-16' },
        linkBox('Invite link (share this)', invite, 'invite-link'),
        linkBox('Your private dashboard link (keep this)', dashboard, 'dashboard-link')),
      el('p', { class: 'mt-16' }, el('a', { class: 'btn', href: dashboard }, 'Open my dashboard')),
    );
  } catch (err) {
    notice(out, err.message);
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------- boot
initThemeToggle($('theme-toggle'));
showVersion($('version'));
fetch('/demo.json', { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => { if (d?.dashboardPath) $('demo-link').href = d.dashboardPath; })
  .catch(() => {});

// Deep links: /?place=Karachi,%20Pakistan&lat=24.86&lon=67.01&profile=outdoor_worker&lang=ur
const params = new URLSearchParams(location.search);
const lat = Number.parseFloat(params.get('lat'));
const lon = Number.parseFloat(params.get('lon'));
if (Number.isFinite(lat) && Number.isFinite(lon)) {
  const profile = params.get('profile');
  const lang = params.get('lang');
  if (profile && PROFILES[profile]) {
    state.profile = profile;
    document.querySelector(`input[name="check-profile"][value="${profile}"]`).checked = true;
  }
  if (lang && LANGUAGES[lang]) {
    state.lang = lang;
    checkLang.value = lang;
    guidanceLang.value = lang;
  }
  state.place = { lat, lon, placeName: params.get('place') || `${lat.toFixed(2)}, ${lon.toFixed(2)}`, countryCode: params.get('cc') };
  search.setPlace(state.place);
  runCheck();
}
