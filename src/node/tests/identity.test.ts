import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform, detectCondition, detectEditions, baseTitle, normTitleKey } from '../lib/identity.ts';
import { parseToPaise, formatPaise } from '../lib/money.ts';

test('detectPlatform reads ps5 and ps4 from titles', () => {
  assert.equal(detectPlatform('Death Stranding 2 PS5'), 'ps5');
  assert.equal(detectPlatform('Titanfall 2 (PS4)'), 'ps4');
});

test('detectCondition distinguishes pre-owned from new', () => {
  assert.equal(detectCondition('God of War PS4 (Pre-Owned)'), 'preowned');
  assert.equal(detectCondition('God of War PS4 Brand New Sealed'), 'new');
});

test('baseTitle strips edition tokens but normTitleKey keeps them', () => {
  const deluxe = 'Oblivion Remastered Deluxe Edition';
  assert.ok(!baseTitle(deluxe).includes('deluxe'));
  assert.ok(normTitleKey(deluxe).includes('deluxe'));
});

test('detectEditions finds edition tokens', () => {
  assert.ok(detectEditions('Cyberpunk 2077 Ultimate Edition').length > 0);
  assert.equal(detectEditions('Titanfall 2').length, 0);
});

test('parseToPaise converts rupees to integer paise', () => {
  assert.equal(parseToPaise('₹1,699'), 169900);
  assert.equal(parseToPaise('3400.00'), 340000);
});

test('formatPaise renders rupees', () => {
  assert.match(formatPaise(169900), /1,699/);
});
