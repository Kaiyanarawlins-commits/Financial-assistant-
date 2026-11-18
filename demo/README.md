# demo/cashcompass.html

The whole app as one file: every script, style and icon inlined, no network
requests, no build step to run. It exists so CashCompass can be handed to
someone as a link or a file before a proper deploy is in place.

Rebuild it with:

    npm run build:standalone && cp dist/cashcompass.html demo/cashcompass.html

It is a build artifact committed on purpose, so it goes stale unless that
command is re-run. Once GitHub Pages is enabled on this repository, the Pages
URL is the better link in every way: its own origin, offline support, and an
install prompt on a phone. Prefer it and treat this file as the fallback.
