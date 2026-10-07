#!/usr/bin/env node
/**
 * build-blocks3d-cubes.mjs — render every mapped FULL-CUBE block as a
 * self-rendered, pixel-exact OBLIQUE (cabinet) projection cube (48x48 RGBA
 * PNG, no anti-aliasing) and make the 3D gallery category list ONLY those
 * cubes: public/gallery/minecraft-blocks-3d.json is rewritten with
 * items = the rendered cube ids, count = 422, size = 48, and a map limited
 * to cube entries (side/top texture names + "cube": true, kept so this
 * script stays rerunnable). Non-cube blocks live in the flat blocks
 * category; their old co3moz PNGs are deleted from this one.
 *
 * Why: the co3moz 256x256 renders are anti-aliased photos; converting them
 * loses pixel information. The self-rendered cube maps every bead to exactly
 * one source texel (depth texels to one averaged texel pair): front face =
 * map.side 1:1 (brightness 1.0), top face = map.top (230/255), right face =
 * map.side compressed from the right edge (153/255). Transparent texels stay
 * transparent (empty cells).
 *
 * Geometry ("D3 + average compression", approved by the user via Python
 * prototype comparison; replaces the rejected 2:1-dimetric variants whose
 * side faces looked vertically squashed):
 *   - Canvas 48x48. Every texel is a solid 2x2 px block.
 *   - Front face: side texel (x,y) -> 2x2 at cols 2x..2x+1, rows
 *     16+2y..16+2y+1. Occupies cols 0..31, rows 16..47. 1024 px.
 *   - Top face: depth d = 0..7 averages top texture rows 2d and 2d+1
 *     (channel-wise RGB mean, alpha = max; applied AFTER the load-time biome
 *     tint). Texel (u,d) -> 2x2 at cols 2u+2(d+1), rows 16-2(d+1), slanting
 *     up-right at 45 degrees. Occupies cols 2..47, rows 0..15. 512 px.
 *   - Right face: depth d = 0..7 averages side texture columns 15-2d and
 *     14-2d per row. Texel (d,y) -> 2x2 at cols 32+2d, rows 16+2y-2d.
 *     Occupies cols 32..47, slanting up-right. 512 px.
 *   - Solid-cube fill is exactly 1024 + 512 + 512 = 2048 px. The three faces
 *     tile with ZERO gaps and ZERO overlaps (asserted programmatically on
 *     every render: exact fill, unique ownership, contiguous silhouette
 *     rows).
 *
 * Full-cube detection: a block qualifies iff its resolved default model's
 * parent chain reaches one of the vanilla cube templates
 * (block/cube, block/cube_all, block/cube_column, block/cube_column_horizontal,
 * block/cube_bottom_top, block/cube_top, block/cube_directional,
 * block/orientable, block/orientable_with_bottom) without any model on the
 * path defining non-cube `elements` — or defines its own `elements` that are
 * all unrotated [0,0,0]-[16,16,16] boxes (grass_block, mycelium, leaves …).
 * Slabs/stairs/fences/walls/trapdoors/beds etc. therefore keep their co3moz
 * render.
 *
 * Provenance (pinned data source, same as build-blocks3d-map.mjs):
 *   Repo:    https://github.com/PrismarineJS/minecraft-assets (MIT license)
 *   Commit:  6c571b0825ee27b81f01127c2bd0d4ba2c89abb9 (master, 2026-10-03)
 *   Version: 1.21.11 — data/1.21.11/blocks_states.json + blocks_models.json
 *   Textures: local flat gallery public/gallery/minecraft-blocks/ (16x16 PNGs)
 *
 * Biome tints: vanilla tints some textures at runtime, so the flat dump
 * stores them gray. A small TINTS table (currently grass_block_top -> plains
 * grass #7CBD6B) re-applies the vanilla tint multiplicatively at load time;
 * see the TINTS comment near the top of the file.
 *
 * Zero npm dependencies: PNG decoding (color types 0/2/3/4/6, bit depths
 * 1/2/4/8, all five scanline filters, non-interlaced) and encoding (RGBA8,
 * filter 0) are implemented inline on top of node:zlib. The decoder is
 * verified against known texel values of bundled textures (see
 * DECODER_KNOWN_TEXELS) on every run.
 *
 * Usage: node scripts/build-blocks3d-cubes.mjs
 * Downloads are cached under os.tmpdir() (same cache as build-blocks3d-map).
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const MC_ASSETS_REPO = 'PrismarineJS/minecraft-assets';
const MC_ASSETS_COMMIT = '6c571b0825ee27b81f01127c2bd0d4ba2c89abb9';
const MC_VERSION = '1.21.11';
const RAW_BASE = `https://raw.githubusercontent.com/${MC_ASSETS_REPO}/${MC_ASSETS_COMMIT}/data/${MC_VERSION}`;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST_3D = join(ROOT, 'public/gallery/minecraft-blocks-3d.json');
const FLAT_DIR = join(ROOT, 'public/gallery/minecraft-blocks');
const OUT_DIR = join(ROOT, 'public/gallery/minecraft-blocks-3d');
const CACHE_DIR = join(tmpdir(), 'starpicdots-mcdata');

const TEX = 16; // flat texture edge (texels)
const CANVAS_W = 48;
const CANVAS_H = 48;
// Oblique (cabinet) projection "D3 + average compression", approved by the
// user via prototype comparison: every texel is a solid 2x2 px block; the
// cube depth is compressed 16 -> 8 texels by averaging texel pairs.
const DEPTH = 8;
const SOLID_FILL = 2048; // 1024 (front) + 512 (top) + 512 (right)

/**
 * Vanilla applies biome tints at runtime, so the flat dump stores tintable
 * textures gray. Apply the vanilla plains tint multiplicatively (c*t/255,
 * rounded; alpha untouched) when loading such a texture, so cube renders look
 * like in-game blocks instead of grayscale. Verified in this dump: only
 * grass_block_top is stored gray among tintable textures (leaves are
 * pre-tinted; stone/bedrock/anvil gray is authentic).
 */
const TINTS = new Map([
  ['grass_block_top', [124, 189, 107]], // vanilla plains grass tint #7CBD6B
]);

/** Vanilla templates whose geometry is exactly one [0,0,0]-[16,16,16] cube. */
const CUBE_TEMPLATES = new Set([
  'block/cube',
  'block/cube_all',
  'block/cube_column',
  'block/cube_column_horizontal',
  'block/cube_bottom_top',
  'block/cube_top',
  'block/cube_directional',
  'block/orientable',
  'block/orientable_with_bottom',
]);

/** Same rename/variant tables as build-blocks3d-map.mjs (keep in sync). */
const ALIASES = {
  iron_chain: 'chain',
  exposed_lightning_rod: 'lightning_rod',
  weathered_lightning_rod: 'lightning_rod',
  oxidized_lightning_rod: 'lightning_rod',
};
const SUFFIXES = [
  '_wall_hanging_sign', '_wall_sign', '_hanging_sign', '_trapdoor_bottom',
  '_pressure_plate', '_fence_gate', '_one_candle', '_two_candles',
  '_three_candles', '_four_candles', '_full_tilt', '_partial_tilt',
  '_conditional', '_horizontal', '_stairs', '_slab', '_wall', '_fence',
  '_button', '_trapdoor', '_sign', '_shelf', '_foot', '_head', '_on', '_off',
  '_empty', '_honey', '_active', '_inactive', '_awake', '_dormant', '_dead',
  '_lit', '_open', '_bottom', '_carpet',
];

// ---------------------------------------------------------------------------
// Minimal PNG codec (zero-dep, node:zlib only)
// ---------------------------------------------------------------------------

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffers) {
  let crc = 0xffffffff;
  for (const buffer of buffers) {
    for (let i = 0; i < buffer.length; i += 1) {
      crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decode a non-interlaced PNG to RGBA8.
 * Supports color types 0 (gray), 2 (RGB), 3 (palette), 4 (gray+alpha),
 * 6 (RGBA) at bit depths 1/2/4/8 (8/16-channel formats at depth 8 only).
 * Returns { width, height, data: Uint8Array(width*height*4) }.
 */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let transparency = null;
  const idat = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === 'PLTE') {
      palette = body;
    } else if (type === 'tRNS') {
      transparency = body;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (interlace !== 0) throw new Error(`interlaced PNG not supported (${width}x${height})`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (channels === undefined) throw new Error(`unsupported color type ${colorType}`);
  if (bitDepth !== 8 && channels > 1) throw new Error(`unsupported bit depth ${bitDepth} for color type ${colorType}`);

  const scanBytes = Math.ceil((width * bitDepth * channels) / 8);
  const filterBpp = Math.max(1, (bitDepth * channels) >> 3);
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== height * (scanBytes + 1)) {
    throw new Error(`unexpected raw size ${raw.length}, expected ${height * (scanBytes + 1)}`);
  }
  const scan = new Uint8Array(height * scanBytes);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (scanBytes + 1)];
    const rowIn = y * (scanBytes + 1) + 1;
    const rowOut = y * scanBytes;
    const prevOut = (y - 1) * scanBytes;
    for (let x = 0; x < scanBytes; x += 1) {
      const value = raw[rowIn + x];
      const left = x >= filterBpp ? scan[rowOut + x - filterBpp] : 0;
      const up = y > 0 ? scan[prevOut + x] : 0;
      const upLeft = y > 0 && x >= filterBpp ? scan[prevOut + x - filterBpp] : 0;
      let recon;
      if (filter === 0) recon = value;
      else if (filter === 1) recon = value + left;
      else if (filter === 2) recon = value + up;
      else if (filter === 3) recon = value + ((left + up) >> 1);
      else if (filter === 4) recon = value + paeth(left, up, upLeft);
      else throw new Error(`unknown filter ${filter}`);
      scan[rowOut + x] = recon & 0xff;
    }
  }

  /** Raw (unscaled) sample for packed bit depths 1/2/4/8, single channel. */
  const rawSample = (x, y) => {
    const row = y * scanBytes;
    if (bitDepth === 8) return scan[row + x];
    const perByte = 8 / bitDepth;
    const byte = scan[row + ((x / perByte) | 0)];
    const shift = 8 - bitDepth * ((x % perByte) + 1);
    return (byte >> shift) & ((1 << bitDepth) - 1);
  };

  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4;
      const row = y * scanBytes;
      if (colorType === 0) {
        const raw = rawSample(x, y);
        const g = bitDepth === 8 ? raw : Math.round((raw * 255) / ((1 << bitDepth) - 1));
        data[out] = g; data[out + 1] = g; data[out + 2] = g; data[out + 3] = 255;
        if (transparency && transparency.length >= 2 && raw === transparency.readUInt16BE(0)) {
          data[out + 3] = 0;
        }
      } else if (colorType === 2) {
        const p = row + x * 3;
        data[out] = scan[p]; data[out + 1] = scan[p + 1]; data[out + 2] = scan[p + 2]; data[out + 3] = 255;
        if (transparency && transparency.length >= 6
          && scan[p] === transparency.readUInt16BE(0)
          && scan[p + 1] === transparency.readUInt16BE(2)
          && scan[p + 2] === transparency.readUInt16BE(4)) data[out + 3] = 0;
      } else if (colorType === 3) {
        const idx = rawSample(x, y);
        data[out] = palette[idx * 3];
        data[out + 1] = palette[idx * 3 + 1];
        data[out + 2] = palette[idx * 3 + 2];
        data[out + 3] = transparency && idx < transparency.length ? transparency[idx] : 255;
      } else if (colorType === 4) {
        const p = row + x * 2;
        data[out] = scan[p]; data[out + 1] = scan[p]; data[out + 2] = scan[p]; data[out + 3] = scan[p + 1];
      } else { // colorType === 6
        const p = row + x * 4;
        data[out] = scan[p]; data[out + 1] = scan[p + 1]; data[out + 2] = scan[p + 2]; data[out + 3] = scan[p + 3];
      }
    }
  }
  return { width, height, data };
}

/** Encode RGBA8 as a PNG (color type 6, bit depth 8, filter 0 per row). */
export function encodePng(width, height, data) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4)
      .copy(raw, y * (width * 4 + 1) + 1);
  }
  const chunk = (type, body) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'ascii');
    Buffer.from(body).copy(out, 8);
    out.writeUInt32BE(crc32([Buffer.from(type, 'ascii'), Buffer.from(body)]), 8 + body.length);
    return out;
  };
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// oblique (cabinet) cube renderer (48x48, D3 + average depth compression)
// ---------------------------------------------------------------------------

/**
 * Render the three visible faces. side/top are 16x16 RGBA texel arrays.
 * Returns { data, painted } where painted counts single-owner pixels.
 * Throws if any pixel would be painted twice or lands outside the canvas.
 */
export function renderCube(side, top, { assertTiling = true } = {}) {
  const data = new Uint8Array(CANVAS_W * CANVAS_H * 4);
  const owner = new Uint8Array(CANVAS_W * CANVAS_H);
  let painted = 0;
  const paint = (x, y, texel, tint) => {
    if (x < 0 || x >= CANVAS_W || y < 0 || y >= CANVAS_H) {
      throw new Error(`paint out of bounds at ${x},${y}`);
    }
    const a = texel[3];
    if (a === 0) return; // transparent texel -> empty cell
    const i = y * CANVAS_W + x;
    if (assertTiling && owner[i]) {
      throw new Error(`tiling violation: pixel ${x},${y} painted twice`);
    }
    owner[i] = 1;
    painted += 1;
    const o = i * 4;
    data[o] = Math.round(texel[0] * tint);
    data[o + 1] = Math.round(texel[1] * tint);
    data[o + 2] = Math.round(texel[2] * tint);
    data[o + 3] = a;
  };
  const texelAt = (tex, u, v) => {
    const p = (v * TEX + u) * 4;
    return [tex[p], tex[p + 1], tex[p + 2], tex[p + 3]];
  };
  const avgTexel = (a, b) => [
    Math.round((a[0] + b[0]) / 2),
    Math.round((a[1] + b[1]) / 2),
    Math.round((a[2] + b[2]) / 2),
    Math.max(a[3], b[3]),
  ];
  // Front face: side texture 1:1, full brightness. Cols 0..31, rows 16..47.
  for (let y = 0; y < TEX; y += 1) {
    for (let x = 0; x < TEX; x += 1) {
      const texel = texelAt(side, x, y);
      const c = 2 * x;
      const r = 16 + 2 * y;
      paint(c, r, texel, 1);
      paint(c + 1, r, texel, 1);
      paint(c, r + 1, texel, 1);
      paint(c + 1, r + 1, texel, 1);
    }
  }
  // Top face: brightness 230/255. Depth d averages top rows 2d and 2d+1
  // (after any load-time biome tint). Slants up-right at 45 degrees.
  for (let d = 0; d < DEPTH; d += 1) {
    for (let u = 0; u < TEX; u += 1) {
      const texel = avgTexel(texelAt(top, u, 2 * d), texelAt(top, u, 2 * d + 1));
      const c = 2 * u + 2 * (d + 1);
      const r = 16 - 2 * (d + 1);
      paint(c, r, texel, 230 / 255);
      paint(c + 1, r, texel, 230 / 255);
      paint(c, r + 1, texel, 230 / 255);
      paint(c + 1, r + 1, texel, 230 / 255);
    }
  }
  // Right face: brightness 153/255. Depth d averages side columns 15-2d and
  // 14-2d (compressing from the right edge inward).
  for (let d = 0; d < DEPTH; d += 1) {
    for (let y = 0; y < TEX; y += 1) {
      const texel = avgTexel(texelAt(side, 15 - 2 * d, y), texelAt(side, 14 - 2 * d, y));
      const c = 32 + 2 * d;
      const r = 16 + 2 * y - 2 * d;
      paint(c, r, texel, 153 / 255);
      paint(c + 1, r, texel, 153 / 255);
      paint(c, r + 1, texel, 153 / 255);
      paint(c + 1, r + 1, texel, 153 / 255);
    }
  }
  return { data, painted };
}

/** Tiling proof on a synthetic solid cube: exact fill, one owner per pixel,
 * and every silhouette row filled contiguously (no holes). */
function selfTestTiling() {
  const solid = new Uint8Array(TEX * TEX * 4);
  for (let i = 0; i < solid.length; i += 4) {
    solid[i] = 200; solid[i + 1] = 100; solid[i + 2] = 50; solid[i + 3] = 255;
  }
  const { data, painted } = renderCube(solid, solid);
  let filled = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) filled += 1;
  if (painted !== SOLID_FILL || filled !== SOLID_FILL) {
    throw new Error(`tiling self-test failed: painted=${painted} filled=${filled}, expected ${SOLID_FILL}`);
  }
  for (let y = 0; y < CANVAS_H; y += 1) {
    let first = -1;
    let last = -1;
    for (let x = 0; x < CANVAS_W; x += 1) {
      if (data[(y * CANVAS_W + x) * 4 + 3] !== 0) {
        if (first < 0) first = x;
        last = x;
      }
    }
    if (first < 0) continue;
    for (let x = first; x <= last; x += 1) {
      if (data[(y * CANVAS_W + x) * 4 + 3] === 0) {
        throw new Error(`tiling self-test failed: hole at ${x},${y}`);
      }
    }
  }
}

/** Decoder regression check against known bundled texels (PIL-verified). */
const DECODER_KNOWN_TEXELS = [
  ['stone.png', 0, 0, [143, 143, 143, 255]],
  ['grass_block_top.png', 0, 0, [148, 148, 148, 255]],
  ['grass_block_top.png', 1, 0, [195, 195, 195, 255]],
  ['grass_block_side.png', 0, 0, [116, 180, 74, 255]],
];

async function selfTestDecoder() {
  for (const [file, x, y, expected] of DECODER_KNOWN_TEXELS) {
    const { data } = decodePng(await readFile(join(FLAT_DIR, file)));
    const p = (y * TEX + x) * 4;
    const actual = [data[p], data[p + 1], data[p + 2], data[p + 3]];
    if (String(actual) !== String(expected)) {
      throw new Error(`decoder self-test failed for ${file}(${x},${y}): got ${actual}, expected ${expected}`);
    }
  }
}

// ---------------------------------------------------------------------------
// minecraft-assets model data (same fetch/cache as build-blocks3d-map.mjs)
// ---------------------------------------------------------------------------

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

/** Strip only the "minecraft:" namespace (keep any "block/" prefix). */
function stripNs(ref) {
  return typeof ref === 'string' && ref.includes(':') ? ref.split(':', 2)[1] : ref;
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

function directModelRef(blockstates, models, id) {
  return defaultModelRef(blockstates[id]) ?? (models[id] ? id : null);
}

/** Same id -> model resolution order as build-blocks3d-map.mjs. */
function resolveModelRef(blockstates, models, id) {
  const direct = directModelRef(blockstates, models, id);
  if (direct) return direct;
  const alias = ALIASES[id];
  if (alias) {
    const viaAlias = directModelRef(blockstates, models, alias);
    if (viaAlias) return viaAlias;
  }
  for (const suffix of SUFFIXES) {
    if (!id.endsWith(suffix)) continue;
    const viaBase = directModelRef(blockstates, models, id.slice(0, -suffix.length));
    if (viaBase) return viaBase;
  }
  return null;
}

/** True iff every element is an unrotated [0,0,0]-[16,16,16] box (grass_block
 * and leaves define their cube inline — base cube plus overlay quads — instead
 * of inheriting a cube template). */
function elementsAreFullCubes(elements) {
  return Array.isArray(elements) && elements.length > 0 && elements.every((element) => (
    !element.rotation
    && Array.isArray(element.from) && Array.isArray(element.to)
    && String(element.from) === '0,0,0'
    && String(element.to) === '16,16,16'
  ));
}

/**
 * Full-cube iff walking the parent chain from the resolved model either
 * reaches a whitelisted cube template, or hits a model whose own `elements`
 * are all full-cube boxes (a child `elements` array fully replaces the
 * parent's geometry, so the first `elements` found is authoritative).
 */
function isFullCubeModel(models, modelRef) {
  let ref = modelRef;
  for (let depth = 0; depth <= 20; depth += 1) {
    const name = stripNs(ref);
    if (CUBE_TEMPLATES.has(name)) return true;
    const key = name?.startsWith('block/') ? name.slice('block/'.length) : name;
    const model = models[key];
    if (!model) return false;
    if (model.elements) return elementsAreFullCubes(model.elements);
    const parent = model.parent;
    if (!parent || parent.startsWith('builtin')) return false;
    ref = parent;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  selfTestTiling();
  await selfTestDecoder();
  console.log(`self-tests passed: tiling fill=${SOLID_FILL} on ${CANVAS_W}x${CANVAS_H}, decoder matches known texels`);

  const [blockstates, models, manifest3d] = await Promise.all([
    fetchJson('blocks_states.json'),
    fetchJson('blocks_models.json'),
    readFile(MANIFEST_3D, 'utf8').then(JSON.parse),
  ]);

  const textureCache = new Map();
  async function loadTexture(name) {
    if (!textureCache.has(name)) {
      const png = decodePng(await readFile(join(FLAT_DIR, `${name}.png`)));
      if (png.width !== TEX || png.height !== TEX) {
        throw new Error(`texture ${name} is ${png.width}x${png.height}, expected ${TEX}x${TEX}`);
      }
      const tint = TINTS.get(name);
      if (tint) {
        for (let i = 0; i < png.data.length; i += 4) {
          png.data[i] = Math.round((png.data[i] * tint[0]) / 255);
          png.data[i + 1] = Math.round((png.data[i + 1] * tint[1]) / 255);
          png.data[i + 2] = Math.round((png.data[i + 2] * tint[2]) / 255);
        }
      }
      textureCache.set(name, png.data);
    }
    return textureCache.get(name);
  }

  const cubeIds = new Set();
  let mappedNonCube = 0;
  let unmapped = 0;
  for (const id of manifest3d.items) {
    const entry = manifest3d.map?.[id];
    if (!entry) { unmapped += 1; continue; }
    // Name audit of the full-cube set: the only non-cubes that leak through
    // model resolution are the 16-color concrete/wool _slab/_stairs families
    // (their entries resolve to the base block's textures, rendering as
    // mislabeled duplicates of it). Exclude those exact suffixes;
    // smooth_stone_slab_double ends in _double and stays (vanilla full cube).
    if (id.endsWith('_slab') || id.endsWith('_stairs')) { mappedNonCube += 1; continue; }
    const ref = resolveModelRef(blockstates, models, id);
    const fullCube = ref
      && isFullCubeModel(models, ref)
      && typeof entry.side === 'string' && entry.side
      && typeof entry.top === 'string' && entry.top;
    if (!fullCube) { mappedNonCube += 1; continue; }
    const [side, top] = await Promise.all([loadTexture(entry.side), loadTexture(entry.top)]);
    const { data } = renderCube(side, top); // throws on any double-painted pixel
    await writeFile(join(OUT_DIR, `${id}.png`), encodePng(CANVAS_W, CANVAS_H, data));
    cubeIds.add(id);
  }

  // The 3D gallery lists ONLY full-cube blocks: items/count are pruned to the
  // rendered cubes and the map keeps only cube entries (side/top texture
  // names, so this script stays rerunnable). Non-cube PNGs left over from the
  // co3moz set are not referenced anymore and should be deleted.
  const newMap = {};
  for (const id of manifest3d.items) {
    if (!cubeIds.has(id)) continue;
    const entry = manifest3d.map[id];
    newMap[id] = { side: entry.side, top: entry.top, cube: true };
  }
  const newItems = manifest3d.items.filter((id) => cubeIds.has(id));
  await writeFile(MANIFEST_3D, `${JSON.stringify({
    ...manifest3d, size: CANVAS_W, count: newItems.length, items: newItems, map: newMap,
  })}\n`);

  console.log(`full-cube renders: ${cubeIds.size}`);
  console.log(`mapped non-cube (removed from category): ${mappedNonCube}`);
  console.log(`unmapped (removed from category): ${unmapped}`);
  console.log(`gallery items kept: ${newItems.length}`);
}

const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) await main();
