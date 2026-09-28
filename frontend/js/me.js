// Personal page: my live risk, my action plan, my registration, and "delete my data".
import { api, qs } from './api.js';
import {
  el, clear, notice, initThemeToggle, showVersion, hashParams, renderRiskSummary, renderGuidance, renderGuidanceLoading,
  PROFILES, LANGUAGES, TIER_LABELS,
} from './ui.js';
import { renderHeatChart } from './chart.js';

const $ = (id) => document.getElementById(id);
const { id, t: token } = hashParams();

const EMAIL_STATUS = {
  none: 'Off (no email given)',
  pending: 'Waiting for you to confirm: check your inbox for the AWS Notifications email',
  confirmed: 'On',
  unknown: 'Unknown right now',
};

function detailRow(label, value) {
  return el('tr', {}, el('th', { scope: 'row' }, label), el('td', {}, value));
}

async function boot() {
  initThemeToggle($('theme-toggle'));
  showVersion($('version'));
  if (!id || !token) {
    notice($('status'), 'Open this page with the private link you saved when you registered.');
    return;
  }
  const headers = { 'x-manage-token': token };
  let data;
  try {
    data = await api(`/api/locations/${encodeURIComponent(id)}`, { headers });
  } catch (err) {
    notice($('status'), err.message);
    return;
  }
  const loc = data.location;
  $('title').textContent = `Hi ${loc.name}`;
  $('content').hidden = false;

  const del = el('button', { type: 'button', class: 'btn danger' }, 'Delete my data');
  del.addEventListener('click', async () => {
    if (!window.confirm('Delete your HeatShield registration? This removes your details, your alert history and your email subscription. It cannot be undone.')) return;
    del.disabled = true;
    try {
      await api(`/api/locations/${encodeURIComponent(id)}`, { method: 'DELETE', headers });
      $('content').hidden = true;
      $('title').textContent = 'Your data has been deleted';
      notice($('status'), 'Your registration, alert history and email subscription have been removed.', 'ok');
    } catch (err) {
      del.disabled = false;
      window.alert(err.message);
    }
  });

  const last = data.lastAlert;
  clear($('details')).append(
    el('h2', {}, 'My registration'),
    el('table', { class: 'data-table' }, el('tbody', {},
      detailRow('Place', loc.placeName),
      detailRow('Profile', `${PROFILES[loc.profile]?.label ?? loc.profile} (alerts from ${TIER_LABELS[PROFILES[loc.profile]?.alertTier] ?? '—'})`),
      detailRow('Language', LANGUAGES[loc.language]?.native ?? loc.language),
      detailRow('Group', loc.group ? loc.group.name : 'None'),
      detailRow('Email alerts', EMAIL_STATUS[loc.emailStatus] ?? loc.emailStatus),
      detailRow('Last alert', last ? `${TIER_LABELS[last.tier]} on ${last.date}` : 'None yet'))),
    el('p', { class: 'hint mt-16' }, 'We store only your name, your location rounded to about 1 km, your profile and language. Your email address stays inside Amazon SNS.'),
    del,
  );

  const q = qs({ lat: loc.lat, lon: loc.lon, profile: loc.profile });
  api(`/api/risk?${q}`)
    .then(({ risk }) => {
      renderRiskSummary($('risk-card'), { risk, placeName: loc.placeName });
      renderHeatChart($('chart'), risk.hourly);
    })
    .catch((err) => notice($('risk-card'), err.message));

  renderGuidanceLoading($('guidance'), loc.language);
  api(`/api/guidance?${q}&${qs({ lang: loc.language })}`)
    .then(({ guidance }) => renderGuidance($('guidance'), guidance))
    .catch((err) => notice($('guidance'), err.message));
}

boot();
