import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Bundles the Vite build into a single self-contained HTML file.
 *
 * The app makes no network calls, so once the JS and CSS are inlined the whole
 * thing is one portable file — it runs from a file:// URL, an email attachment,
 * or any host with a strict content-security policy that blocks external
 * requests.
 *
 * Emits two shapes:
 *   dist/cashcompass.html           complete document, double-clickable
 *   dist/cashcompass.fragment.html  body content only, for hosts that supply
 *                                   their own <!doctype>/<head>/<body> skeleton
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');
const assetsDir = join(distDir, 'assets');

const assets = readdirSync(assetsDir);
const jsFiles = assets.filter((f) => f.endsWith('.js'));
const cssFiles = assets.filter((f) => f.endsWith('.css'));

// Assert exactly one of each rather than picking the first match. A multi-chunk
// build silently produced a 17 kB "standalone" file containing a 30-byte stub
// instead of the app — it looked like a successful build and was not.
if (jsFiles.length !== 1 || cssFiles.length !== 1) {
  throw new Error(
    `Expected exactly one .js and one .css in ${assetsDir}, found ${jsFiles.length} JS and ${cssFiles.length} CSS ` +
      `(${assets.join(', ')}). Build with VITE_SINGLE_FILE=1 so dynamic imports are inlined.`,
  );
}

const [jsName] = jsFiles;
const [cssName] = cssFiles;

const js = readFileSync(join(assetsDir, jsName), 'utf8');
const css = readFileSync(join(assetsDir, cssName), 'utf8');

/**
 * A literal `</script>` anywhere in the bundle — inside a string, a regex, a
 * comment — closes the inline tag early and truncates the app. The parser only
 * looks for the character sequence, so break it without changing the value.
 */
const escapeForScript = (code) => code.replace(/<\/(script)/gi, '<\\/$1');
const escapeForStyle = (code) => code.replace(/<\/(style)/gi, '<\\/$1');

const favicon =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='14' fill='%230b0e14'/%3E%3Ccircle cx='16' cy='16' r='12' fill='none' stroke='%235b8bff' stroke-width='2'/%3E%3Cpath d='M21.5 10.5l-3.2 7.8-7.8 3.2 3.2-7.8z' fill='%235b8bff'/%3E%3C/svg%3E";

const body = `<title>CashCompass — Income &amp; Spending Navigator</title>
<style>
${escapeForStyle(css)}
</style>
<div id="root"></div>
<script type="module">
${escapeForScript(js)}
</script>`;

const document = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="description" content="CashCompass — see where your money is pointed." />
    <link rel="icon" href="${favicon}" />
    ${body.split('\n').join('\n    ')}
  </head>
</html>`;

mkdirSync(distDir, { recursive: true });
writeFileSync(join(distDir, 'cashcompass.html'), document);
writeFileSync(join(distDir, 'cashcompass.fragment.html'), body);

const kb = (text) => `${(Buffer.byteLength(text) / 1024).toFixed(1)} kB`;
console.log(`dist/cashcompass.html           ${kb(document)}`);
console.log(`dist/cashcompass.fragment.html  ${kb(body)}`);
