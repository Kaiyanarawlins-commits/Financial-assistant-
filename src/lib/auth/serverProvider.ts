import { AuthError, type Account, type AuthProvider, type Session, type SignUpInput, type SignUpResult } from './types';

/**
 * Talks to the auth server in `server/auth.mjs`.
 *
 * This is the real one. The password hash is computed and compared server-side,
 * the verification code never reaches the client, and the session token is
 * issued by something the user cannot reach. Everything the local provider can
 * only approximate.
 */

const ERROR_CODES = new Set([
  'email-taken',
  'invalid-credentials',
  'not-found',
  'code-invalid',
  'code-expired',
  'too-many-attempts',
  'weak-password',
  'invalid-email',
  'unverified',
]);

export function createServerProvider(baseUrl: string): AuthProvider {
  const root = baseUrl.replace(/\/$/, '');

  async function call<T>(path: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${root}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new AuthError('network', 'Could not reach the sign-in server. Check your connection.');
    }

    const payload = (await response.json().catch(() => ({}))) as { error?: string; message?: string } & T;
    if (!response.ok) {
      const code = payload.error && ERROR_CODES.has(payload.error) ? payload.error : 'unknown';
      throw new AuthError(code as never, payload.message ?? 'That did not work.');
    }
    return payload;
  }

  return {
    mode: 'server',

    signUp: (input: SignUpInput) => call<SignUpResult>('/auth/signup', input),

    verifyEmail: (email: string, code: string) => call<Session>('/auth/verify', { email, code }),

    resendCode: (email: string) => call<{ devCode?: string }>('/auth/resend', { email }),

    signIn: (email: string, password: string) => call<Session>('/auth/signin', { email, password }),

    signOut: async (token: string) => {
      await call('/auth/signout', { token }).catch(() => undefined);
    },

    restore: async (token: string) => {
      try {
        return await call<Session>('/auth/session', { token });
      } catch {
        // An expired or rejected token is a normal outcome, not an error to
        // surface — the user simply lands on the sign-in screen.
        return null;
      }
    },

    updateName: (token: string, name: string) => call<Account>('/auth/name', { token, name }),
  };
}
