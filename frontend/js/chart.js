// 24-hour heat-index chart: one series (2px line + 10% wash) over NWS tier bands.
// Interactive by default: crosshair + tooltip on pointer AND keyboard (←/→), with a table view
// so no value is gated behind hover.
import { el, svgEl, clear, tierBadge, TIER_LABELS, hhmm, fmtC, fmtF } from './ui.js';

// NWS heat index thresholds (80 / 90 / 103 / 125 °F) in °C.
const BANDS = [
  { tier: 'caution', from: 26.67, to: 32.22 },
  { tier: 'extreme_caution', from: 32.22, to: 39.44 },
  { tier: 'danger', from: 39.44, to: 51.67 },
  { tier: 'extreme_danger', from: 51.67, to: 100 },
];

function niceStep(range) {
  const raw = range / 4;
  for (const s of [1, 2, 5, 10, 20]) if (raw <= s) return s;
  return 50;
}

export function renderHeatChart(container, hourly, { title = 'Heat index for the next 24 hours' } = {}) {
  const points = hourly.filter((h) => Number.isFinite(h.heatIndexC));
  clear(container);
  if (points.length < 2) {
    container.append(el('p', { class: 'hint' }, 'Hourly forecast is not available for this place.'));
    return;
  }

  const today = points[0].time.slice(0, 10);
  const whenLabel = (t) => `${hhmm(t)}${t.slice(0, 10) === today ? '' : ' (tomorrow)'}`;
  const values = points.map((p) => p.heatIndexC);
  const peakIdx = values.indexOf(Math.max(...values));
  const live = el('p', { class: 'visually-hidden', 'aria-live': 'polite' });
  const tooltip = el('div', { class: 'chart-tooltip', role: 'presentation' });
  const wrap = el('div', {
    class: 'chart-wrap',
    tabindex: '0',
    role: 'group',
    'aria-label': `${title}. Peak ${fmtC(values[peakIdx])} at ${whenLabel(points[peakIdx].time)}. Use the left and right arrow keys to read each hour.`,
  });
  container.append(
    wrap,
    el('div', { class: 'chart-legend', 'aria-hidden': 'true' },
      el('span', {}, el('i', { class: 'line' }), 'Heat index (°C)'),
      el('span', {}, el('i', { class: 'caution' }), 'Caution'),
      el('span', {}, el('i', { class: 'extreme_caution' }), 'Extreme caution'),
      el('span', {}, el('i', { class: 'danger' }), 'Danger and above')),
    tableView(points, whenLabel),
    live,
  );

  let active = null;

  function draw() {
    const W = Math.max(300, Math.round(wrap.clientWidth || container.clientWidth || 600));
    const H = 250;
    const m = { top: 26, right: 14, bottom: 28, left: 38 };
    const pw = W - m.left - m.right;
    const ph = H - m.top - m.bottom;

    let lo = Math.floor(Math.min(...values) - 2);
    let hi = Math.ceil(Math.max(Math.max(...values) + 2, 28));
    const step = niceStep(hi - lo);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;

    const x = (i) => m.left + (i / (points.length - 1)) * pw;
    const y = (v) => m.top + ((hi - v) / (hi - lo)) * ph;

    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true' });

    // tier bands (clipped to the visible domain)
    const bands = svgEl('g');
    for (const b of BANDS) {
      const top = Math.min(b.to, hi);
      const bottom = Math.max(b.from, lo);
      if (top <= bottom) continue;
      bands.append(svgEl('rect', { class: `chart-band ${b.tier}`, x: m.left, width: pw, y: y(top), height: y(bottom) - y(top) }));
    }
    svg.append(bands);

    // grid + y ticks
    const grid = svgEl('g', { class: 'chart-grid' });
    const axis = svgEl('g', { class: 'chart-axis' });
    for (let v = lo; v <= hi + 1e-9; v += step) {
      grid.append(svgEl('line', { x1: m.left, x2: W - m.right, y1: y(v), y2: y(v) }));
      axis.append(svgEl('text', { x: m.left - 8, y: y(v) + 4, 'text-anchor': 'end' }, `${v}°`));
    }
    // x ticks: every 3 h when there is room, every 6 h on narrow screens (labels must not collide)
    const every = pw / (points.length - 1) * 3 >= 44 ? 3 : 6;
    points.forEach((p, i) => {
      if (i % every !== 0) return;
      axis.append(svgEl('text', { x: x(i), y: H - 8, 'text-anchor': i === 0 ? 'start' : 'middle' }, i === 0 ? 'Now' : hhmm(p.time)));
    });
    svg.append(grid, axis);
    svg.append(svgEl('line', { class: 'chart-baseline', x1: m.left, x2: W - m.right, y1: m.top + ph, y2: m.top + ph }));

    // area wash + line
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.heatIndexC).toFixed(1)}`).join('');
    svg.append(svgEl('path', { class: 'chart-area', d: `${line}L${x(points.length - 1)},${m.top + ph}L${x(0)},${m.top + ph}Z` }));
    svg.append(svgEl('path', { class: 'chart-line', d: line }));

    // selective direct label: the peak only
    const px = x(peakIdx);
    const py = y(values[peakIdx]);
    svg.append(svgEl('circle', { class: 'chart-dot', cx: px, cy: py, r: 4.5 }));
    const anchor = px > W - 90 ? 'end' : px < m.left + 60 ? 'start' : 'middle';
    svg.append(svgEl('text', { class: 'chart-label', x: px, y: Math.max(14, py - 10), 'text-anchor': anchor },
      `Peak ${fmtC(values[peakIdx])} · ${hhmm(points[peakIdx].time)}`));

    // crosshair layer
    const cross = svgEl('line', { class: 'chart-cross', y1: m.top, y2: m.top + ph, visibility: 'hidden' });
    const dot = svgEl('circle', { class: 'chart-dot', r: 4.5, visibility: 'hidden' });
    const hit = svgEl('rect', { x: m.left, y: 0, width: pw, height: H, fill: 'transparent' });
    svg.append(cross, dot, hit);

    function show(i) {
      active = Math.max(0, Math.min(points.length - 1, i));
      const p = points[active];
      cross.setAttribute('x1', x(active));
      cross.setAttribute('x2', x(active));
      cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x(active));
      dot.setAttribute('cy', y(p.heatIndexC));
      dot.setAttribute('visibility', 'visible');

      clear(tooltip).append(
        el('div', { class: 'tt-value' }, `${fmtC(p.heatIndexC)} · ${fmtF(p.heatIndexC)}`),
        el('div', { class: 'tt-time' }, `${whenLabel(p.time)} · air ${fmtC(p.tempC)}`),
        el('div', { class: 'mt-6' }, tierBadge(p.tier)),
      );
      tooltip.style.display = 'block';
      const scale = wrap.clientWidth / W;
      const left = x(active) * scale;
      const tw = tooltip.offsetWidth;
      tooltip.style.left = `${Math.min(Math.max(0, left - tw / 2), wrap.clientWidth - tw)}px`;
      tooltip.style.top = `${Math.max(0, y(p.heatIndexC) * scale - tooltip.offsetHeight - 14)}px`;
      live.textContent = `${whenLabel(p.time)}: heat index ${fmtC(p.heatIndexC)}, ${TIER_LABELS[p.tier]}`;
    }
    function hide() {
      active = null;
      cross.setAttribute('visibility', 'hidden');
      dot.setAttribute('visibility', 'hidden');
      tooltip.style.display = 'none';
    }
    const indexFromEvent = (e) => {
      const r = svg.getBoundingClientRect();
      const sx = ((e.clientX - r.left) / r.width) * W;
      return Math.round(((sx - m.left) / pw) * (points.length - 1));
    };
    hit.addEventListener('pointermove', (e) => show(indexFromEvent(e)));
    hit.addEventListener('pointerdown', (e) => show(indexFromEvent(e)));
    hit.addEventListener('pointerleave', hide);
    wrap.onkeydown = (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        show(active === null ? 0 : active + (e.key === 'ArrowRight' ? 1 : -1));
      } else if (e.key === 'Escape') hide();
    };
    wrap.onblur = hide;

    clear(wrap).append(svg, tooltip);
  }

  draw();
  // Colors are CSS variables, so a theme switch needs no redraw; only width changes do.
  let lastWidth = wrap.clientWidth;
  container.heatChartObserver?.disconnect();
  container.heatChartObserver = new ResizeObserver(() => {
    if (Math.abs(wrap.clientWidth - lastWidth) > 4) {
      lastWidth = wrap.clientWidth;
      draw();
    }
  });
  container.heatChartObserver.observe(wrap);
}

function tableView(points, whenLabel) {
  return el('details', { class: 'table-view' },
    el('summary', {}, 'Show hourly table'),
    el('div', { class: 'table-scroll' },
      el('table', { class: 'data-table' },
        el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Time'), el('th', { scope: 'col' }, 'Heat index'), el('th', { scope: 'col' }, 'Air'), el('th', { scope: 'col' }, 'Risk'))),
        el('tbody', {}, points.map((p) =>
          el('tr', {},
            el('td', { class: 'num' }, whenLabel(p.time)),
            el('td', { class: 'num' }, `${fmtC(p.heatIndexC)} (${fmtF(p.heatIndexC)})`),
            el('td', { class: 'num' }, fmtC(p.tempC)),
            el('td', {}, tierBadge(p.tier))))))));
}
