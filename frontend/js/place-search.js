// Accessible place search (WAI-ARIA combobox pattern) backed by /api/geocode, plus
// "use my location" via the browser Geolocation API. Calls onSelect({ lat, lon, placeName, countryCode }).
import { api, qs } from './api.js';
import { el, clear, icon } from './ui.js';

let uid = 0;

export function createPlaceSearch(root, { onSelect, label = 'Where?', autofocus = false } = {}) {
  uid += 1;
  const inputId = `place-${uid}`;
  const listId = `place-list-${uid}`;
  const input = el('input', {
    id: inputId, type: 'search', autocomplete: 'off', placeholder: 'Search a city or town, e.g. Karachi',
    role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId, autofocus,
  });
  const locate = el('button', { type: 'button', class: 'btn secondary', title: 'Use my current location' }, icon('locate'),
    el('span', { class: 'hide-xs' }, 'My location'));
  const list = el('ul', { id: listId, class: 'combo-list', role: 'listbox', hidden: true });
  const chosen = el('p', { class: 'selected-place', 'aria-live': 'polite' });
  const status = el('p', { class: 'hint', 'aria-live': 'polite' });

  clear(root).append(
    el('label', { for: inputId }, label),
    el('div', { class: 'combo' }, el('div', { class: 'combo-row' }, input, locate), list),
    chosen,
    status,
  );

  let results = [];
  let activeIndex = -1;
  let timer = null;
  let controller = null;

  const describe = (r) => [r.admin1, r.country].filter(Boolean).join(', ');

  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    activeIndex = -1;
  }

  function highlight(i) {
    activeIndex = i;
    [...list.children].forEach((li, j) => li.setAttribute('aria-selected', String(j === i)));
    if (i >= 0) input.setAttribute('aria-activedescendant', `${listId}-${i}`);
  }

  function pick(r) {
    const placeName = [r.name, r.country].filter(Boolean).join(', ');
    input.value = placeName;
    close();
    setChosen(placeName);
    onSelect({ lat: r.lat, lon: r.lon, placeName, countryCode: r.countryCode });
  }

  function setChosen(text) {
    clear(chosen).append(icon('pin'), text);
  }

  async function search(q) {
    controller?.abort();
    controller = new AbortController();
    status.textContent = '';
    try {
      const data = await api(`/api/geocode?${qs({ q })}`, { signal: controller.signal });
      results = data.results ?? [];
      clear(list);
      if (!results.length) {
        status.textContent = 'No places found. Try the nearest city, or use your location.';
        close();
        return;
      }
      results.forEach((r, i) => {
        const li = el('li', { id: `${listId}-${i}`, role: 'option', 'aria-selected': 'false' },
          r.name, el('small', {}, describe(r)));
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          pick(r);
        });
        list.append(li);
      });
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      highlight(0);
    } catch (err) {
      if (err.name !== 'AbortError') status.textContent = err.message;
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      close();
      return;
    }
    timer = setTimeout(() => search(q), 250);
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) {
      if (e.key === 'Enter' && input.value.trim().length >= 2) {
        e.preventDefault();
        search(input.value.trim());
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlight(Math.min(results.length - 1, activeIndex + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlight(Math.max(0, activeIndex - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[activeIndex]) pick(results[activeIndex]);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));

  locate.addEventListener('click', () => {
    if (!('geolocation' in navigator)) {
      status.textContent = 'Your browser cannot share location. Please search for your city instead.';
      return;
    }
    status.textContent = 'Finding your location…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = Math.round(pos.coords.latitude * 100) / 100;
        const lon = Math.round(pos.coords.longitude * 100) / 100;
        const placeName = `My location (${lat.toFixed(2)}, ${lon.toFixed(2)})`;
        status.textContent = 'Location found. It is rounded to about 1 km before it leaves your device.';
        input.value = '';
        setChosen(placeName);
        onSelect({ lat, lon, placeName, countryCode: null });
      },
      () => {
        status.textContent = 'Location permission was not given. Please search for your city instead.';
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
    );
  });

  return {
    setPlace(place) {
      input.value = place.placeName;
      setChosen(place.placeName);
    },
    focus: () => input.focus(),
  };
}
