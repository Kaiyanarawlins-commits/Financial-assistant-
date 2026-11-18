# demo/cashcompass.html

The whole app as one file: every script, style and icon inlined, no network
requests, no build step to run. It exists so CashCompass can be handed to
someone as a link or a file before a proper deploy is in place.

Rebuild it with:

    npm run build:standalone && cp dist/cashcompass.html demo/cashcompass.html

## Do not serve this through a raw-GitHub CDN

Tested on 2026-11-18, all of them unusable for this app:

- `cdn.jsdelivr.net` and `raw.githubusercontent.com` send
  `content-type: text/plain` with `nosniff`, so the browser shows source
  rather than running it.
- `cdn.statically.io` does the same after its redirect.
- `raw.githack.com` does serve `text/html`, but puts an ad-funded
  interstitial in front of every HTML page which reads "Avoid entering
  passwords, personal details, or payment information on the page". For a
  budgeting app asking people to enter their income, that warning is both
  accurate and fatal.

The file is for mailing to someone, opening from disk, or demoing offline.
A real origin has to come from GitHub Pages or an equivalent host.

It is a build artifact committed on purpose, so it goes stale unless that
command is re-run. Once GitHub Pages is enabled on this repository, the Pages
URL is the better link in every way: its own origin, offline support, and an
install prompt on a phone. Prefer it and treat this file as the fallback.
