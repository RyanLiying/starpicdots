import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PALETTE_PROVIDER_ID,
  getPaletteProvider,
  PALETTE_MODE_PROVIDER_IDS,
  PALETTE_PROVIDERS,
  paletteModeForProviderId,
  providerIdForPaletteMode,
} from '../../src/palettes/catalog.js';
import { FULL_PALETTE, LEGACY_64_HEX, MARD_PALETTE_SOURCE, PALETTE } from '../../src/palettes/mard221.js';

test('base catalog has the exact nine-series 221-code shape', () => {
  const counts = Object.fromEntries('ABCDEFGHM'.split('').map((series) => [
    series,
    PALETTE.filter((color) => color.series === series).length,
  ]));
  assert.deepEqual(counts, { A: 26, B: 32, C: 29, D: 26, E: 24, F: 25, G: 21, H: 23, M: 15 });
  assert.equal(PALETTE.length, 221);
  assert.equal(new Set(PALETTE.map((color) => color.code)).size, 221);
});

test('transparent, white, and black anchors are explicit', () => {
  assert.equal(PALETTE.find((color) => color.code === 'H1').isTransparent, true);
  assert.equal(PALETTE.find((color) => color.code === 'H2').displayHex, '#FFFFFF');
  assert.equal(PALETTE.find((color) => color.code === 'H7').hex, '#000000');
});

test('catalog source and legacy migration data remain pinned', () => {
  assert.equal(MARD_PALETTE_SOURCE, 'maxcleme/beadcolors@94b99999652866f1a1879d6369fe735f811949e5');
  assert.equal(LEGACY_64_HEX.size, 64);
});

test('brand-neutral provider contract exposes stable anchors and matchable colors', () => {
  const provider = getPaletteProvider();
  assert.equal(provider.id, DEFAULT_PALETTE_PROVIDER_ID);
  assert.equal(PALETTE_PROVIDERS[provider.id], provider);
  assert.equal(provider.colors, PALETTE);
  assert.deepEqual(provider.anchors, { transparent: 'H1', white: 'H2', black: 'H7' });
  assert.equal(provider.colors.filter(provider.autoMatchable).length, 220);
  assert.equal(getPaletteProvider('not-a-real-provider'), provider);
});

test('full catalog extends the base with the exact six-series 70-code shape', () => {
  const counts = {};
  FULL_PALETTE.forEach((color) => { counts[color.series] = (counts[color.series] || 0) + 1; });
  assert.deepEqual(counts, { A: 26, B: 32, C: 29, D: 26, E: 24, F: 25, G: 21, H: 23, M: 15, P: 23, Q: 5, R: 28, T: 1, Y: 5, ZG: 8 });
  assert.equal(FULL_PALETTE.length, 291);
  assert.equal(new Set(FULL_PALETTE.map((color) => color.code)).size, 291);
});

test('full palette shares base entries by reference and marks T1 transparent', () => {
  assert.ok(FULL_PALETTE.slice(0, 221).every((color, index) => color === PALETTE[index]));
  const t1 = FULL_PALETTE.find((color) => color.code === 'T1');
  assert.equal(t1.isTransparent, true);
  assert.equal(t1.series, 'T');
  assert.equal(FULL_PALETTE.find((color) => color.code === 'ZG8').series, 'ZG');
  assert.equal(FULL_PALETTE[221].index, 221);
  assert.equal(FULL_PALETTE[290].index, 290);
});

test('full provider registers with 271 auto-matchable colors and stable anchors', () => {
  const provider = getPaletteProvider('mard-compatible-full-291');
  assert.equal(provider.id, 'mard-compatible-full-291');
  assert.equal(provider.labelKey, 'palette.provider291');
  assert.equal(provider.colors, FULL_PALETTE);
  assert.deepEqual([...provider.series], ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'M', 'P', 'Q', 'R', 'T', 'Y', 'ZG']);
  assert.deepEqual(provider.anchors, { transparent: 'H1', white: 'H2', black: 'H7' });
  const byCode = new Map(FULL_PALETTE.map((color) => [color.code, color]));
  assert.equal(provider.colors.filter(provider.autoMatchable).length, 271);
  for (const code of ['P1', 'P23', 'R1', 'R28', 'A1', 'M15', 'H2']) {
    assert.equal(provider.autoMatchable(byCode.get(code)), true, `${code} must auto-match`);
  }
  for (const code of ['Q1', 'Y1', 'ZG1', 'ZG8', 'T1', 'H1']) {
    assert.equal(provider.autoMatchable(byCode.get(code)), false, `${code} must not auto-match`);
  }
});

test('palette mode maps to provider ids and back', () => {
  assert.equal(providerIdForPaletteMode('mard221'), DEFAULT_PALETTE_PROVIDER_ID);
  assert.equal(providerIdForPaletteMode('mard291'), 'mard-compatible-full-291');
  assert.equal(providerIdForPaletteMode('bogus'), DEFAULT_PALETTE_PROVIDER_ID);
  assert.equal(paletteModeForProviderId(DEFAULT_PALETTE_PROVIDER_ID), 'mard221');
  assert.equal(paletteModeForProviderId('mard-compatible-full-291'), 'mard291');
  assert.equal(paletteModeForProviderId('unknown'), 'mard221');
  assert.equal(PALETTE_MODE_PROVIDER_IDS.mard291, 'mard-compatible-full-291');
});
