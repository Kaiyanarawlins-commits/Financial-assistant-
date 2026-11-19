import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Injects the real build output into the service worker's precache list.
 *
 * The worker cannot know Vite's fingerprinted filenames ahead of time, and it
 * cannot discover them at runtime either: the first page load happens before
 * the worker controls the page, so those requests never reach its fetch
 * handler. Writing the list in after the build is what makes the very first
 * visit enough to work offline.
 *
 * VERSION is a hash of the precached files' contents, so a deploy that changes
 * nothing reuses the cache and a deploy that changes anything evicts it.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');
const swPath = join(distDir, 'sw.js');

/** Files worth holding offline: the app shell, its assets, and the icons. */
const PRECACHE_EXTENSIONS = new Set(['.js', '.css', '.html', '.png', '.svg', '.webmanifest', '.woff2']);
const EXCLUDE = new Set(['sw.js', 'cashcompass.html', 'cashcompass.fragment.html']);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(distDir)
  .map((full) => ({ full, rel: relative(distDir, full).split(sep).join('/') }))
  .filter(({ rel }) => !EXCLUDE.has(rel))
  .filter(({ rel }) => PRECACHE_EXTENSIONS.has(rel.slice(rel.lastIndexOf('.'))))
  // 404.html is the SPA fallback the host serves, not something to fetch.
  .filter(({ rel }) => rel !== '404.html')
  .sort((a, b) => a.rel.localeCompare(b.rel));

const hash = createHash('sha256');
for (const { full, rel } of files) {
  hash.update(rel);
  hash.update(readFileSync(full));
}
const version = hash.digest('hex').slice(0, 12);

// Relative paths, so the worker resolves them against its own scope and the
// same output works at a domain root or under a project subpath.
const manifest = files.map(({ rel }) => `./${rel}`);

const source = readFileSync(swPath, 'utf8');
if (!source.includes('__PRECACHE_MANIFEST__') || !source.includes('__BUILD_VERSION__')) {
  throw new Error('sw.js is missing its placeholders — did public/sw.js change?');
}

writeFileSync(
  swPath,
  source
    .replace('__PRECACHE_MANIFEST__', JSON.stringify(manifest, null, 2))
    .replace('__BUILD_VERSION__', version),
);

console.log(`sw.js  version ${version}, ${manifest.length} files precached`);
