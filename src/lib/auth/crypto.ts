/**
 * Password hashing and verification-code generation.
 *
 * A caveat that belongs at the top of the file rather than in a doc somewhere:
 * hashing a password *in the browser* is not authentication. Anything the
 * client computes, the client controls — someone with devtools can set the
 * session flag directly, and the financial data sits in localStorage regardless.
 * Local mode exists so the app is usable and personalised without a server, and
 * it is labelled that way in the UI. Real protection comes from the server
 * provider, where the hash is computed and compared somewhere the user cannot
 * reach.
 *
 * Given that, the local hashing is still done properly: PBKDF2-SHA256 with a
 * per-account salt, so a shared browser or a stolen backup does not hand over a
 * password that is probably reused elsewhere.
 */

const PBKDF2_ITERATIONS = 210_000; // OWASP's 2023 floor for PBKDF2-SHA256.
const KEY_LENGTH_BITS = 256;
const SALT_BYTES = 16;

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(hex.length / 2);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function subtle(): SubtleCrypto {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('WebCrypto is unavailable — this needs a secure context (https or localhost).');
  }
  return crypto.subtle;
}

export function randomSalt(): string {
  const buffer = new ArrayBuffer(SALT_BYTES);
  crypto.getRandomValues(new Uint8Array(buffer));
  return toHex(buffer);
}

export async function hashPassword(password: string, salt: string): Promise<string> {
  const key = await subtle().importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await subtle().deriveBits(
    { name: 'PBKDF2', salt: fromHex(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    KEY_LENGTH_BITS,
  );
  return toHex(bits);
}

/**
 * Compares in constant time.
 *
 * `a === b` on a hash leaks its prefix through timing. The window is small in a
 * browser and the habit costs nothing, so it is not worth the argument.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password: string, salt: string, expected: string): Promise<boolean> {
  return safeEqual(await hashPassword(password, salt), expected);
}

/**
 * A six-digit verification code, drawn from the CSPRNG.
 *
 * `Math.random()` would be guessable, and a guessable code makes the whole
 * verification step theatre. Rejection sampling keeps the digits uniform rather
 * than biasing the low end with a modulo.
 */
export function generateCode(): string {
  const digits: string[] = [];
  const buffer = new Uint8Array(1);
  while (digits.length < 6) {
    crypto.getRandomValues(buffer);
    const value = buffer[0] as number;
    if (value >= 250) continue; // 250 = 25 x 10; anything above biases the modulo.
    digits.push(String(value % 10));
  }
  return digits.join('');
}

/** Opaque session token. */
export function generateToken(): string {
  const buffer = new ArrayBuffer(32);
  crypto.getRandomValues(new Uint8Array(buffer));
  return toHex(buffer);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Deliberately permissive.
 *
 * Email grammar is far broader than the patterns most apps enforce, and a
 * regex that rejects a valid address is a user who cannot sign up at all. The
 * real check is whether the code arrives.
 */
export function isValidEmail(email: string): boolean {
  const trimmed = email.trim();
  return trimmed.length >= 5 && trimmed.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed);
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface PasswordCheck {
  ok: boolean;
  /** 0–4, for the strength meter. */
  score: number;
  problems: string[];
  hint: string;
}

/**
 * Length first, composition second.
 *
 * Character-class rules ("one uppercase, one symbol") push people toward
 * `Password1!` — memorable to a cracking dictionary and not to the user. Length
 * is what actually costs an attacker, so it is the only hard requirement, and
 * the rest is advisory.
 */
export function checkPassword(password: string): PasswordCheck {
  const problems: string[] = [];
  if (password.length < 10) problems.push('Use at least 10 characters');

  const COMMON = ['password', '12345678', 'qwerty', 'letmein', 'welcome', 'iloveyou', 'admin123'];
  const lower = password.toLowerCase();
  if (COMMON.some((common) => lower.includes(common))) {
    problems.push('Avoid common passwords a cracking list already contains');
  }
  if (/^(.)\1+$/.test(password)) problems.push('Avoid a single repeated character');

  let score = 0;
  if (password.length >= 10) score++;
  if (password.length >= 14) score++;
  if (password.length >= 20) score++;
  if (/[^a-zA-Z0-9]/.test(password) || (/[a-z]/.test(password) && /[A-Z0-9]/.test(password))) score++;
  if (problems.length > 0) score = Math.min(score, 1);

  return {
    ok: problems.length === 0,
    score: Math.min(4, score),
    problems,
    hint:
      password.length < 10
        ? 'Length beats complexity. Three or four unrelated words is stronger than P@ssw0rd and easier to remember.'
        : score >= 3
          ? 'Strong.'
          : 'Reasonable. A longer passphrase would be stronger.',
  };
}
