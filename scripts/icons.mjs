import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  { file: 'apple-touch-icon.png', size: 180, inset: 0.06 },
];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
for (const { file, size, inset } of targets) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:${NAVY}}svg{display:block;width:${size}px;height:${size}px}</style>${svg(inset)}`,
  );
  writeFileSync(join(out, file), await page.screenshot({ omitBackground: false }));
  await page.close();
  console.log(`public/${file}  ${size}x${size}`);
}
await browser.close();
