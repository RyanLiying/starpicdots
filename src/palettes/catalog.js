import { FULL_PALETTE, MARD_EXTENDED_SERIES, MARD_PALETTE_SOURCE, MARD_SERIES, PALETTE } from './mard221.js';

/**
 * Versioned palette-provider registry.
 *
 * The UI and conversion engine consume this contract instead of treating a
 * manufacturer name as an application-wide identity. Future providers must
 * bring their own documented, licensed color data; this registry must never
 * imply a brand relationship or invent cross-brand code mappings.
 */
export const DEFAULT_PALETTE_PROVIDER_ID = 'mard-compatible-base-221';

const mardCompatibleBase221 = Object.freeze({
  id: DEFAULT_PALETTE_PROVIDER_ID,
  labelKey: 'palette.provider',
  colors: PALETTE,
  source: MARD_PALETTE_SOURCE,
  series: Object.freeze(Object.keys(MARD_SERIES)),
  anchors: Object.freeze({ transparent: 'H1', white: 'H2', black: 'H7' }),
  autoMatchable: (color) => !color.isTransparent,
});

const mardCompatibleFull291 = Object.freeze({
  id: 'mard-compatible-full-291',
  labelKey: 'palette.provider291',
  colors: FULL_PALETTE,
  source: MARD_PALETTE_SOURCE,
  series: Object.freeze([...Object.keys(MARD_SERIES), ...Object.keys(MARD_EXTENDED_SERIES)]),
  anchors: Object.freeze({ transparent: 'H1', white: 'H2', black: 'H7' }),
  // Special-effect HEX approximations (Q/Y/ZG) and transparent beads never auto-match.
  autoMatchable: (color) =>
    !color.isTransparent
    && (Object.hasOwn(MARD_SERIES, color.series) || color.series === 'P' || color.series === 'R'),
});

export const PALETTE_PROVIDERS = Object.freeze({
  [mardCompatibleBase221.id]: mardCompatibleBase221,
  [mardCompatibleFull291.id]: mardCompatibleFull291,
});

export const PALETTE_MODE_PROVIDER_IDS = Object.freeze({
  mard221: DEFAULT_PALETTE_PROVIDER_ID,
  mard291: mardCompatibleFull291.id,
});

export function providerIdForPaletteMode(mode) {
  return PALETTE_MODE_PROVIDER_IDS[mode] || DEFAULT_PALETTE_PROVIDER_ID;
}

export function paletteModeForProviderId(id) {
  return id === mardCompatibleFull291.id ? 'mard291' : 'mard221';
}

export function getPaletteProvider(id = DEFAULT_PALETTE_PROVIDER_ID) {
  return PALETTE_PROVIDERS[id] || mardCompatibleBase221;
}
