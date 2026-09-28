import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, parseEmail, parseCoord, secretMatches, hashSecret, newId, mapLimit, toAscii } from '../functions/lib/util.mjs';

test('cleanText strips markup, control and bidi-override characters but keeps joiners', () => {
  assert.equal(cleanText('  <b>Ana</b>\u0000 \n María ', 40), 'bAna/b María');
  assert.equal(cleanText('evil‮gnp.exe', 40), 'evilgnp.exe');
  const hindiWithZwj = 'क्‍ष';
  assert.equal(cleanText(hindiWithZwj, 40), hindiWithZwj);
  assert.equal(cleanText('   ', 10), null);
  assert.equal(cleanText('😀😀😀', 2), '😀😀', 'length cap counts code points, not UTF-16 units');
});

test('email parsing', () => {
  assert.equal(parseEmail(' Crew.Lead@Example.org '), 'crew.lead@example.org');
  assert.equal(parseEmail(''), null);
  assert.throws(() => parseEmail('not-an-email'));
  assert.throws(() => parseEmail('a@b'));
});

test('coordinates are range-checked', () => {
  assert.equal(parseCoord('24.86', 'lat'), 24.86);
  assert.throws(() => parseCoord('91', 'lat'));
  assert.throws(() => parseCoord('abc', 'lon'));
});

test('secrets: hash compare, wrong secrets and garbage fail closed', () => {
  const s = newId(24);
  assert.equal(s.length, 32);
  const h = hashSecret(s);
  assert.equal(secretMatches(s, h), true);
  assert.equal(secretMatches(`${s}x`, h), false);
  assert.equal(secretMatches(null, h), false);
  assert.equal(secretMatches(s, 'nothex'), false);
});

test('mapLimit preserves order and caps concurrency', async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return x * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.ok(peak <= 3);
});

test('toAscii for SNS subjects', () => {
  assert.equal(toAscii('São Paulo'), 'Sao Paulo');
  assert.equal(toAscii('كراتشي'), '');
});
