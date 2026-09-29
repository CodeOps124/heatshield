// Invite page: join a leader's group.
import { api } from './api.js';
import { notice, initThemeToggle, showVersion, hashParams, showSiteNotice } from './ui.js';
import { createPlaceSearch } from './place-search.js';
import { createRegisterForm } from './register-form.js';

const $ = (id) => document.getElementById(id);
const { g: groupId } = hashParams();
let place = null;

async function boot() {
  initThemeToggle($('theme-toggle'));
  showSiteNotice();
  showVersion($('version'));
  if (!groupId) {
    $('group-name').textContent = 'Invite link needed';
    notice($('status'), 'Open this page using the invite link your group leader shared.');
    return;
  }
  try {
    const group = await api(`/api/groups/${encodeURIComponent(groupId)}`);
    document.title = `Join ${group.name} · HeatShield`;
    $('group-name').textContent = group.name;
    if (group.readOnly) {
      notice($('status'), 'This is a read-only demo group, so it cannot take new members. Create your own group from the home page.', 'info');
      return;
    }
    $('join-card').hidden = false;
    createPlaceSearch($('place-search'), {
      label: 'Where are you during the day?',
      onSelect: (p) => { place = p; },
    });
    createRegisterForm($('register'), () => place, { groupId, groupName: group.name, submitLabel: 'Join the group' });
  } catch (err) {
    $('group-name').textContent = 'Invite link not valid';
    notice($('status'), err.message);
  }
}

boot();
