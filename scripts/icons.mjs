import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ico } from './ico.mjs';

/**
 * Renders the app icons from one SVG source.
 *
 * Home-screen icons must be PNG — iOS ignores SVG for apple-touch-icon, and
 * Android's maskable icons need real raster output. Generating them from a
 * single source keeps the compass mark identical everywhere instead of drifting
 * between hand-exported files.
 *
 * Run with `npm run icons` after installing playwright; the PNGs are committed
 * so a normal install and build never need a browser.
 */

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
mkdirSync(out, { recursive: true });

const NAVY = '#0b0e14';
const BLUE = '#5b8bff';

/** `inset` shrinks the mark for maskable icons, whose outer ~20% can be cropped. */
const svg = (inset = 0) => {
  const s = 1 - inset;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${NAVY}"/>
  <g transform="translate(256 256) scale(${s}) translate(-256 -256)">
    <circle cx="256" cy="256" r="176" fill="none" stroke="${BLUE}" stroke-width="26"/>
    <path d="M344 168l-51 125-125 51 51-125z" fill="${BLUE}"/>
    <circle cx="256" cy="256" r="26" fill="${NAVY}"/>
  </g>
</svg>`;
};

const targets = [
  { file: 'icon-192.png', size: 192, inset: 0 },
  { file: 'icon-512.png', size: 512, inset: 0 },
  { file: 'icon-maskable-512.png', size: 512, inset: 0.22 },
  // iOS rounds the corners itself and composites onto black if the image has
  // any transparency, so this one is deliberately full-bleed and opaque.
  { file: 'apple-touch-icon.png', size: 180, inset: 0.06 },
  { file: 'favicon-32.png', size: 32, inset: 0 },
  { file: 'favicon-16.png', size: 16, inset: 0 },
];

// Playwright's bundled browser lives at a versioned path that differs between
// machines, so take it from the environment when the default is not there
// rather than failing with a path nobody can guess.
const executablePath = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium';

const browser = await chromium.launch({ executablePath });
const png = {};
for (const { file, size, inset } of targets) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:${NAVY}}svg{display:block;width:${size}px;height:${size}px}</style>${svg(inset)}`,
  );
  png[file] = await page.screenshot({ omitBackground: false });
  writeFileSync(join(out, file), png[file]);
  await page.close();
  console.log(`public/${file}  ${size}x${size}`);
}
await browser.close();

writeFileSync(
  join(out, 'favicon.ico'),
  ico([
    { side: 16, data: png['favicon-16.png'] },
    { side: 32, data: png['favicon-32.png'] },
  ]),
);
console.log('public/favicon.ico  16x16 + 32x32');
