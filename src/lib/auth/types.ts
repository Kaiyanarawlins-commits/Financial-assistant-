/** Shared shapes for both auth providers. */

export interface Account {
  id: string;
  /** Lowercased. The login identifier. */
  email: string;
  /** What the user asked to be called. Shown on the dashboard. */
  name: string;
  emailVerified: boolean;
  createdAt: string;
}

export interface Session {
  token: string;
  account: Account;
  expiresAt: string;
}

export type AuthErrorCode =
  | 'email-taken'
  | 'invalid-credentials'
  | 'not-found'
  | 'code-invalid'
  | 'code-expired'
  | 'too-many-attempts'
  | 'weak-password'
  | 'invalid-email'
  | 'unverified'
  | 'network'
  | 'unknown';

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface SignUpInput {
  name: string;
  email: string;
  password: string;
}

export interface SignUpResult {
  account: Account;
  /**
   * The verification code, returned **only** by the local provider, which has
   * no way to send email. The UI shows it in a clearly-labelled development
   * panel. The server provider never returns it — that would defeat the point
   * of verifying the address at all.
   */
  devCode?: string;
}

/**
 * Both providers implement this, so the UI never knows which is running.
 * `mode` exists purely so the interface can tell the user the truth about what
 * kind of security they are getting.
 */
export interface AuthProvider {
  readonly mode: 'local' | 'server';
  signUp(input: SignUpInput): Promise<SignUpResult>;
  verifyEmail(email: string, code: string): Promise<Session>;
  resendCode(email: string): Promise<{ devCode?: string }>;
  signIn(email: string, password: string): Promise<Session>;
  signOut(token: string): Promise<void>;
  restore(token: string): Promise<Session | null>;
  updateName(token: string, name: string): Promise<Account>;
}
