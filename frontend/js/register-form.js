// Registration form shared by "Get alerts" (index) and "Join a group" (join.html).
import { api } from './api.js';
import { el, clear, notice, linkBox, PROFILES, LANGUAGES, icon } from './ui.js';

export function profileChips(name, selected = 'general', onChange) {
  const fs = el('fieldset', { class: 'chips' }, el('legend', { class: 'label' }, 'Who is this for?'));
  for (const [id, p] of Object.entries(PROFILES)) {
    const input = el('input', { type: 'radio', name, value: id, checked: id === selected });
    if (onChange) input.addEventListener('change', () => onChange(id));
    fs.append(el('label', { class: 'chip' }, input, el('span', {}, icon(p.icon), p.label)));
  }
  return fs;
}

export function languageSelect(id, selected = 'en', onChange) {
  const select = el('select', { id }, Object.entries(LANGUAGES).map(([code, l]) =>
    el('option', { value: code, selected: code === selected, lang: code }, l.native)));
  if (onChange) select.addEventListener('change', () => onChange(select.value));
  return select;
}

/**
 * @param {HTMLElement} root
 * @param {() => ({lat, lon, placeName, countryCode} | null)} getPlace
 * @param {object} opts  { groupId, groupName, profile, language, submitLabel }
 */
export function createRegisterForm(root, getPlace, opts = {}) {
  const name = el('input', { id: 'reg-name', type: 'text', maxlength: 40, autocomplete: 'nickname', required: true });
  const email = el('input', { id: 'reg-email', type: 'email', maxlength: 254, autocomplete: 'email', inputmode: 'email' });
  const consent = el('input', { id: 'reg-consent', type: 'checkbox', required: true });
  const profile = profileChips('reg-profile', opts.profile ?? 'general');
  const language = languageSelect('reg-lang', opts.language ?? 'en');
  const submit = el('button', { type: 'submit', class: 'btn' }, opts.submitLabel ?? 'Turn on heat alerts');
  const out = el('div', { 'aria-live': 'polite' });

  const form = el('form', { class: 'stack', novalidate: true },
    el('div', { class: 'form-grid cols-2' },
      el('div', {}, el('label', { for: 'reg-name' }, 'Name or nickname ', el('span', { class: 'hint' }, '(shown to your group leader, if any)')), name),
      el('div', {}, el('label', { for: 'reg-lang' }, 'Language for guidance and alerts'), language)),
    profile,
    el('div', {}, el('label', { for: 'reg-email' }, 'Email for alerts ', el('span', { class: 'hint' }, '(optional)')), email,
      el('p', { class: 'hint' }, 'AWS will email you once to confirm. We never store your address: it lives only in the Amazon SNS subscription, and every alert has an unsubscribe link.')),
    el('label', { class: 'check', for: 'reg-consent' }, consent,
      el('span', {}, 'I agree that HeatShield stores this name, my approximate location (rounded to about 1 km), profile and language to send heat warnings. I can delete it at any time.')),
    el('div', { class: 'row' }, submit),
    out);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const place = getPlace();
    if (!place) return notice(out, 'Choose a place first.');
    if (!name.value.trim()) {
      name.focus();
      return notice(out, 'Please add a name or nickname.');
    }
    if (!consent.checked) {
      consent.focus();
      return notice(out, 'Please tick the consent box so we can store your registration.');
    }
    submit.disabled = true;
    try {
      const body = {
        name: name.value,
        placeName: place.placeName,
        countryCode: place.countryCode ?? undefined,
        lat: place.lat,
        lon: place.lon,
        profile: form.querySelector('input[name="reg-profile"]:checked')?.value ?? 'general',
        language: language.value,
        email: email.value.trim() || undefined,
        groupId: opts.groupId,
      };
      const res = await api('/api/locations', { method: 'POST', body });
      const personal = `${location.origin}/me.html#id=${encodeURIComponent(res.locationId)}&t=${encodeURIComponent(res.manageToken)}`;
      form.hidden = true;
      clear(root).append(
        el('div', { class: 'notice ok', role: 'status' },
          el('strong', {}, opts.groupName ? `You joined ${opts.groupName}.` : 'You are registered.'), ' ',
          res.emailConfirmationSent
            ? 'Check your inbox for an email from "HeatShield" (sent by AWS Notifications) and click "Confirm subscription". Nothing is sent until you confirm.'
            : 'We will check the forecast for you every hour.'),
        el('div', { class: 'mt-16' }, linkBox('Your private HeatShield link: save it. It is the only way to see or delete your registration.', personal, 'personal-link')),
        el('p', { class: 'mt-16' }, el('a', { href: personal }, 'Open my HeatShield page')),
      );
    } catch (err) {
      notice(out, err.message);
    } finally {
      submit.disabled = false;
    }
  });

  clear(root).append(form);
}
