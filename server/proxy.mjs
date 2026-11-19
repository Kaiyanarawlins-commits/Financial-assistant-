import { createServer } from 'node:http';

/**
 * A minimal Anthropic API proxy for CashCompass.
 *
 * Why this exists: the advisor can call the API straight from the browser, but
 * that requires shipping a key to the client, where any script on the page can
 * read it. That is fine for a personal build on your own machine and wrong for
 * anything deployed. This holds the key server-side and forwards the request,
 * so the browser never sees it.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... node server/proxy.mjs
 *
 * Then set the proxy URL in Settings → AI advisor to this server's address.
 *
 * Deliberately dependency-free — it is ~120 lines of Node stdlib, and a proxy
 * whose job is to guard a credential is a bad place to add a supply chain.
 */

const PORT = Number(process.env.PORT ?? 8787);
const API_KEY = process.env.ANTHROPIC_API_KEY;
const UPSTREAM = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';

// Comma-separated list of allowed browser origins. Defaults to local dev only:
// a wide-open proxy is an unmetered API key that anyone can spend.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const MAX_BODY_BYTES = 1_000_000;

if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Refusing to start — the proxy has nothing to authenticate with.');
  process.exit(1);
}

/** Only the Messages API is reachable. Nothing else needs to be. */
const ALLOWED_PATHS = new Set(['/v1/messages']);

function corsHeaders(origin) {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin);
  return {
    'access-control-allow-origin': allowed ? origin : ALLOWED_ORIGINS[0] ?? 'null',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, anthropic-version, anthropic-beta, x-api-key, authorization',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const cors = corsHeaders(origin);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    res.writeHead(403, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Origin ${origin} is not allowed by this proxy.` } }));
    return;
  }

  const path = (req.url ?? '').split('?')[0];
  if (req.method !== 'POST' || !ALLOWED_PATHS.has(path)) {
    res.writeHead(404, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Not proxied: ${req.method} ${path}` } }));
    return;
  }

  try {
    const body = await readBody(req);

    // Forward only the headers the API needs, and attach the key here. The
    // client's x-api-key (the SDK's "proxy" placeholder) is dropped rather than
    // passed through.
    const headers = {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': req.headers['anthropic-version'] ?? '2023-06-01',
    };
    if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];

    const upstream = await fetch(`${UPSTREAM}${path}`, { method: 'POST', headers, body });

    const responseHeaders = { ...cors, 'content-type': upstream.headers.get('content-type') ?? 'application/json' };
    res.writeHead(upstream.status, responseHeaders);

    // Stream the response through rather than buffering, so streaming requests
    // still stream and a long answer does not sit in memory.
    if (upstream.body) {
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    }
    res.end();
  } catch (error) {
    res.writeHead(502, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Proxy error: ${error?.message ?? 'unknown'}` } }));
  }
});

server.listen(PORT, () => {
  console.log(`CashCompass proxy on http://localhost:${PORT}`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log('Set this URL in Settings → AI advisor → Proxy URL.');
});
