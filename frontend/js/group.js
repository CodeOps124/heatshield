// Community-leader dashboard: everyone in the group, worst risk first.
import { api } from './api.js';
import {
  el, clear, notice, tierBadge, initThemeToggle, showVersion, hashParams, linkBox, fmtC, hhmm, icon,
  TIER_LABELS, LANGUAGES,
} from './ui.js';

const TIER_ORDER = ['lower', 'caution', 'extreme_caution', 'danger', 'extreme_danger'];
const rank = (t) => TIER_ORDER.indexOf(t);
const $ = (id) => document.getElementById(id);
const { g: groupId, k: adminKey } = hashParams();

function stat(label, value, sub) {
  return el('div', { class: 'stat' }, el('p', { class: 'label' }, label), el('div', { class: 'value' }, value), sub ? el('div', { class: 'sub' }, sub) : null);
}

function alertCell(m) {
  const channel = m.hasEmailAlerts ? el('span', { class: 'pill' }, 'Email on') : el('span', { class: 'pill' }, 'Dashboard only');
  if (!m.lastAlert) return el('div', {}, channel, el('div', { class: 'member-sub' }, 'No alert yet'));
  const when = m.lastAlert.sentAt ? new Date(m.lastAlert.sentAt * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : m.lastAlert.date;
  const what = m.lastAlert.status === 'sent' ? 'Emailed' : m.lastAlert.status === 'dashboard_only' ? 'Flagged' : 'Sending';
  return el('div', {}, channel, el('div', { class: 'member-sub' }, `${what}: ${TIER_LABELS[m.lastAlert.tier]}, ${when}`));
}

function row(m, readOnly, reload) {
  const r = m.risk;
  const removeBtn = readOnly ? null : el('button', { type: 'button', class: 'btn danger small', 'aria-label': `Remove ${m.name}` }, icon('trash'));
  removeBtn?.addEventListener('click', async () => {
    if (!window.confirm(`Remove ${m.name} from this group? Their registration and alerts are deleted.`)) return;
    removeBtn.disabled = true;
    try {
      await api(`/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(m.locationId)}`, { method: 'DELETE', headers: { 'x-admin-key': adminKey } });
      reload();
    } catch (err) {
      removeBtn.disabled = false;
      window.alert(err.message);
    }
  });

  return el('tr', {},
    el('td', {},
      el('div', { class: 'member-name' }, m.name),
      el('div', { class: 'member-sub' }, `${m.profileLabel} · ${LANGUAGES[m.language]?.native ?? m.language}`),
      el('div', { class: 'member-sub' }, m.placeName)),
    r
      ? el('td', {}, tierBadge(r.tier), el('div', { class: 'member-sub' }, `${fmtC(r.heatIndexApplies ? r.heatIndexC : r.tempC)} at ${hhmm(r.localTime)} local`))
      : el('td', { colspan: 3 }, el('span', { class: 'member-sub' }, 'Forecast temporarily unavailable')),
    r
      ? el('td', {}, tierBadge(r.levelTier),
        el('div', { class: 'member-sub' }, r.riskWindow ? `Risky ${r.riskWindow.startLabel}–${r.riskWindow.endLabel}` : 'Below their alert level'),
        r.shouldAlert ? el('div', { class: 'member-sub' }, el('strong', {}, 'Needs attention')) : null)
      : null,
    r ? el('td', { class: 'num' }, fmtC(r.peak.heatIndexC), el('div', { class: 'member-sub' }, `${r.peak.label}${r.peak.isTomorrow ? ' tomorrow' : ''}`)) : null,
    el('td', {}, alertCell(m)),
    el('td', {}, removeBtn),
  );
}

async function load() {
  const status = $('status');
  if (!groupId || !adminKey) {
    $('group-name').textContent = 'Dashboard link needed';
    notice(status, 'Open this page with the private dashboard link you received when you created your group.');
    return;
  }
  $('dashboard').classList.add('is-stale');
  try {
    const data = await api(`/api/groups/${encodeURIComponent(groupId)}/dashboard`, { headers: { 'x-admin-key': adminKey } });
    clear(status);
    $('dashboard').hidden = false;
    $('dashboard').classList.remove('is-stale');
    const { group, summary, members } = data;
    document.title = `${group.name} · HeatShield`;
    $('group-name').textContent = group.name;
    $('eyebrow').textContent = group.readOnly ? 'Demo group dashboard (read-only, fictional members, live forecasts)' : 'Group dashboard';
    $('updated').textContent = `Updated ${new Date(data.generatedAt).toLocaleTimeString(undefined, { timeStyle: 'short' })}`;

    const worst = members.reduce((w, m) => (m.risk && rank(m.risk.tier) > rank(w) ? m.risk.tier : w), 'lower');
    clear($('summary')).append(
      stat('Members', String(summary.members)),
      stat('Need attention (next 12 h)', String(summary.needAttention), 'At or above their personal alert level'),
      el('div', { class: 'stat' }, el('p', { class: 'label' }, 'Worst right now'), el('div', { class: 'mt-6' }, tierBadge(worst, { large: true }))),
      stat('In Danger or worse now', String((summary.byTier.danger ?? 0) + (summary.byTier.extreme_danger ?? 0))),
    );

    const invite = $('invite-card');
    if (!group.readOnly) {
      invite.hidden = false;
      clear(invite).append(el('h2', {}, 'Invite people'),
        linkBox('Share this invite link (it lets people join, not see this dashboard)', `${location.origin}/join.html#g=${encodeURIComponent(group.groupId)}`, 'invite'));
    }

    const sorted = [...members].sort((a, b) =>
      rank(b.risk?.levelTier ?? 'lower') - rank(a.risk?.levelTier ?? 'lower') || rank(b.risk?.tier ?? 'lower') - rank(a.risk?.tier ?? 'lower'));
    const tbody = clear($('members').tBodies[0]);
    if (!sorted.length) tbody.append(el('tr', {}, el('td', { colspan: 6 }, 'No members yet. Share the invite link above.')));
    for (const m of sorted) tbody.append(row(m, group.readOnly, load));
  } catch (err) {
    $('dashboard').classList.remove('is-stale');
    if (err.status === 403) $('group-name').textContent = 'Dashboard link not valid';
    notice(status, err.message);
  }
}

initThemeToggle($('theme-toggle'));
showVersion($('version'));
$('refresh').addEventListener('click', load);
load();
setInterval(() => { if (document.visibilityState === 'visible') load(); }, 10 * 60 * 1000);
