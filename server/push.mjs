import { createServer } from 'node:http';
import { createPrivateKey, generateKeyPairSync, sign as signWith } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The CashCompass push server.
 *
 * It wakes browsers. That is all it does, and the restraint is the design.
 *
 * Every other feature in this app keeps the user's figures on their device, and
 * a reminder service is the obvious place for that promise to quietly break:
 * the natural implementation posts "Rent, $1,500, due Tuesday" to a server and
 * has it deliver that text. This one cannot. The client sends a subscription
 * and a list of timestamps, the push is sent with no payload at all, and the
 * service worker reads the wording out of IndexedDB on the device.
 *
 * So the worst case for a breach of this database is that an attacker learns
 * some anonymous browser endpoints and that their owners wanted waking at 9am
 * on the 12th. No amounts, no bill names, no account, not even an email.
 *
 *   node server/push.mjs --generate-keys     # once, prints the VAPID pair
 *
 *   VAPID_PUBLIC_KEY=…  VAPID_PRIVATE_KEY=…  VAPID_SUBJECT=mailto:you@example.com \
 *   ALLOWED_ORIGINS=https://your-app.example.com \
 *   node server/push.mjs
 *
 * Storage is a JSON file, as with the auth server: this is a small
 * self-hostable reference, not a service. Swap `loadDb`/`saveDb` before it has
 * more than a handful of users.
 */

const PORT = Number(process.env.PORT ?? 8789);
const DB_PATH = process.env.PUSH_DB ?? join(process.cwd(), '.data', 'subscriptions.json');
const SUBJECT = process.env.VAPID_SUBJECT ?? 'mailto:admin@localhost';
const MAX_BODY_BYTES = 32 * 1024;
const TICK_MS = 60_000;

/** How far past a wake time to still fire. Covers a restart or a missed tick. */
const GRACE_MS = 30 * 60 * 1000;

/** Wake times further ahead than this are refused, so the table cannot be filled. */
const MAX_HORIZON_MS = 120 * 24 * 60 * 60 * 1000;
const MAX_WAKES = 80;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// ---------------------------------------------------------------------------
// VAPID
// ---------------------------------------------------------------------------

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

/**
 * Generates the application server key pair.
 *
 * The public half identifies this server to the push service and is also what
 * the browser passes to `pushManager.subscribe`. The private half signs the
 * JWT on every send and must never reach the client.
 */
function generateKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  // The uncompressed point, which is the form the Push API wants.
  const raw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
  return {
    publicKey: b64url(raw),
    privateKey: b64url(privateKey.export({ format: 'der', type: 'pkcs8' })),
  };
}

function privateKeyFrom(encoded) {
  return createPrivateKey({
    key: Buffer.from(encoded, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
}

/**
 * A VAPID JWT for one push endpoint.
 *
 * `dsaEncoding: 'ieee-p1363'` is load-bearing: Node signs ECDSA as DER by
 * default and JOSE requires the raw r||s pair. A DER signature here is
 * rejected by every push service with an unhelpful 401.
 */
function vapidHeader(endpoint, privateKey, publicKey) {
  const audience = new URL(endpoint).origin;
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64url(
    JSON.stringify({
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
      sub: SUBJECT,
    }),
  );
  const signature = b64url(
    signWith('sha256', Buffer.from(`${header}.${payload}`), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }),
  );
  return `vapid t=${header}.${payload}.${signature}, k=${publicKey}`;
}

/**
 * Sends one wake-up.
 *
 * No body, so there is no encryption to do: the aes128gcm dance exists to
 * protect a payload, and a push with nothing in it has nothing to protect.
 * That is why this server can be a couple of hundred lines with no
 * dependencies, and why it cannot leak what it does not have.
 */
async function sendWake(subscription, privateKey, publicKey) {
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      TTL: '86400',
      Urgency: 'normal',
      'Content-Length': '0',
      Authorization: vapidHeader(subscription.endpoint, privateKey, publicKey),
    },
  });
  return response.status;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function loadDb() {
  if (!existsSync(DB_PATH)) return { subscriptions: [] };
  try {
    return JSON.parse(readFileSync(DB_PATH, 'utf8'));
  } catch {
    console.error('subscriptions file is unreadable; refusing to overwrite it.');
    process.exit(1);
  }
}

function saveDb(db) {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2), { mode: 0o600 });
}

/**
 * Accepts only what this server is allowed to know.
 *
 * Written as a whitelist rather than by deleting unwanted fields, so that a
 * client sending extra detail — by accident or by a later change nobody
 * reviewed — cannot quietly start persisting it here.
 */
function sanitise(body) {
  const subscription = body?.subscription;
  if (!subscription || typeof subscription.endpoint !== 'string') return null;
  try {
    const url = new URL(subscription.endpoint);
    if (url.protocol !== 'https:') return null;
  } catch {
    return null;
  }

  const now = Date.now();
  const wakeAt = Array.isArray(body.wakeAt)
    ? [...new Set(body.wakeAt.filter((at) => Number.isFinite(at) && at > now && at < now + MAX_HORIZON_MS))]
        .sort((a, b) => a - b)
        .slice(0, MAX_WAKES)
    : [];

  return {
    endpoint: subscription.endpoint,
    // Kept because the Push API requires them on the subscription object, not
    // because this server encrypts anything. It never sends a payload.
    keys: {
      p256dh: String(subscription.keys?.p256dh ?? ''),
      auth: String(subscription.keys?.auth ?? ''),
    },
    wakeAt,
    firedAt: [],
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

async function tick(privateKey, publicKey) {
  const db = loadDb();
  const now = Date.now();
  let changed = false;

  for (const subscription of db.subscriptions) {
    const due = subscription.wakeAt.filter(
      (at) => at <= now && at > now - GRACE_MS && !subscription.firedAt.includes(at),
    );
    if (due.length === 0) continue;

    let status;
    try {
      status = await sendWake(subscription, privateKey, publicKey);
    } catch (error) {
      console.error('push failed:', error.message);
      continue;
    }

    // 404 and 410 are the push service saying this subscription is dead. Any
    // other failure might be transient, so only these prune.
    if (status === 404 || status === 410) {
      subscription.dead = true;
      changed = true;
      console.log(`dropped ${new URL(subscription.endpoint).host} (${status}, subscription gone)`);
      continue;
    }

    // Anything else that is not a success stays in the table to retry, but an
    // operator needs to see it: a silently failing reminder service looks
    // exactly like one with nothing to send.
    if (status >= 300) {
      console.error(`push to ${new URL(subscription.endpoint).host} returned ${status}`);
      continue;
    }

    subscription.firedAt.push(...due);
    // One wake can cover several due moments; the worker picks the right text.
    subscription.firedAt = subscription.firedAt.filter((at) => at > now - MAX_HORIZON_MS);
    changed = true;
    console.log(`woke ${new URL(subscription.endpoint).host} (${status})`);
  }

  if (changed) {
    db.subscriptions = db.subscriptions.filter((subscription) => !subscription.dead);
    saveDb(db);
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed ?? '',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function start() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const encodedPrivate = process.env.VAPID_PRIVATE_KEY;

  if (!publicKey || !encodedPrivate) {
    console.error('Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.');
    console.error('Generate a pair with:  node server/push.mjs --generate-keys');
    process.exit(1);
  }

  const privateKey = privateKeyFrom(encodedPrivate);

  const server = createServer(async (req, res) => {
    const headers = corsHeaders(req.headers.origin ?? '');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers);
      res.end();
      return;
    }

    const send = (status, payload) => {
      res.writeHead(status, { ...headers, 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.method !== 'POST') return send(405, { error: 'method not allowed' });

    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      return send(400, { error: error.message });
    }

    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/push/subscribe') {
      const record = sanitise(body);
      if (!record) return send(400, { error: 'invalid subscription' });

      const db = loadDb();
      const existing = db.subscriptions.findIndex((s) => s.endpoint === record.endpoint);
      if (existing >= 0) {
        // Keep what has already fired so a re-sync cannot repeat a reminder.
        record.firedAt = db.subscriptions[existing].firedAt ?? [];
        db.subscriptions[existing] = record;
      } else {
        db.subscriptions.push(record);
      }
      saveDb(db);
      return send(200, { ok: true, scheduled: record.wakeAt.length });
    }

    if (url.pathname === '/push/unsubscribe') {
      const endpoint = String(body?.endpoint ?? '');
      const db = loadDb();
      const before = db.subscriptions.length;
      db.subscriptions = db.subscriptions.filter((s) => s.endpoint !== endpoint);
      if (db.subscriptions.length !== before) saveDb(db);
      return send(200, { ok: true });
    }

    return send(404, { error: 'not found' });
  });

  server.listen(PORT, () => {
    console.log(`CashCompass push server on http://localhost:${PORT}`);
    console.log(`  VITE_PUSH_PUBLIC_KEY=${publicKey}`);
    console.log(`  allowed origins: ${ALLOWED_ORIGINS.join(', ') || '(none)'}`);
    console.log('  this server stores wake times only: no bill names, no amounts, no accounts.');
  });

  const run = () => {
    tick(privateKey, publicKey).catch((error) => console.error('tick failed:', error.message));
  };
  run();
  setInterval(run, TICK_MS);
}

// Only act when run directly, so the tests can import the pieces above without
// binding a port or starting a timer.
const runDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (runDirectly) {
  if (process.argv.includes('--generate-keys')) {
    const keys = generateKeys();
    console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
    console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);
    console.log('');
    console.log('Keep the private key on the server. The public key also goes into the');
    console.log('client build as VITE_PUSH_PUBLIC_KEY, which is fine: it is public.');
  } else {
    start();
  }
}

export { generateKeys, vapidHeader, sanitise, privateKeyFrom };
