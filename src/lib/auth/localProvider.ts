import { newId } from '../id';
import {
  checkPassword,
  generateCode,
  generateToken,
  hashPassword,
  isValidEmail,
  normaliseEmail,
  randomSalt,
  safeEqual,
  verifyPassword,
} from './crypto';
import { AuthError, type Account, type AuthProvider, type Session, type SignUpInput, type SignUpResult } from './types';

/**
 * Accounts stored in this browser.
 *
 * This is the no-server mode. It gives the app real personalisation, a real
 * sign-in screen, per-user data separation and a working verification flow —
 * and it is not a security boundary, which the UI says plainly. Anyone with
 * devtools can read the store or set the session directly.
 *
 * What it *does* buy, even so: the password is never stored in the clear, so a
 * shared laptop or an exported backup does not hand over a credential that is
 * probably reused on the user's actual bank.
 */

const ACCOUNTS_KEY = 'cashcompass.accounts.v1';
const SESSION_KEY = 'cashcompass.session.v1';

const CODE_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

interface StoredAccount extends Account {
  salt: string;
  passwordHash: string;
  pendingCode?: { code: string; expiresAt: number; attempts: number };
  sessions: { token: string; expiresAt: number }[];
}

function readAccounts(): StoredAccount[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as StoredAccount[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAccounts(accounts: StoredAccount[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
  } catch {
    throw new AuthError('unknown', 'Could not save your account — this browser is blocking local storage.');
  }
}

function publicView(account: StoredAccount): Account {
  return {
    id: account.id,
    email: account.email,
    name: account.name,
    emailVerified: account.emailVerified,
    createdAt: account.createdAt,
  };
}

export const localProvider: AuthProvider = {
  mode: 'local',

  async signUp({ name, email, password }: SignUpInput): Promise<SignUpResult> {
    const address = normaliseEmail(email);
    if (!isValidEmail(address)) throw new AuthError('invalid-email', 'That does not look like an email address.');

    const strength = checkPassword(password);
    if (!strength.ok) throw new AuthError('weak-password', strength.problems.join('. '));
    if (!name.trim()) throw new AuthError('unknown', 'Tell me what to call you.');

    const accounts = readAccounts();
    if (accounts.some((a) => a.email === address)) {
      throw new AuthError('email-taken', 'There is already an account with that email. Sign in instead.');
    }

    const salt = randomSalt();
    const code = generateCode();
    const account: StoredAccount = {
      id: newId('user'),
      email: address,
      name: name.trim(),
      emailVerified: false,
      createdAt: new Date().toISOString(),
      salt,
      passwordHash: await hashPassword(password, salt),
      pendingCode: { code, expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 },
      sessions: [],
    };

    writeAccounts([...accounts, account]);
    // No server, so no email. The UI surfaces this in a labelled panel rather
    // than pretending a message was sent.
    return { account: publicView(account), devCode: code };
  },

  async verifyEmail(email: string, code: string): Promise<Session> {
    const accounts = readAccounts();
    const account = accounts.find((a) => a.email === normaliseEmail(email));
    if (!account) throw new AuthError('not-found', 'No account with that email.');

    if (account.emailVerified) return startSession(accounts, account);

    const pending = account.pendingCode;
    if (!pending) throw new AuthError('code-expired', 'That code has expired. Send a new one.');
    if (pending.attempts >= MAX_CODE_ATTEMPTS) {
      throw new AuthError('too-many-attempts', 'Too many wrong codes. Send a new one.');
    }
    if (Date.now() > pending.expiresAt) {
      throw new AuthError('code-expired', 'That code has expired. Send a new one.');
    }

    if (!safeEqual(pending.code, code.trim())) {
      pending.attempts++;
      writeAccounts(accounts);
      const left = MAX_CODE_ATTEMPTS - pending.attempts;
      throw new AuthError(
        'code-invalid',
        left > 0 ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong codes.',
      );
    }

    account.emailVerified = true;
    delete account.pendingCode;
    return startSession(accounts, account);
  },

  async resendCode(email: string): Promise<{ devCode?: string }> {
    const accounts = readAccounts();
    const account = accounts.find((a) => a.email === normaliseEmail(email));
    // Deliberately silent about whether the address exists — saying so turns
    // this into a way to enumerate who has an account.
    if (!account) return {};

    const code = generateCode();
    account.pendingCode = { code, expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 };
    writeAccounts(accounts);
    return { devCode: code };
  },

  async signIn(email: string, password: string): Promise<Session> {
    const accounts = readAccounts();
    const account = accounts.find((a) => a.email === normaliseEmail(email));

    // Same error and roughly the same work whether or not the account exists,
    // so the response does not reveal which emails are registered.
    if (!account) {
      await hashPassword(password, randomSalt());
      throw new AuthError('invalid-credentials', 'That email and password do not match.');
    }
    if (!(await verifyPassword(password, account.salt, account.passwordHash))) {
      throw new AuthError('invalid-credentials', 'That email and password do not match.');
    }
    if (!account.emailVerified) {
      throw new AuthError('unverified', 'Verify your email first — we can send a new code.');
    }

    return startSession(accounts, account);
  },

  async signOut(token: string): Promise<void> {
    const accounts = readAccounts();
    for (const account of accounts) {
      account.sessions = account.sessions.filter((s) => s.token !== token);
    }
    writeAccounts(accounts);
    if (typeof localStorage !== 'undefined') localStorage.removeItem(SESSION_KEY);
  },

  async restore(token: string): Promise<Session | null> {
    const accounts = readAccounts();
    for (const account of accounts) {
      const session = account.sessions.find((s) => s.token === token);
      if (!session) continue;
      if (Date.now() > session.expiresAt) {
        account.sessions = account.sessions.filter((s) => s.token !== token);
        writeAccounts(accounts);
        return null;
      }
      return {
        token,
        account: publicView(account),
        expiresAt: new Date(session.expiresAt).toISOString(),
      };
    }
    return null;
  },

  async updateName(token: string, name: string): Promise<Account> {
    const accounts = readAccounts();
    const account = accounts.find((a) => a.sessions.some((s) => s.token === token));
    if (!account) throw new AuthError('not-found', 'Session expired. Sign in again.');
    if (!name.trim()) throw new AuthError('unknown', 'A name cannot be empty.');
    account.name = name.trim();
    writeAccounts(accounts);
    return publicView(account);
  },
};

function startSession(accounts: StoredAccount[], account: StoredAccount): Session {
  const token = generateToken();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  // Keep a handful of devices, dropping the oldest rather than growing forever.
  account.sessions = [...account.sessions.filter((s) => s.expiresAt > Date.now()), { token, expiresAt }].slice(-5);
  writeAccounts(accounts);
  return { token, account: publicView(account), expiresAt: new Date(expiresAt).toISOString() };
}

export function rememberSessionToken(token: string | null): void {
  if (typeof localStorage === 'undefined') return;
  if (token) localStorage.setItem(SESSION_KEY, token);
  else localStorage.removeItem(SESSION_KEY);
}

export function readSessionToken(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(SESSION_KEY);
}

/** Whether any account exists here — decides between "Sign in" and "Get started". */
export function hasLocalAccounts(): boolean {
  return readAccounts().length > 0;
}
