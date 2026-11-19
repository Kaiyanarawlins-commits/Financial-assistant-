import { getAuthProvider, type Session } from './auth';

/**
 * The demo link.
 *
 * Opening the app with `?demo` signs into a throwaway account on this device
 * and fills it with the sample month, so a judge, an investor or a friend sees
 * a working budget in one click instead of a sign-up form and an empty ledger.
 *
 * It is deliberately a separate account rather than a mode. The sample figures
 * never land in a real user's ledger, the demo cannot overwrite anything, and
 * signing out of it leaves a normal first-run app behind. The credentials below
 * are in the shipped bundle on purpose: this account is meant to be public, it
 * holds invented numbers, and it exists only in the browser that opened the
 * link.
 */

const DEMO_EMAIL = 'demo@cashcompass.local';
const DEMO_PASSWORD = 'cashcompass-demo-8421';
const DEMO_NAME = 'Demo';

let active = false;

/** True once this page load is running on the demo account. */
export function demoActive(): boolean {
  return active;
}

export function markDemoActive(session: Session | null): boolean {
  active = session?.account.email === DEMO_EMAIL;
  return active;
}

/** Whether the current URL asked for the demo. */
export function demoRequested(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('demo');
}

/**
 * Signs into the demo account, creating it on this device the first time.
 *
 * Every branch swallows its error and returns null, because the only sensible
 * failure for a demo link is the ordinary sign-in screen. Throwing here would
 * replace a working app with a crash page in front of exactly the audience the
 * link exists for.
 */
export async function openDemoSession(): Promise<Session | null> {
  const provider = getAuthProvider();

  // Returning visitor on this device: the account is already there.
  try {
    const session = await provider.signIn(DEMO_EMAIL, DEMO_PASSWORD);
    markDemoActive(session);
    return session;
  } catch {
    // Not created here yet, or created but never verified. Both fall through.
  }

  try {
    const { devCode } = await provider.signUp({
      name: DEMO_NAME,
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
    });
    // Only the local provider hands back the code. Against a real auth server
    // the demo cannot verify itself, and should not try.
    if (!devCode) return null;
    const session = await provider.verifyEmail(DEMO_EMAIL, devCode);
    markDemoActive(session);
    return session;
  } catch {
    // Account exists but is unverified: ask for a fresh code and finish.
  }

  try {
    const { devCode } = await provider.resendCode(DEMO_EMAIL);
    if (!devCode) return null;
    const session = await provider.verifyEmail(DEMO_EMAIL, devCode);
    markDemoActive(session);
    return session;
  } catch {
    return null;
  }
}
