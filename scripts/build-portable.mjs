import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const release = join(root, 'release');
let html = await readFile(join(dist, 'index.html'), 'utf8');

const stylesheet = html.match(/<link rel="stylesheet" crossorigin href="([^"]+)">/);
const moduleScript = html.match(/<script type="module" crossorigin src="([^"]+)"><\/script>/);
if (!stylesheet || !moduleScript) throw new Error('Unable to locate Vite build assets.');

const resolveAsset = (href) => join(dist, href.replace(/^\.\//, ''));
const [css, js, license, notice, iconSvg] = await Promise.all([
  readFile(resolveAsset(stylesheet[1]), 'utf8'),
  readFile(resolveAsset(moduleScript[1]), 'utf8'),
  readFile(join(root, 'LICENSE'), 'utf8'),
  readFile(join(root, 'NOTICE'), 'utf8'),
  readFile(join(root, 'public', 'app-icon.svg'), 'utf8'),
]);
const iconDataUri = `data:image/svg+xml,${encodeURIComponent(iconSvg.trim())}`;

const SITE_URL = 'https://ryanliying.github.io/starpicdots/';
const REPO_URL = 'https://github.com/RyanLiying/starpicdots';

const normalizeText = (value) => value.replace(/\r\n?/g, '\n');
const asInertText = (value) => normalizeText(value).replace(/<\/script/gi, '<\\/script');
const embeddedLegal = [
  '<!-- The following non-executable blocks make the portable file license-complete offline. -->',
  `<script type="text/plain" id="bead-grid-studio-license">\n${asInertText(license)}\n</script>`,
  `<script type="text/plain" id="bead-grid-studio-third-party-notices">\n${asInertText(notice)}\n</script>`,
].join('\n');

html = html
  .replace(stylesheet[0], `<style>\n${css}\n</style>`)
  .replace(moduleScript[0], `<script type="module">\n${js}\n</script>`)
  .replace(/\s*<link rel="manifest"[^>]*>/, '')
  .replaceAll('href="./privacy.html"', `href="${SITE_URL}privacy.html"`)
  .replaceAll('href="./privacy.en.html"', `href="${SITE_URL}privacy.en.html"`)
  .replaceAll('href="./terms.html"', `href="${SITE_URL}terms.html"`)
  .replaceAll('href="./terms.en.html"', `href="${SITE_URL}terms.en.html"`)
  .replaceAll('href="./LICENSE.txt"', `href="${REPO_URL}/blob/main/LICENSE"`)
  .replaceAll('href="./NOTICE.txt"', `href="${REPO_URL}/blob/main/NOTICE"`)
  .replaceAll('href="./version.json"', `href="${SITE_URL}version.json"`)
  .replace('href="./app-icon.svg"', `href="${iconDataUri}"`)
  .replace('src="./app-icon.svg"', `src="${iconDataUri}"`)
  .replace('</body>', `${embeddedLegal}\n</body>`);

if (/<script[^>]+src=/i.test(html) || /<link[^>]+rel="stylesheet"/i.test(html)) {
  throw new Error('Portable release still depends on an external script or stylesheet.');
}
if (html.includes('href="./LICENSE.txt"')) {
  throw new Error('Portable release contains a broken relative license link.');
}
if (!html.includes('Apache License')
  || !html.includes('pinned data commit 94b99999652866f1a1879d6369fe735f811949e5')
  || !html.includes('Copyright (c) 2020 maxcleme')
  || !html.includes('Copyright (c) 2019-present, VoidZero Inc. and Vite contributors')) {
  throw new Error('Portable release is missing embedded license or third-party notices.');
}
const removedReferenceTerms = ['Zip' + 'pland', 'perler' + '-beads', 'AG' + 'PL', 'Aff' + 'ero'];
if (removedReferenceTerms.some((term) => html.toLowerCase().includes(term.toLowerCase()))) {
  throw new Error('Portable release contains a removed project-reference term.');
}

await mkdir(release, { recursive: true });
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const output = join(release, `starpicdots-v${version}.html`);
await writeFile(output, html, 'utf8');
const bytes = Buffer.from(html);
const digest = createHash('sha256').update(bytes).digest('hex').toUpperCase();
await writeFile(join(release, 'SHA256SUMS.txt'), `${digest}  ${basename(output)}\n`, 'utf8');
console.log(`Portable release: ${output} (${bytes.length} bytes, SHA-256 ${digest})`);
