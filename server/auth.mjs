import { createServer } from 'node:http';
import { randomBytes, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The CashCompass auth server.
 *
 * This is the real one. Passwords are hashed and compared here, verification
 * codes are generated here and never returned to the client, and session tokens
 * are issued by something the browser cannot reach. The in-browser provider is
 * a convenience for running without infrastructure; this is what you deploy.
 *
 *   ANTHROPIC_API_KEY=…              # optional, if also proxying the advisor
 *   RESEND_API_KEY=re_…              # or POSTMARK_API_KEY / SENDGRID_API_KEY
 *   MAIL_FROM="CashCompass <no-reply@yourdomain.com>"
 *   ALLOWED_ORIGINS=https://your-app.example.com
 *   node server/auth.mjs
 *
 * With no mail provider configured it prints the code to the server log and
 * says so at startup — useful for local development, and loudly not a thing to
 * deploy.
 *
 * Storage is a JSON file. That is honest about what this is: a small,
 * self-hostable reference implementation. Swap `loadDb`/`saveDb` for a real
 * database before it has more than a handful of users.
 */

const PORT = Number(process.env.PORT ?? 8788);
const DB_PATH = process.env.AUTH_DB ?? join(process.cwd(), '.data', 'accounts.json');
const MAIL_FROM = process.env.MAIL_FROM ?? 'CashCompass <no-reply@localhost>';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const PBKDF2_ITERATIONS = 210_000;
const CODE_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const MAX_BODY_BYTES = 64 * 1024;

// Rate limits, per IP. Crude but enough to stop credential stuffing and code
// brute-forcing from a single source; put a real limiter in front for anything
// serious.
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = { '/auth/signin': 10, '/auth/verify': 10, '/auth/signup': 5, '/auth/resend': 5 };
const hits = new Map();

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function loadDb() {
  if (!existsSync(DB_PATH)) return { accounts: [] };
  try {
    return JSON.parse(readFileSync(DB_PATH, 'utf8'));
  } catch {
    console.error('accounts file is unreadable; refusing to overwrite it.');
    process.exit(1);
  }
}

function saveDb(db) {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

const hash = (password, salt) =>
  pbkdf2Sync(password, Buffer.from(salt, 'hex'), PBKDF2_ITERATIONS, 32, 'sha256').toString('hex');

function equal(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Six digits from the CSPRNG, rejection-sampled so the distribution is flat. */
function generateCode() {
  let code = '';
  while (code.length < 6) {
    const byte = randomBytes(1)[0];
    if (byte >= 250) continue;
    code += byte % 10;
  }
  return code;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * Sends through whichever provider has an API key set.
 *
 * All three are plain HTTPS APIs, so this needs no dependencies — and a mail
 * library is a lot of supply chain for one POST.
 */
async function sendCode(email, code, name) {
  const subject = 'Your CashCompass verification code';
  const text = `Hi ${name || 'there'},\n\nYour CashCompass verification code is ${code}\n\nIt expires in 15 minutes. If you did not create an account, ignore this email.`;
  const html = `<p>Hi ${escapeHtml(name || 'there')},</p><p>Your CashCompass verification code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px;font-family:ui-monospace,monospace">${code}</p><p>It expires in 15 minutes. If you did not create an account, ignore this email.</p>`;

  if (process.env.RESEND_API_KEY) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from: MAIL_FROM, to: [email], subject, text, html }),
    });
    if (!response.ok) throw new Error(`Resend rejected the message: ${await response.text()}`);
    return;
  }

  if (process.env.POSTMARK_API_KEY) {
    const response = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'X-Postmark-Server-Token': process.env.POSTMARK_API_KEY,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ From: MAIL_FROM, To: email, Subject: subject, TextBody: text, HtmlBody: html }),
    });
    if (!response.ok) throw new Error(`Postmark rejected the message: ${await response.text()}`);
    return;
  }

  if (process.env.SENDGRID_API_KEY) {
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email }] }],
        from: { email: MAIL_FROM.replace(/.*<|>.*/g, '') || MAIL_FROM },
        subject,
        content: [
          { type: 'text/plain', value: text },
          { type: 'text/html', value: html },
        ],
      }),
    });
    if (!response.ok) throw new Error(`SendGrid rejected the message: ${await response.text()}`);
    return;
  }

  // No provider: log it. Development only, and the banner at startup says so.
  console.log(`\n  [no mail provider] verification code for ${email}: ${code}\n`);
}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const publicView = (account) => ({
  id: account.id,
  email: account.email,
  name: account.name,
  emailVerified: account.emailVerified,
  createdAt: account.createdAt,
});

function startSession(db, account) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  account.sessions = [...(account.sessions ?? []).filter((s) => s.expiresAt > Date.now()), { token, expiresAt }].slice(
    -5,
  );
  saveDb(db);
  return { token, account: publicView(account), expiresAt: new Date(expiresAt).toISOString() };
}

function rateLimited(ip, path) {
  const limit = RATE_MAX[path];
  if (!limit) return false;
  const key = `${ip}:${path}`;
  const now = Date.now();
  const entry = hits.get(key) ?? { count: 0, resetAt: now + RATE_WINDOW_MS };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_WINDOW_MS;
  }
  entry.count++;
  hits.set(key, entry);
  return entry.count > limit;
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 10) return 'Use at least 10 characters';
  if (/^(.)\1+$/.test(password)) return 'Avoid a single repeated character';
  const COMMON = ['password', '12345678', 'qwerty', 'letmein', 'welcome', 'iloveyou', 'admin123'];
  if (COMMON.some((c) => password.toLowerCase().includes(c))) return 'Avoid common passwords';
  return null;
}

const isValidEmail = (email) =>
  typeof email === 'string' && email.length >= 5 && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const routes = {
  '/auth/signup': async (body) => {
    const email = String(body.email ?? '').trim().toLowerCase();
    const name = String(body.name ?? '').trim();
    if (!isValidEmail(email)) return [400, { error: 'invalid-email', message: 'That does not look like an email address.' }];
    if (!name) return [400, { error: 'unknown', message: 'Tell us what to call you.' }];
    const weak = checkPassword(body.password);
    if (weak) return [400, { error: 'weak-password', message: weak }];

    const db = loadDb();
    if (db.accounts.some((a) => a.email === email)) {
      return [409, { error: 'email-taken', message: 'There is already an account with that email. Sign in instead.' }];
    }

    const salt = randomBytes(16).toString('hex');
    const code = generateCode();
    const account = {
      id: randomBytes(12).toString('hex'),
      email,
      name,
      emailVerified: false,
      createdAt: new Date().toISOString(),
      salt,
      passwordHash: hash(body.password, salt),
      pendingCode: { code, expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 },
      sessions: [],
    };
    db.accounts.push(account);
    saveDb(db);

    await sendCode(email, code, name);
    // The code is never returned — that is the entire point of emailing it.
    return [201, { account: publicView(account) }];
  },

  '/auth/verify': async (body) => {
    const email = String(body.email ?? '').trim().toLowerCase();
    const db = loadDb();
    const account = db.accounts.find((a) => a.email === email);
    if (!account) return [404, { error: 'not-found', message: 'No account with that email.' }];
    if (account.emailVerified) return [200, startSession(db, account)];

    const pending = account.pendingCode;
    if (!pending) return [400, { error: 'code-expired', message: 'That code has expired. Send a new one.' }];
    if (pending.attempts >= MAX_CODE_ATTEMPTS) {
      return [429, { error: 'too-many-attempts', message: 'Too many wrong codes. Send a new one.' }];
    }
    if (Date.now() > pending.expiresAt) {
      return [400, { error: 'code-expired', message: 'That code has expired. Send a new one.' }];
    }
    if (!equal(pending.code, String(body.code ?? '').trim())) {
      pending.attempts++;
      saveDb(db);
      const left = MAX_CODE_ATTEMPTS - pending.attempts;
      return [
        400,
        {
          error: 'code-invalid',
          message: left > 0 ? `That code is not right. ${left} left.` : 'Too many wrong codes.',
        },
      ];
    }

    account.emailVerified = true;
    delete account.pendingCode;
    return [200, startSession(db, account)];
  },

  '/auth/resend': async (body) => {
    const email = String(body.email ?? '').trim().toLowerCase();
    const db = loadDb();
    const account = db.accounts.find((a) => a.email === email);
    // Always 200: saying whether the address exists turns this into an
    // account-enumeration endpoint.
    if (!account || account.emailVerified) return [200, {}];

    const code = generateCode();
    account.pendingCode = { code, expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 };
    saveDb(db);
    await sendCode(email, code, account.name);
    return [200, {}];
  },

  '/auth/signin': async (body) => {
    const email = String(body.email ?? '').trim().toLowerCase();
    const db = loadDb();
    const account = db.accounts.find((a) => a.email === email);

    // Same shape and comparable work either way, so timing and wording do not
    // reveal which addresses are registered.
    if (!account) {
      hash(String(body.password ?? ''), randomBytes(16).toString('hex'));
      return [401, { error: 'invalid-credentials', message: 'That email and password do not match.' }];
    }
    if (!equal(hash(String(body.password ?? ''), account.salt), account.passwordHash)) {
      return [401, { error: 'invalid-credentials', message: 'That email and password do not match.' }];
    }
    if (!account.emailVerified) {
      return [403, { error: 'unverified', message: 'Verify your email first — we can send a new code.' }];
    }
    return [200, startSession(db, account)];
  },

  '/auth/session': async (body) => {
    const db = loadDb();
    for (const account of db.accounts) {
      const session = (account.sessions ?? []).find((s) => s.token === body.token);
      if (!session) continue;
      if (Date.now() > session.expiresAt) {
        account.sessions = account.sessions.filter((s) => s.token !== body.token);
        saveDb(db);
        return [401, { error: 'not-found', message: 'Session expired.' }];
      }
      return [
        200,
        {
          token: body.token,
          account: publicView(account),
          expiresAt: new Date(session.expiresAt).toISOString(),
        },
      ];
    }
    return [401, { error: 'not-found', message: 'Session expired.' }];
  },

  '/auth/signout': async (body) => {
    const db = loadDb();
    for (const account of db.accounts) {
      account.sessions = (account.sessions ?? []).filter((s) => s.token !== body.token);
    }
    saveDb(db);
    return [200, {}];
  },

  '/auth/name': async (body) => {
    const name = String(body.name ?? '').trim();
    if (!name) return [400, { error: 'unknown', message: 'A name cannot be empty.' }];
    const db = loadDb();
    const account = db.accounts.find((a) => (a.sessions ?? []).some((s) => s.token === body.token));
    if (!account) return [401, { error: 'not-found', message: 'Session expired. Sign in again.' }];
    account.name = name.slice(0, 60);
    saveDb(db);
    return [200, publicView(account)];
  },
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function corsHeaders(origin) {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin);
  return {
    'access-control-allow-origin': allowed ? origin : (ALLOWED_ORIGINS[0] ?? 'null'),
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
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
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const cors = corsHeaders(origin);
  const path = (req.url ?? '').split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  if (req.method === 'GET' && path === '/health') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mail: mailProvider() }));
    return;
  }

  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    res.writeHead(403, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unknown', message: `Origin ${origin} is not allowed.` }));
    return;
  }

  const handler = routes[path];
  if (req.method !== 'POST' || !handler) {
    res.writeHead(404, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unknown', message: 'Not found.' }));
    return;
  }

  const ip = req.socket.remoteAddress ?? 'unknown';
  if (rateLimited(ip, path)) {
    res.writeHead(429, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'too-many-attempts', message: 'Too many attempts. Wait a few minutes.' }));
    return;
  }

  try {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const [status, payload] = await handler(body);
    res.writeHead(status, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  } catch (error) {
    console.error(`${path} failed:`, error);
    res.writeHead(500, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unknown', message: 'Something went wrong on the server.' }));
  }
});

function mailProvider() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.POSTMARK_API_KEY) return 'postmark';
  if (process.env.SENDGRID_API_KEY) return 'sendgrid';
  return 'none';
}

server.listen(PORT, () => {
  console.log(`CashCompass auth on http://localhost:${PORT}`);
  console.log(`Accounts file: ${DB_PATH}`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  if (mailProvider() === 'none') {
    console.log('\n  NO MAIL PROVIDER SET — verification codes will be printed here.');
    console.log('  Set RESEND_API_KEY, POSTMARK_API_KEY or SENDGRID_API_KEY before deploying.\n');
  } else {
    console.log(`Mail provider: ${mailProvider()}, from ${MAIL_FROM}`);
  }
});
