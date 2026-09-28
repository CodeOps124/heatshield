import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentile, ehfSeries, climatology, severity, assessEhf } from '../functions/lib/algorithms/ehf.mjs';
import { linearRegression, ewmaUpdate, ewmaAnomaly, logistic } from '../functions/lib/algorithms/stats.mjs';
import { createBm25Index, tokenize } from '../functions/lib/algorithms/bm25.mjs';
import { identifyLanguage, languageMatches } from '../functions/lib/algorithms/langid.mjs';

// ---------------- Excess Heat Factor (Nairn & Fawcett 2015)
test('percentile uses linear interpolation', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([10], 95), 10);
  assert.equal(percentile([], 95), null);
});

test('EHF matches the paper\'s formula on a hand-computed case', () => {
  // 30 days at 25 °C, then 3 days at 35 °C. T95 = 30.
  const dmt = [...Array(30).fill(25), 35, 35, 35];
  const [d] = ehfSeries(dmt, 30);
  assert.equal(d.i, 30);
  assert.equal(d.ehiSig, 5); // 35 - 30
  assert.equal(d.ehiAccl, 10); // 35 - 25
  assert.equal(d.ehf, 50); // 5 x max(1, 10)
});

test('EHF acclimatisation term never shrinks the signal below EHIsig', () => {
  const dmt = [...Array(30).fill(34), 33, 33, 33]; // hot but cooler than the last month
  const [d] = ehfSeries(dmt, 30);
  assert.equal(d.ehiSig, 3);
  assert.ok(d.ehiAccl < 0);
  assert.equal(d.ehf, 3); // 3 x max(1, negative) = 3
});

test('severity classes follow EHF85 thresholds', () => {
  assert.equal(severity(-1, 10), 'none');
  assert.equal(severity(5, 10), 'low-intensity');
  assert.equal(severity(10, 10), 'severe');
  assert.equal(severity(30, 10), 'extreme');
});

test('climatology + assessEhf find a heatwave only when it is unusual locally', () => {
  // Reference climate: DMT oscillating 20..30 °C for ~10 years.
  const n = 3650;
  const tmax = Array.from({ length: n }, (_, i) => 30 + 5 * Math.sin((2 * Math.PI * i) / 365));
  const tmin = tmax.map((t) => t - 10);
  const clim = climatology(tmax, tmin);
  assert.ok(clim.t95 > 29 && clim.t95 < 30.1, `t95 was ${clim.t95}`);

  const dates = Array.from({ length: 38 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`.replace(/-(3[2-9])$/, (m) => m));
  const pastMax = Array(31).fill(30);
  const hot = assessEhf({ dates, tmax: [...pastMax, 40, 41, 42, 40, 36, 33, 31], tmin: [...Array(31).fill(20), 28, 29, 29, 28, 24, 22, 21], today: dates[31], climate: clim });
  assert.equal(hot.heatwave, true);
  assert.ok(['severe', 'extreme'].includes(hot.worst.severity));
  const normal = assessEhf({ dates, tmax: [...pastMax, 30, 30, 30, 30, 30, 30, 30], tmin: Array(38).fill(20), today: dates[31], climate: clim });
  assert.equal(normal.heatwave, false);
  assert.throws(() => assessEhf({ dates, tmax: pastMax, tmin: pastMax, today: dates[5], climate: clim }), RangeError);
});

// ---------------- statistics
test('least-squares regression recovers a known line', () => {
  const r = linearRegression([0, 1, 2, 3], [1, 3, 5, 7]);
  assert.equal(r.slope, 2);
  assert.equal(r.intercept, 1);
  assert.equal(r.r2, 1);
});

test('EWMA control chart: warms up, then flags a real spike but not a small wobble', () => {
  let s;
  for (let i = 0; i < 20; i += 1) s = ewmaUpdate(s, 200 + (i % 2 ? 10 : -10));
  assert.equal(ewmaAnomaly(undefined, 5000).anomaly, false, 'no verdict before warm-up');
  assert.equal(ewmaAnomaly(s, 260, { floor: 800 }).anomaly, false, 'small excess ignored');
  assert.equal(ewmaAnomaly(s, 4000, { floor: 800 }).anomaly, true);
});

test('logistic is a proper sigmoid', () => {
  assert.equal(logistic(0), 0.5);
  assert.ok(logistic(5) > 0.99 && logistic(-5) < 0.01);
});

// ---------------- BM25
test('BM25 ranks the relevant document first', () => {
  const idx = createBm25Index([
    { id: 'car', text: 'Never leave a child in a parked car.' },
    { id: 'water', text: 'Workers should drink water every 20 minutes.' },
    { id: 'fan', text: 'A fan is not enough when it is very hot.' },
  ]);
  assert.equal(idx.search('child car', 1)[0].doc.id, 'car');
  assert.equal(idx.search('worker drinking water', 1)[0].doc.id, 'water');
  assert.equal(idx.search('zebra', 3).length, 0);
  assert.deepEqual(tokenize('The Workers, drinking!'), ['worker', 'drink']);
});

// ---------------- language identification
test('language ID separates close Latin-script languages and Arabic from Urdu', () => {
  assert.equal(identifyLanguage('Descansa a la sombra y bebe agua con frecuencia para que no te agotes.').lang, 'es');
  assert.equal(identifyLanguage('Descanse na sombra e beba água com frequência para que você não se canse.').lang, 'pt');
  assert.equal(identifyLanguage('Pumzika kwenye kivuli na kunywa maji kila saa kwa sababu ni joto sana.').lang, 'sw');
  assert.equal(identifyLanguage('Istirahat di tempat teduh dan minum air untuk menjaga tubuh anda.').lang, 'id');
  assert.equal(identifyLanguage('ہر 15 منٹ میں پانی پئیں اور سائے میں رہیں۔').lang, 'ur');
  assert.equal(identifyLanguage('اشرب الماء كل ربع ساعة وابق في الظل.').lang, 'ar');
  assert.equal(languageMatches('Drink water and rest in the shade when it is hot.', 'es').ok, false);
  assert.equal(languageMatches('Bebe agua y descansa a la sombra cuando hace calor.', 'es').ok, true);
});
