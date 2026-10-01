import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { FULL_PALETTE, PALETTE } from '../src/palettes/mard221.js';

const SOURCE_PATH = 'src/palettes/provenance/mard-291.csv';
const EXPECTED_SHA256 = '898BBEAC2C2BCF41E5293554E46545F42628FBD2CB2BC3E3C9313C889DBBE700';
const SERIES_ORDER = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'M', 'P', 'Q', 'R', 'T', 'Y', 'ZG'];
const BASE_SERIES = new Set(SERIES_ORDER.slice(0, 9));
const codeSeries = (code) => (code.startsWith('ZG') ? 'ZG' : code[0]);

const source = await readFile(SOURCE_PATH);
const sha256 = createHash('sha256').update(source).digest('hex').toUpperCase();
if (sha256 !== EXPECTED_SHA256) {
  throw new Error(`${SOURCE_PATH} SHA-256 mismatch: ${sha256}`);
}

const rows = source.toString('utf8').trim().split(/\r?\n/).map((line, index) => {
  const [code, name, r, g, b, hex, contributor] = line.split(',');
  if (!code || !hex || !contributor) throw new Error(`Malformed palette row ${index + 1}`);
  return { code, name, r: Number(r), g: Number(g), b: Number(b), hex: hex.toUpperCase(), contributor };
});

if (rows.length !== 291) throw new Error(`Expected 291 source rows, found ${rows.length}`);

const naturalCodeOrder = (left, right) => {
  const leftSeries = codeSeries(left.code);
  const rightSeries = codeSeries(right.code);
  return SERIES_ORDER.indexOf(leftSeries) - SERIES_ORDER.indexOf(rightSeries)
    || Number(left.code.replace(/^(?:ZG|[A-Z])/, '')) - Number(right.code.replace(/^(?:ZG|[A-Z])/, ''));
};

const upstreamBase = rows
  .filter((row) => BASE_SERIES.has(codeSeries(row.code)))
  .sort(naturalCodeOrder);
const localBase = [...PALETTE].sort(naturalCodeOrder);

if (upstreamBase.length !== 221 || localBase.length !== 221) {
  throw new Error(`Expected 221 base colors, found upstream=${upstreamBase.length}, local=${localBase.length}`);
}

for (let index = 0; index < upstreamBase.length; index += 1) {
  const upstream = upstreamBase[index];
  const local = localBase[index];
  if (local.code !== upstream.code || local.hex.toUpperCase() !== upstream.hex) {
    throw new Error(`Palette mismatch at ${index}: local ${local.code} ${local.hex}, upstream ${upstream.code} ${upstream.hex}`);
  }
}

const upstreamFull = [...rows].sort(naturalCodeOrder);
const localFull = [...FULL_PALETTE].sort(naturalCodeOrder);

if (upstreamFull.length !== 291 || localFull.length !== 291) {
  throw new Error(`Expected 291 full colors, found upstream=${upstreamFull.length}, local=${localFull.length}`);
}

for (let index = 0; index < upstreamFull.length; index += 1) {
  const upstream = upstreamFull[index];
  const local = localFull[index];
  if (local.code !== upstream.code || local.hex.toUpperCase() !== upstream.hex) {
    throw new Error(`Full palette mismatch at ${index}: local ${local.code} ${local.hex}, upstream ${upstream.code} ${upstream.hex}`);
  }
}

console.log(`Palette provenance passed: ${rows.length} pinned rows, ${localBase.length} verified base colors, ${localFull.length} verified full colors, SHA-256 ${sha256}.`);
