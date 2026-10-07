#!/usr/bin/env node
/**
 * build-blocks3d-map.mjs — regenerate the "map" field of
 * public/gallery/minecraft-blocks-3d.json.
 *
 * The 3D gallery category ships 256x256 pre-rendered isometric PNGs that are
 * great for recognition but mushy when converted directly. This script maps
 * each 3D block id to the block's official FLAT 16x16 face texture(s)
 * ({ "<blockId>": { "side": "<tex>", "top": "<tex>" } }) so the app can
 * convert the flat texture pixel-exactly (1 texel = 1 bead) instead.
 *
 * Provenance (pinned data source):
 *   Repo:    https://github.com/PrismarineJS/minecraft-assets (MIT license)
 *   Commit:  6c571b0825ee27b81f01127c2bd0d4ba2c89abb9 (master, 2026-10-03)
 *   Version: 1.21.11 — chosen by scoring every published data/<version> for
 *            (a) blockstates coverage of our 993 gallery ids and
 *            (b) resolved texture names present in public/gallery/minecraft-blocks.json.
 *            1.21.9/1.21.10/1.21.11 tie at the maximum on both metrics
 *            (854/993 blockstate-or-model hits, 877/993 resolved with the
 *            alias table below); the resolved map is byte-identical for every
 *            version from 1.21.1 through 1.21.11.
 *   Files:   data/1.21.11/blocks_states.json  (block id -> blockstate JSON)
 *            data/1.21.11/blocks_models.json  (model name -> model JSON)
 *   Raw URLs:
 *     https://raw.githubusercontent.com/PrismarineJS/minecraft-assets/6c571b0825ee27b81f01127c2bd0d4ba2c89abb9/data/1.21.11/blocks_states.json
 *     https://raw.githubusercontent.com/PrismarineJS/minecraft-assets/6c571b0825ee27b81f01127c2bd0d4ba2c89abb9/data/1.21.11/blocks_models.json
 *
 * Resolution algorithm per gallery id:
 *   1. blockstates/<id> default (or first) variant -> model name; multipart
 *      blockstates use the first part's model. If the id is not a blockstate
 *      key but IS a model name (the 3D pack used model names such as
 *      "acacia_log_horizontal"), resolve the model directly.
 *   2. Walk the model `parent` chain (block/cube_all, block/cube_column,
 *      block/cube, block/cross, block/template_*), merging `textures`
 *      child-over-parent and resolving "#var" indirections.
 *   3. side := first of side|north|all|cross|plant|texture|particle|end|top|bottom|up
 *      top  := first of top|end|up|all|cross|plant|texture|particle|side|north|bottom
 *      (cube_all -> side=top='all'; cube_column logs -> side/top='end';
 *      cross plants -> side=top='cross' sprite).
 *   4. Strip "minecraft:" namespace and "block/" prefix -> bare texture name.
 *   5. Variant-name fallback: ids like "black_concrete_slab" or
 *      "blast_furnace_on" (renders of block variants that have no own model)
 *      are stripped of a known suffix and resolved via the base block.
 *   6. Keep the entry only if side or top exists in the flat manifest
 *      (minecraft-blocks.json); everything else falls back to converting the
 *      3D render itself at runtime.
 *
 * Known renames in newer game data (documented aliases):
 *   iron_chain -> chain (block renamed in 1.21.9), and the oxidizing
 *   lightning rod variants share the vanilla lightning_rod texture.
 *
 * Usage: node scripts/build-blocks3d-map.mjs
 * No npm dependencies; downloads are cached under os.tmpdir().
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MC_ASSETS_REPO = 'PrismarineJS/minecraft-assets';
const MC_ASSETS_COMMIT = '6c571b0825ee27b81f01127c2bd0d4ba2c89abb9';
const MC_VERSION = '1.21.11';
const RAW_BASE = `https://raw.githubusercontent.com/${MC_ASSETS_REPO}/${MC_ASSETS_COMMIT}/data/${MC_VERSION}`;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST_3D = join(ROOT, 'public/gallery/minecraft-blocks-3d.json');
const MANIFEST_FLAT = join(ROOT, 'public/gallery/minecraft-blocks.json');
const CACHE_DIR = join(tmpdir(), 'starpicdots-mcdata');

/** Newer-game renames whose texture exists in our flat dump under the old name. */
const ALIASES = {
  iron_chain: 'chain',
  exposed_lightning_rod: 'lightning_rod',
  weathered_lightning_rod: 'lightning_rod',
  oxidized_lightning_rod: 'lightning_rod',
};

/** Suffixes of variant-render names that resolve via their base block. */
const SUFFIXES = [
  '_wall_hanging_sign', '_wall_sign', '_hanging_sign', '_trapdoor_bottom',
  '_pressure_plate', '_fence_gate', '_one_candle', '_two_candles',
  '_three_candles', '_four_candles', '_full_tilt', '_partial_tilt',
  '_conditional', '_horizontal', '_stairs', '_slab', '_wall', '_fence',
  '_button', '_trapdoor', '_sign', '_shelf', '_foot', '_head', '_on', '_off',
  '_empty', '_honey', '_active', '_inactive', '_awake', '_dormant', '_dead',
  '_lit', '_open', '_bottom', '_carpet',
];

const SIDE_KEYS = ['side', 'north', 'all', 'cross', 'plant', 'texture', 'particle', 'end', 'top', 'bottom', 'up'];
const TOP_KEYS = ['top', 'end', 'up', 'all', 'cross', 'plant', 'texture', 'particle', 'side', 'north', 'bottom'];

async function fetchJson(name) {
  await mkdir(CACHE_DIR, { recursive: true });
  const cachePath = join(CACHE_DIR, `${MC_VERSION}-${name}`);
  if (existsSync(cachePath)) {
    try { return JSON.parse(await readFile(cachePath, 'utf8')); } catch { /* refetch */ }
  }
  const url = `${RAW_BASE}/${name}`;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      JSON.parse(text); // validate before caching
      await writeFile(cachePath, text);
      return JSON.parse(text);
    } catch (error) { lastError = error; }
  }
  throw new Error(`Failed to fetch ${url}: ${lastError}`);
}

function stripNamespace(ref) {
  if (typeof ref !== 'string') return null;
  let out = ref.includes(':') ? ref.split(':', 2)[1] : ref;
  if (out.startsWith('block/')) out = out.slice('block/'.length);
  return out;
}

function resolveTexture(textures, name, depth = 0) {
  let value = textures[name];
  if (value == null) return null;
  if (typeof value === 'object') value = value.sprite; // 26.1+ {sprite, force_translucent}
  if (typeof value !== 'string' || depth > 10) return null;
  if (value.startsWith('#')) return resolveTexture(textures, value.slice(1), depth + 1);
  return stripNamespace(value);
}

/** Merge textures from the model's parent chain, child overriding parent. */
function modelTextures(models, modelName, depth = 0) {
  if (depth > 20) return {};
  const model = models[stripNamespace(modelName)];
  if (!model) return {};
  const parent = model.parent;
  const merged = parent && !parent.startsWith('builtin')
    ? modelTextures(models, parent, depth + 1)
    : {};
  return { ...merged, ...(model.textures || {}) };
}

function facesFromTextures(textures) {
  const pick = keys => {
    for (const key of keys) {
      const resolved = resolveTexture(textures, key);
      if (resolved) return resolved;
    }
    return null;
  };
  return { side: pick(SIDE_KEYS), top: pick(TOP_KEYS) };
}

function defaultModelRef(blockstate) {
  if (!blockstate) return null;
  if (blockstate.variants) {
    const variants = blockstate.variants;
    const keys = '' in variants ? [''] : Object.keys(variants).sort();
    let variant = variants[keys[0]];
    if (Array.isArray(variant)) variant = variant[0];
    return variant?.model ?? null;
  }
  if (blockstate.multipart) {
    for (const part of blockstate.multipart) {
      let apply = part.apply;
      if (Array.isArray(apply)) apply = apply[0];
      if (apply?.model) return apply.model;
    }
  }
  return null;
}

function resolveId(blockstates, models, id) {
  const ref = defaultModelRef(blockstates[id]) ?? (models[id] ? id : null);
  if (!ref) return null;
  return facesFromTextures(modelTextures(models, ref));
}

function resolveWithFallback(blockstates, models, id) {
  const alias = ALIASES[id];
  const direct = resolveId(blockstates, models, id)
    || (alias ? resolveId(blockstates, models, alias) : null);
  if (direct) return direct;
  for (const suffix of SUFFIXES) {
    if (!id.endsWith(suffix)) continue;
    const resolved = resolveId(blockstates, models, id.slice(0, -suffix.length));
    if (resolved) return resolved;
  }
  return null;
}

const [blockstates, models, manifest3d, manifestFlat] = await Promise.all([
  fetchJson('blocks_states.json'),
  fetchJson('blocks_models.json'),
  readFile(MANIFEST_3D, 'utf8').then(JSON.parse),
  readFile(MANIFEST_FLAT, 'utf8').then(JSON.parse),
]);

const flatNames = new Set(manifestFlat.items);
const map = {};
for (const id of manifest3d.items) {
  const faces = resolveWithFallback(blockstates, models, id);
  if (!faces) continue;
  let { side, top } = faces;
  // Renamed blocks: swap to the alias texture our flat dump actually ships.
  if (ALIASES[id] && flatNames.has(ALIASES[id])) {
    if (side && !flatNames.has(side)) side = ALIASES[id];
    if (top && !flatNames.has(top)) top = ALIASES[id];
  }
  if (!flatNames.has(side) && !flatNames.has(top)) continue;
  map[id] = { side, top };
}

const output = { ...manifest3d, map };
const json = JSON.stringify(output);
await writeFile(MANIFEST_3D, `${json}\n`);

const total = manifest3d.items.length;
const resolved = Object.keys(map).length;
console.log(`minecraft-assets ${MC_VERSION} @ ${MC_ASSETS_COMMIT.slice(0, 7)}`);
console.log(`mapped ${resolved}/${total} blocks (${((resolved / total) * 100).toFixed(1)}%)`);
console.log(`map sha-256 ${createHash('sha256').update(JSON.stringify(map)).digest('hex')}`);
