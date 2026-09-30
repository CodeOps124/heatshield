// Agent HQ — a pixel-art office where HeatShield's eight agents work. Everything is drawn in code
// (original art, no image assets; CSP-friendly). The scene is a 320×192 canvas scaled up with
// integer scaling and `image-rendering: pixelated`. What each agent is DOING comes from the live
// agent log (GET /api/agents) and from real runs a visitor triggers — the art only shows it.

export const OFFICE_W = 320;
export const OFFICE_H = 192;

const DESK_TOP = [104, 160];
// Two rows of four desks (68 px wide, 8 px apart). The forecast team sits together (Sol, Quinn),
// Vera sits right under Mira so drafts travel a short way, and Otto keeps his server rack on the right.
export const SEATS = {
  sol: { cx: 38, row: 0 },
  quinn: { cx: 114, row: 0 },
  mira: { cx: 190, row: 0 },
  lexi: { cx: 266, row: 0 },
  kai: { cx: 38, row: 1 },
  iris: { cx: 114, row: 1 },
  vera: { cx: 190, row: 1 },
  otto: { cx: 266, row: 1 },
};

const LOOKS = {
  sol: { skin: '#c68642', skinShade: '#a86d33', hair: 'short', hairColor: '#2b1d16', shirt: '#eb6834', shirtShade: '#c4521f', acc: ['cap'], cap: '#f4b400', capShade: '#c98f00' },
  mira: { skin: '#8d5524', skinShade: '#6f421b', hair: 'curly', hairColor: '#1b1b1b', shirt: '#f2f2f2', shirtShade: '#cfcfcf', inner: '#1baf7a', acc: ['stethoscope'] },
  lexi: { skin: '#f1c27d', skinShade: '#d9a764', hair: 'long', hairColor: '#b5472e', shirt: '#7b5ea7', shirtShade: '#5e4686', acc: ['headset'], accent: '#e87ba4' },
  vera: { skin: '#e0ac69', skinShade: '#c48f4f', hair: 'bun', hairColor: '#a4a9b0', shirt: '#2f4b7c', shirtShade: '#233a61', acc: ['glasses', 'badge'] },
  kai: { skin: '#6b4423', skinShade: '#553518', hair: 'short', hairColor: '#20140c', shirt: '#3a9d5d', shirtShade: '#2b7a47', acc: ['headset'], accent: '#fab219' },
  otto: { skin: '#f5cba7', skinShade: '#ddb08a', hair: 'buzz', hairColor: '#d8b24a', shirt: '#3d3f4f', shirtShade: '#2c2e3a', acc: ['hoodie'], accent: '#3987e5' },
  quinn: { skin: '#d8a47f', skinShade: '#bf8a63', hair: 'short', hairColor: '#6b4e2e', shirt: '#0f766e', shirtShade: '#0b5c56', acc: ['glasses'] },
  iris: { skin: '#a86b3c', skinShade: '#8c5630', hair: 'long', hairColor: '#2d1b12', shirt: '#be185d', shirtShade: '#9d174d', acc: ['badge'] },
};

const INK = '#1b1b2f';
const LAMP = { working: '#22c55e', idle: '#86efac', error: '#ef4444', waiting: '#94a3b8' };
const TIER_DOT = { none: '#94a3b8', watch: '#fab219', warning: '#ec835a', emergency: '#ef4444' };

// Stylised world map for the situation board: 48 columns × 18 rows of 7.5° cells
// (180°W→180°E, 75°N→60°S). Each entry: [row, [firstCol, lastCol], ...] land runs.
const WORLD = [
  [0, [2, 5], [6, 9], [11, 15], [16, 21], [26, 28], [28, 47]],
  [1, [2, 5], [5, 10], [14, 15], [17, 17], [20, 21], [24, 28], [28, 47]],
  [2, [6, 10], [13, 16], [22, 23], [24, 27], [28, 42], [44, 45]],
  [3, [7, 16], [23, 29], [29, 42], [42, 43]],
  [4, [7, 14], [22, 24], [25, 30], [30, 40], [40, 41], [42, 43]],
  [5, [8, 13], [22, 28], [28, 30], [30, 33], [34, 40], [41, 42]],
  [6, [8, 11], [13, 13], [21, 28], [28, 31], [31, 33], [33, 40], [40, 40]],
  [7, [9, 12], [13, 13], [21, 29], [29, 31], [33, 35], [36, 38], [40, 40]],
  [8, [11, 13], [14, 15], [21, 29], [29, 30], [33, 34], [37, 38], [40, 41]],
  [9, [13, 17], [22, 30], [37, 39], [40, 40]],
  [10, [13, 19], [25, 29], [37, 40], [41, 43]],
  [11, [13, 19], [25, 29], [30, 30], [41, 43]],
  [12, [14, 18], [25, 28], [29, 30], [39, 43]],
  [13, [14, 17], [26, 28], [39, 44]],
  [14, [14, 16], [26, 27], [39, 43]],
  [15, [14, 15], [43, 43], [47, 47]],
  [16, [14, 14], [46, 46]],
  [17, [14, 14]],
];
const MAP = { x: 112, y: 13, cell: 2, cols: 48, rows: 18 };

export function createOffice(canvas, { reducedMotion = false } = {}) {
  const ctx = canvas.getContext('2d');
  canvas.width = OFFICE_W;
  canvas.height = OFFICE_H;
  ctx.imageSmoothingEnabled = false;

  const state = Object.fromEntries(Object.keys(SEATS).map((id) => [id, { mode: 'waiting', until: 0, celebrateUntil: 0, alertUntil: 0 }]));
  let board = { areas: [], events: [], status: 'unknown' };
  const papers = [];
  let frame = 0;
  let raf = null;
  let last = 0;

  const rect = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };
  const px = (x, y, c) => rect(x, y, 1, 1, c);

  function line(x0, y0, x1, y1, c) {
    let dx = Math.abs(x1 - x0);
    let dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      px(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  // ------------------------------------------------------------------ room (static parts cached)
  const bg = document.createElement('canvas');
  bg.width = OFFICE_W;
  bg.height = OFFICE_H;
  (function paintRoom() {
    const b = bg.getContext('2d');
    const r = (x, y, w, h, c) => { b.fillStyle = c; b.fillRect(x, y, w, h); };
    r(0, 0, OFFICE_W, 64, '#efe6d6'); // wall
    r(0, 0, OFFICE_W, 3, '#d9ccb4');
    for (let x = 0; x < OFFICE_W; x += 16) r(x, 3, 1, 57, '#e8dcc8'); // wallpaper stripes
    r(0, 60, OFFICE_W, 4, '#b89b72'); // baseboard
    r(0, 60, OFFICE_W, 1, '#caae86');
    for (let y = 64; y < OFFICE_H; y += 8) { // wooden floor
      r(0, y, OFFICE_W, 8, (y / 8) % 2 ? '#d9c3a0' : '#d4bd98');
      const offset = (y / 8) % 2 ? 0 : 16;
      for (let x = offset; x < OFFICE_W; x += 32) r(x, y, 1, 8, '#c3a883');
    }
    // board frame
    r(100, 6, 120, 50, '#2b2d42');
    r(102, 8, 116, 46, '#0f172a');
    for (const [row, ...runs] of WORLD) {
      for (const [c0, c1] of runs) r(MAP.x + c0 * MAP.cell, MAP.y + row * MAP.cell, (c1 - c0 + 1) * MAP.cell, MAP.cell, '#1f5f5b');
    }
    r(146, 56, 28, 3, '#2b2d42'); // board mount
    // window frame
    r(6, 8, 70, 46, '#8a6d4b');
    // sign: HeatShield shield
    r(262, 14, 30, 20, '#fcfcfb');
    r(262, 14, 30, 1, '#d9ccb4');
    const shield = ['..#######..', '.#########.', '.#########.', '.#########.', '..#######..', '...#####...', '....###....', '.....#.....'];
    shield.forEach((rowStr, y) => [...rowStr].forEach((ch, x) => { if (ch === '#') r(272 + x, 17 + y, 1, 1, '#eb6834'); }));
    r(277, 19, 1, 3, '#fff');
    r(277, 23, 1, 1, '#fff');
    r(265, 28, 24, 2, '#eb6834');
    // plant
    r(82, 50, 10, 10, '#b5643c');
    r(82, 50, 10, 2, '#9c5230');
    [[86, 34], [83, 38], [89, 37], [81, 43], [91, 42], [86, 41], [85, 46], [88, 46]].forEach(([x, y]) => { r(x, y, 3, 5, '#3a9d5d'); r(x + 1, y, 1, 5, '#2b7a47'); });
    // water cooler (hydration matters in a heat app)
    r(300, 44, 12, 20, '#f2f2f2');
    r(300, 44, 12, 1, '#d4d4d4');
    r(302, 30, 8, 14, '#9ad0f5');
    r(303, 31, 2, 12, '#c7e6fb');
    r(304, 48, 4, 2, '#3987e5');
    r(298, 63, 16, 1, '#c3a883');
  })();

  // ------------------------------------------------------------------ dynamic room parts
  function drawWindow() {
    const hour = new Date().getHours() + new Date().getMinutes() / 60;
    const day = hour >= 6.5 && hour < 18.5;
    const dusk = (hour >= 18.5 && hour < 20) || (hour >= 5.5 && hour < 6.5);
    rect(8, 10, 66, 42, day ? '#8ecae6' : dusk ? '#f4a261' : '#1d3557');
    if (day) {
      const t = (hour - 6.5) / 12; // sun arc across the window
      const sx = 12 + Math.round(t * 54);
      const sy = 30 - Math.round(Math.sin(t * Math.PI) * 16);
      rect(sx - 2, sy - 2, 5, 5, '#ffb703');
      rect(sx - 1, sy - 3, 3, 7, '#ffb703');
      rect(sx - 3, sy - 1, 7, 3, '#ffb703');
      // heat shimmer over the skyline
      const s = reducedMotion ? 0 : frame % 8;
      for (let x = 8; x < 74; x += 4) px(x + ((x + s) % 3), 38 + ((x + s) % 2), '#ffd6a5');
    } else if (!dusk) {
      rect(58, 16, 5, 5, '#f1faee');
      rect(60, 16, 3, 3, '#1d3557');
      [[14, 14], [24, 20], [36, 13], [46, 22], [30, 26]].forEach(([x, y], i) => { if (reducedMotion || (frame + i * 3) % 12 < 9) px(x, y, '#f1faee'); });
    }
    // skyline
    [[8, 40, 8, 12], [16, 36, 7, 16], [23, 42, 9, 10], [32, 34, 6, 18], [38, 39, 10, 13], [48, 37, 7, 15], [55, 41, 8, 11], [63, 35, 11, 17]].forEach(([x, y, w, h]) => {
      rect(x, y, w, h, day ? '#5c677d' : '#2b3a55');
      for (let wy = y + 2; wy < y + h - 1; wy += 3) for (let wx = x + 1; wx < x + w - 1; wx += 3) if (!day || dusk) px(wx, wy, '#ffd166');
    });
    rect(40, 10, 2, 42, '#8a6d4b'); // window mullion
    rect(8, 30, 66, 2, '#8a6d4b');
  }

  function drawClock() {
    const now = new Date();
    const cx = 245;
    const cy = 22;
    for (let a = 0; a < 360; a += 6) px(Math.round(cx + Math.cos((a * Math.PI) / 180) * 8), Math.round(cy + Math.sin((a * Math.PI) / 180) * 8), INK);
    for (let y = -7; y <= 7; y += 1) for (let x = -7; x <= 7; x += 1) if (x * x + y * y < 49) px(cx + x, cy + y, '#fcfcfb');
    for (let h = 0; h < 12; h += 3) px(Math.round(cx + Math.sin((h / 12) * 2 * Math.PI) * 6), Math.round(cy - Math.cos((h / 12) * 2 * Math.PI) * 6), '#898781');
    const mA = (now.getMinutes() / 60) * 2 * Math.PI;
    const hA = (((now.getHours() % 12) + now.getMinutes() / 60) / 12) * 2 * Math.PI;
    line(cx, cy, Math.round(cx + Math.sin(mA) * 6), Math.round(cy - Math.cos(mA) * 6), INK);
    line(cx, cy, Math.round(cx + Math.sin(hA) * 4), Math.round(cy - Math.cos(hA) * 4), '#eb6834');
  }

  function drawBoard() {
    // blinking LIVE light
    rect(104, 9, 3, 3, reducedMotion || frame % 16 < 11 ? '#ef4444' : '#7f1d1d');
    const statusColor = board.status === 'healthy' ? '#22c55e' : board.status === 'degraded' ? '#fab219' : board.status === 'down' ? '#ef4444' : '#64748b';
    rect(211, 9, 3, 3, statusColor);
    const toXY = (lat, lon) => ({
      x: MAP.x + Math.round(((lon + 180) / 360) * MAP.cols * MAP.cell),
      y: MAP.y + Math.round(((75 - lat) / 135) * MAP.rows * MAP.cell),
    });
    // Every watched area, colored by its heat event; events carry coordinates too, so they still
    // show if an area was stored without them.
    const hasXY = (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon);
    const points = new Map(board.areas.filter(hasXY).map((a) => [a.place, { lat: a.lat, lon: a.lon, level: null }]));
    for (const e of board.events) {
      const p = points.get(e.place) ?? (hasXY(e) ? { lat: e.lat, lon: e.lon } : null);
      if (p) points.set(e.place, { ...p, level: e.level });
    }
    for (const { lat, lon, level } of points.values()) {
      const { x, y } = toXY(lat, lon);
      const c = TIER_DOT[level ?? 'none'];
      const pulse = level && !reducedMotion && frame % 10 < 5;
      if (pulse) rect(x - 2, y - 2, 5, 5, level === 'emergency' ? '#7f1d1d' : '#7c4a03');
      rect(x - 1, y - 1, 3, 3, c);
    }
  }

  // ------------------------------------------------------------------ characters
  function drawCharacter(id, ox, oy, pose, f) {
    const L = LOOKS[id];
    const blink = !reducedMotion && (f + id.length * 7) % 40 === 0;
    const bob = pose === 'typing' && !reducedMotion && f % 6 < 3 ? 1 : 0;
    const celebrate = pose === 'celebrate';
    const y0 = oy + bob;
    const R = (c, r, w, h, col) => rect(ox + c, y0 + r, w, h, col);

    // torso
    R(3, 10, 10, 10, L.shirt);
    R(11, 10, 2, 10, L.shirtShade);
    if (L.inner) R(6, 10, 4, 5, L.inner); // Mira's scrubs under the coat
    else R(6, 10, 4, 1, L.shirtShade); // collar
    if (L.acc.includes('hoodie')) {
      R(3, 9, 10, 2, L.shirt);
      R(7, 11, 1, 3, '#f2f2f2');
      R(9, 11, 1, 3, '#f2f2f2');
      R(3, 16, 10, 1, L.accent);
    }
    if (L.acc.includes('stethoscope')) {
      R(5, 10, 1, 3, '#9ca3af');
      R(10, 10, 1, 3, '#9ca3af');
      R(6, 13, 4, 1, '#9ca3af');
      R(9, 14, 2, 2, '#d1d5db');
    }
    if (L.acc.includes('badge')) {
      R(10, 12, 2, 2, '#fab219');
      R(10, 12, 1, 1, '#fff3c4');
    }
    // neck + head
    R(7, 9, 2, 1, L.skinShade);
    R(5, 3, 6, 6, L.skin);
    R(4, 5, 1, 2, L.skin);
    R(11, 5, 1, 2, L.skin);
    // eyes / mouth
    if (blink) {
      R(6, 5, 1, 1, L.skinShade);
      R(9, 5, 1, 1, L.skinShade);
    } else {
      R(6, 5, 1, 1, INK);
      R(9, 5, 1, 1, INK);
    }
    R(7, 7, 2, 1, celebrate ? '#7f1d1d' : L.skinShade);
    if (celebrate) R(7, 8, 2, 1, '#7f1d1d');
    // hair
    const H = (c, r, w, h) => R(c, r, w, h, L.hairColor);
    switch (L.hair) {
      case 'short': H(6, 1, 4, 1); H(5, 2, 6, 1); H(5, 3, 2, 1); H(4, 3, 1, 2); H(11, 3, 1, 2); break;
      case 'long': H(6, 1, 4, 1); H(5, 2, 6, 1); H(5, 3, 3, 1); H(4, 3, 1, 7); H(11, 3, 1, 7); H(3, 6, 1, 4); H(12, 6, 1, 4); break;
      case 'curly': for (let c = 4; c <= 11; c += 1) H(c, c % 2 ? 1 : 2, 1, 2); H(4, 3, 1, 3); H(11, 3, 1, 3); H(5, 3, 6, 1); break;
      case 'bun': H(7, -1, 2, 2); H(6, 1, 4, 1); H(5, 2, 6, 1); H(5, 3, 1, 2); H(10, 3, 1, 2); break;
      case 'buzz': H(6, 2, 4, 1); H(5, 3, 6, 1); break;
      default: break;
    }
    if (L.acc.includes('cap')) { // Sol's sun visor
      R(5, 1, 6, 2, L.cap);
      R(3, 3, 8, 1, L.capShade);
      R(10, 1, 1, 2, L.capShade);
    }
    if (L.acc.includes('glasses')) {
      R(5, 5, 3, 1, INK); R(8, 5, 3, 1, INK);
      R(6, 5, 1, 1, '#bfdbfe'); R(9, 5, 1, 1, '#bfdbfe');
    }
    if (L.acc.includes('headset')) {
      R(5, 0, 6, 1, '#374151');
      R(4, 1, 1, 3, '#374151'); R(11, 1, 1, 3, '#374151');
      R(3, 4, 2, 3, '#111827'); R(11, 4, 2, 3, '#111827');
      R(12, 7, 1, 1, '#374151'); R(10, 8, 2, 1, L.accent ?? '#374151');
    }
    // arms
    if (celebrate) {
      R(1, 4, 2, 7, L.shirt); R(13, 4, 2, 7, L.shirt);
      R(1, 2, 2, 2, L.skin); R(13, 2, 2, 2, L.skin);
    } else if (pose === 'typing') {
      R(2, 11, 2, 6, L.shirtShade); R(12, 11, 2, 6, L.shirtShade);
      R(3, 16, 3, 2, L.shirt); R(10, 16, 3, 2, L.shirt);
    } else {
      R(2, 11, 2, 8, L.shirtShade); R(12, 11, 2, 8, L.shirtShade);
      R(2, 18, 2, 2, L.skin); R(12, 18, 2, 2, L.skin);
    }
  }

  function drawHands(id, ox, oy, pose, f) {
    if (pose !== 'typing') return;
    const L = LOOKS[id];
    const a = reducedMotion ? 0 : f % 4 < 2 ? 0 : 1;
    rect(ox + 4, oy + 18 + a, 2, 2, L.skin);
    rect(ox + 10, oy + 19 - a, 2, 2, L.skin);
  }

  // ------------------------------------------------------------------ monitors (each agent's work)
  function drawScreen(id, x, y, mode, f) {
    const w = 14;
    const h = 9;
    const on = mode !== 'waiting';
    const busy = mode === 'working';
    const s = reducedMotion ? 0 : busy ? f : Math.floor(f / 6);
    if (!on) { rect(x, y, w, h, '#1f2937'); return; }
    if (mode === 'error') {
      rect(x, y, w, h, '#450a0a');
      if (reducedMotion || f % 8 < 5) { rect(x + 6, y + 1, 2, 5, '#ef4444'); rect(x + 6, y + 7, 2, 1, '#ef4444'); }
      return;
    }
    switch (id) {
      case 'sol': { // heat map + scanning line
        rect(x, y, w, h, '#0b1d3a');
        const ramp = ['#1d4ed8', '#22c55e', '#fab219', '#ec835a', '#ef4444'];
        for (let c = 0; c < w; c += 1) {
          const v = Math.floor(((Math.sin((c + s) * 0.7) + 1) / 2) * 4.99);
          rect(x + c, y + h - 1 - v, 1, v + 1, ramp[v]);
        }
        rect(x + (s % w), y, 1, h, '#e0f2fe');
        break;
      }
      case 'mira': { // a document being written
        rect(x, y, w, h, '#f8fafc');
        const lines = busy ? (s % 5) + 1 : 4;
        for (let l = 0; l < lines; l += 1) rect(x + 1, y + 1 + l * 2, l === lines - 1 && busy ? (s * 2) % 12 + 1 : 12 - (l % 2) * 3, 1, '#94a3b8');
        rect(x + 1, y + 1, 5, 1, '#1baf7a');
        break;
      }
      case 'lexi': { // two languages side by side
        rect(x, y, w, h, '#1e1b4b');
        for (let l = 0; l < 4; l += 1) {
          rect(x + 1, y + 1 + l * 2, 5 - ((l + s) % 2), 1, '#a5b4fc');
          rect(x + 8, y + 1 + l * 2, 5 - ((l + s + 1) % 2), 1, '#f9a8d4');
        }
        rect(x + 6, y + 4, 2, 1, busy && s % 2 ? '#fde68a' : '#6366f1');
        break;
      }
      case 'vera': { // safety checklist
        rect(x, y, w, h, '#f8fafc');
        const done = busy ? s % 5 : 4;
        for (let l = 0; l < 4; l += 1) {
          rect(x + 1, y + 1 + l * 2, 1, 1, l < done ? '#16a34a' : '#cbd5e1');
          rect(x + 3, y + 1 + l * 2, 9, 1, '#cbd5e1');
        }
        break;
      }
      case 'kai': { // prioritised check-in list
        rect(x, y, w, h, '#f0fdf4');
        const colors = ['#ef4444', '#ec835a', '#fab219', '#22c55e'];
        for (let l = 0; l < 4; l += 1) {
          const hl = busy && s % 4 === l;
          if (hl) rect(x, y + l * 2 + 1, w, 1, '#bbf7d0');
          rect(x + 1, y + 1 + l * 2, 1, 1, colors[l]);
          rect(x + 3, y + 1 + l * 2, 8 - l, 1, '#64748b');
        }
        break;
      }
      case 'quinn': { // verification scatter: forecast vs what happened, around the diagonal
        rect(x, y, w, h, '#0f172a');
        for (let c = 0; c < w - 1; c += 2) px(x + c, y + h - 1 - Math.floor((c * (h - 1)) / (w - 1)), '#334155');
        for (let k = 0; k < 6; k += 1) {
          const c = (k * 5 + (busy ? s : 0)) % (w - 1);
          const jitter = ((k * 7 + s) % 3) - 1;
          px(x + c, Math.min(y + h - 1, Math.max(y, y + h - 1 - Math.floor((c * (h - 1)) / (w - 1)) + jitter)), '#2dd4bf');
        }
        break;
      }
      case 'iris': { // word list: wrong word crossed out, right word ticked
        rect(x, y, w, h, '#fdf2f8');
        for (let l = 0; l < 4; l += 1) {
          const hl = busy && s % 4 === l;
          if (hl) rect(x, y + l * 2 + 1, w, 1, '#fbcfe8');
          rect(x + 1, y + 1 + l * 2, 4, 1, '#f87171');
          rect(x + 7, y + 1 + l * 2, 5, 1, '#16a34a');
        }
        break;
      }
      case 'otto': { // latency chart + status
        rect(x, y, w, h, '#020617');
        for (let c = 0; c < w - 1; c += 1) {
          const v = Math.round((Math.sin((c + s) * 0.9) + Math.sin((c + s) * 0.37)) * 1.5);
          px(x + c, y + 4 + v, '#22c55e');
        }
        rect(x + w - 3, y + 1, 2, 2, board.status === 'down' ? '#ef4444' : board.status === 'degraded' ? '#fab219' : '#22c55e');
        break;
      }
      default: rect(x, y, w, h, '#334155');
    }
    if (!busy) { // dim when idle
      ctx.fillStyle = 'rgba(15, 23, 42, 0.25)';
      ctx.fillRect(x, y, w, h);
    }
  }

  function drawProps(id, cx, top, f) {
    switch (id) {
      case 'sol': rect(cx + 12, top - 8, 2, 7, '#f8fafc'); rect(cx + 12, top - 4, 2, 3, '#ef4444'); rect(cx + 11, top - 2, 4, 2, '#ef4444'); break; // thermometer
      case 'mira': rect(cx + 9, top - 3, 7, 3, '#f8fafc'); rect(cx + 9, top - 2, 7, 1, '#e2e8f0'); break; // papers
      case 'lexi': rect(cx + 10, top - 6, 5, 5, '#3987e5'); rect(cx + 11, top - 5, 2, 2, '#3a9d5d'); rect(cx + 12, top - 1, 1, 1, '#6d4530'); break; // globe
      case 'vera': rect(cx + 9, top - 5, 7, 5, '#f8fafc'); rect(cx + 12, top - 4, 1, 3, '#ef4444'); rect(cx + 11, top - 3, 3, 1, '#ef4444'); break; // first-aid box
      case 'kai': rect(cx + 10, top - 2, 5, 2, '#111827'); rect(cx + 11, top - 2, 3, 1, '#3987e5'); break; // phone
      case 'quinn': rect(cx + 10, top - 8, 6, 8, '#a16207'); rect(cx + 11, top - 7, 4, 6, '#f8fafc'); rect(cx + 12, top - 5, 2, 1, '#0f766e'); rect(cx + 12, top - 3, 2, 1, '#0f766e'); break; // clipboard
      case 'iris': rect(cx + 9, top - 2, 7, 2, '#be185d'); rect(cx + 10, top - 4, 6, 2, '#7b5ea7'); rect(cx + 9, top - 6, 7, 2, '#0f766e'); break; // books
      case 'otto': { // server rack with blinking LEDs
        const rx = cx + 36;
        rect(rx, top - 30, 18, 52, '#1f2937');
        rect(rx + 1, top - 29, 16, 50, '#111827');
        for (let u = 0; u < 7; u += 1) {
          rect(rx + 2, top - 27 + u * 7, 14, 5, '#1f2937');
          const on = reducedMotion || (f + u * 3) % 9 < 6;
          px(rx + 3, top - 25 + u * 7, on ? '#22c55e' : '#14532d');
          px(rx + 5, top - 25 + u * 7, (f + u) % 5 < 2 ? '#3987e5' : '#1e3a8a');
        }
        break;
      }
      default: break;
    }
  }

  function drawDesk(id, cx, top, s, f) {
    const pose = s.mode === 'working' ? 'typing' : s.celebrateUntil > performance.now() ? 'celebrate' : 'idle';
    const ox = cx - 8;
    const oy = top - 20;
    // chair back
    rect(cx - 7, top - 18, 14, 12, '#44475a');
    rect(cx - 7, top - 18, 14, 1, '#5b5f76');
    drawCharacter(id, ox, oy, pose, f);
    // desk
    rect(cx - 34, top, 68, 5, '#a47148');
    rect(cx - 34, top, 68, 1, '#b98356');
    rect(cx - 32, top + 5, 64, 17, '#7d5536');
    rect(cx - 32, top + 12, 64, 1, '#6d4530');
    rect(cx - 10, top + 8, 20, 6, '#c9a227'); // brass nameplate (name is an HTML label)
    rect(cx - 34, top + 22, 68, 2, '#c3a883');
    drawHands(id, ox, oy, pose, f);
    // monitor
    rect(cx - 30, top - 14, 16, 12, '#2b2b36');
    drawScreen(id, cx - 29, top - 13, s.mode, f);
    rect(cx - 24, top - 2, 4, 2, '#2b2b36');
    // mug + steam
    rect(cx + 19, top - 4, 4, 4, '#f8fafc');
    px(cx + 23, top - 3, '#f8fafc');
    if (!reducedMotion && s.mode !== 'waiting') {
      const k = f % 12;
      if (k < 8) px(cx + 20 + (k % 2), top - 6 - Math.floor(k / 3), '#e2e8f0');
    }
    drawProps(id, cx, top, f);
    // status lamp
    const lamp = LAMP[s.mode] ?? LAMP.idle;
    const blinkOff = !reducedMotion && (s.mode === 'working' || s.mode === 'error') && f % 6 >= 4;
    rect(cx + 27, top - 2, 5, 2, '#374151');
    rect(cx + 28, top - 6, 3, 4, blinkOff ? '#374151' : lamp);
    // error / attention marker
    if (s.mode === 'error' || s.alertUntil > performance.now()) {
      if (reducedMotion || f % 8 < 6) { rect(cx - 1, oy - 9, 2, 5, '#ef4444'); rect(cx - 1, oy - 3, 2, 2, '#ef4444'); }
    }
  }

  // ------------------------------------------------------------------ paper hand-offs
  function drawPapers(now) {
    for (let i = papers.length - 1; i >= 0; i -= 1) {
      const p = papers[i];
      const t = Math.min(1, (now - p.t0) / p.dur);
      const x = Math.round(p.from.x + (p.to.x - p.from.x) * t);
      const y = Math.round(p.from.y + (p.to.y - p.from.y) * t - Math.sin(t * Math.PI) * 22);
      rect(x - 3, y - 2, 6, 5, '#f8fafc');
      rect(x - 2, y - 1, 4, 1, '#94a3b8');
      rect(x - 2, y + 1, 3, 1, '#94a3b8');
      if (t >= 1) papers.splice(i, 1);
    }
  }

  // ------------------------------------------------------------------ loop
  function render(now) {
    ctx.drawImage(bg, 0, 0);
    drawWindow();
    drawClock();
    drawBoard();
    for (const row of [0, 1]) {
      for (const [id, seat] of Object.entries(SEATS)) {
        if (seat.row !== row) continue;
        drawDesk(id, seat.cx, DESK_TOP[row], state[id], frame);
      }
    }
    drawPapers(now);
  }

  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (now - last < 125) return; // 8 frames per second is plenty for pixel art
    last = now;
    frame += 1;
    // temporary modes (set by visitor-triggered runs) expire back to the live state
    for (const s of Object.values(state)) if (s.until && now > s.until) { s.mode = s.base ?? s.mode; s.until = 0; }
    render(now);
  }

  function start() {
    if (raf === null) raf = requestAnimationFrame(tick);
  }
  function stop() {
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
  }
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  render(performance.now());
  start();

  return {
    /** Live state from the agent log: working | idle | error | waiting. */
    setBase(id, mode) {
      const s = state[id];
      if (!s) return;
      s.base = mode;
      if (!s.until) s.mode = mode;
    },
    /** Temporarily override (e.g. while a visitor-triggered run is in flight). */
    setTemp(id, mode, ms) {
      const s = state[id];
      if (!s) return;
      s.mode = mode;
      s.until = performance.now() + ms;
    },
    celebrate(id, ms = 1600) { if (state[id]) state[id].celebrateUntil = performance.now() + ms; },
    attention(id, ms = 2500) { if (state[id]) state[id].alertUntil = performance.now() + ms; },
    passPaper(fromId, toId, dur = 900) {
      const a = SEATS[fromId];
      const b = SEATS[toId];
      if (!a || !b) return;
      papers.push({ from: { x: a.cx + 12, y: DESK_TOP[a.row] - 6 }, to: { x: b.cx + 12, y: DESK_TOP[b.row] - 6 }, t0: performance.now(), dur: reducedMotion ? 1 : dur });
    },
    setBoard(next) { board = { ...board, ...next }; },
    anchors() { return Object.fromEntries(Object.entries(SEATS).map(([id, s]) => [id, { x: s.cx, top: DESK_TOP[s.row] }])); },
    redraw() { render(performance.now()); },
  };
}
