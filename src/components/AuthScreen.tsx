import { useEffect, useRef, useState } from 'react';
import {
  AuthError,
  checkPassword,
  getAuthProvider,
  getAuthServerUrl,
  hasLocalAccounts,
  isValidEmail,
  type Session,
} from '../lib/auth';
import { AlertIcon, CheckIcon, CompassIcon, InfoIcon } from './ui';

type Step = 'welcome' | 'signin' | 'signup' | 'verify';

/**
 * Sign in and account creation.
 *
 * Three screens rather than one form with modes, because the states genuinely
 * differ: signing in wants two fields and nothing else, creating an account
 * needs a name and password guidance, and verifying is a single six-digit
 * input that should not be surrounded by anything else to look at.
 */
export function AuthScreen({ onAuthenticated }: { onAuthenticated: (session: Session) => void }) {
  const provider = getAuthProvider();
  const [step, setStep] = useState<Step>(() => (hasLocalAccounts() || getAuthServerUrl() ? 'signin' : 'welcome'));
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const strength = checkPassword(password);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (problem) {
      setError(problem instanceof AuthError ? problem.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const submitSignUp = () =>
    run(async () => {
      const result = await provider.signUp({ name, email, password });
      setDevCode(result.devCode ?? null);
      setStep('verify');
    });

  const submitVerify = () =>
    run(async () => {
      onAuthenticated(await provider.verifyEmail(email, code));
    });

  const submitSignIn = () =>
    run(async () => {
      try {
        onAuthenticated(await provider.signIn(email, password));
      } catch (problem) {
        // An unverified account is not a failed sign-in — it is an unfinished
        // sign-up, so send them to the step they never completed rather than
        // making them work out what "unverified" means.
        if (problem instanceof AuthError && problem.code === 'unverified') {
          const { devCode: fresh } = await provider.resendCode(email);
          setDevCode(fresh ?? null);
          setStep('verify');
          return;
        }
        throw problem;
      }
    });

  return (
    <div className="auth">
      <div className="auth__panel">
        <div className="auth__brand">
          <CompassIcon size={34} />
          <span>CashCompass</span>
        </div>

        {step === 'welcome' && (
          <Welcome onCreate={() => setStep('signup')} onSignIn={() => setStep('signin')} />
        )}

        {step === 'signup' && (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void submitSignUp();
            }}
          >
            <div>
              <h1 className="auth__title">Create your account</h1>
              <p className="auth__subtitle">Takes a minute. Your figures stay on your device.</p>
            </div>

            <label className="field">
              <span className="field__label">What should I call you?</span>
              <input
                className="input"
                autoFocus
                autoComplete="given-name"
                placeholder="Alex"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <span className="tiny faint">Shown on your dashboard. A first name is plenty.</span>
            </label>

            <label className="field">
              <span className="field__label">Email</span>
              <input
                className="input"
                type="email"
                autoComplete="email"
                inputMode="email"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>

            <label className="field">
              <span className="field__label">Password</span>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              {password.length > 0 && (
                <>
                  <span className="strength" aria-hidden="true">
                    {[0, 1, 2, 3].map((index) => (
                      <span
                        key={index}
                        className={`strength__bar${index < strength.score ? ' strength__bar--on' : ''}`}
                        data-score={strength.score}
                      />
                    ))}
                  </span>
                  <span className={`tiny ${strength.ok ? 'faint' : 'warn'}`}>
                    {strength.problems[0] ?? strength.hint}
                  </span>
                </>
              )}
            </label>

            {error && <Problem>{error}</Problem>}

            <button
              type="submit"
              className="btn btn--primary btn--block"
              disabled={busy || !name.trim() || !isValidEmail(email) || !strength.ok}
            >
              {busy ? 'Creating…' : 'Create account'}
            </button>

            <button type="button" className="btn btn--ghost btn--block" onClick={() => setStep('signin')}>
              I already have an account
            </button>
          </form>
        )}

        {step === 'signin' && (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void submitSignIn();
            }}
          >
            <div>
              <h1 className="auth__title">Welcome back</h1>
              <p className="auth__subtitle">Sign in to pick up where you left off.</p>
            </div>

            <label className="field">
              <span className="field__label">Email</span>
              <input
                className="input"
                type="email"
                autoFocus
                autoComplete="email"
                inputMode="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>

            <label className="field">
              <span className="field__label">Password</span>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>

            {error && <Problem>{error}</Problem>}

            <button
              type="submit"
              className="btn btn--primary btn--block"
              disabled={busy || !email.trim() || !password}
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>

            <button type="button" className="btn btn--ghost btn--block" onClick={() => setStep('signup')}>
              Create an account instead
            </button>
          </form>
        )}

        {step === 'verify' && (
          <VerifyStep
            email={email}
            code={code}
            onCode={setCode}
            devCode={devCode}
            busy={busy}
            error={error}
            onSubmit={submitVerify}
            onResend={() =>
              run(async () => {
                const { devCode: fresh } = await provider.resendCode(email);
                setDevCode(fresh ?? null);
                setCode('');
              })
            }
            onBack={() => setStep('signin')}
          />
        )}

        <p className="auth__footnote">
          {provider.mode === 'local' ? (
            <>
              <strong>Running without a server.</strong> Your account lives in this browser only, and the
              verification code is shown on screen because there is nothing to send email with. This is not a
              security boundary — it personalises the app and separates your data. Point{' '}
              <code>VITE_AUTH_SERVER</code> at <code>server/auth.mjs</code> for real accounts and a real emailed
              code.
            </>
          ) : (
            <>Signing in against your CashCompass server. Passwords are verified server-side.</>
          )}
        </p>
      </div>
    </div>
  );
}

function Welcome({ onCreate, onSignIn }: { onCreate: () => void; onSignIn: () => void }) {
  return (
    <div className="stack">
      <div>
        <h1 className="auth__title">See where your money is pointed</h1>
        <p className="auth__subtitle">
          Log what comes in, subtract what goes out, and know exactly what is safe to spend today.
        </p>
      </div>

      <ul className="auth__points">
        <li>
          <CheckIcon size={15} /> A safe-to-spend figure that accounts for the bills still to land
        </li>
        <li>
          <CheckIcon size={15} /> Seven financial specialists that answer from your real numbers
        </li>
        <li>
          <CheckIcon size={15} /> Your data stays on your device — no bank connection required
        </li>
      </ul>

      <button type="button" className="btn btn--primary btn--block" onClick={onCreate}>
        Get started
      </button>
      <button type="button" className="btn btn--ghost btn--block" onClick={onSignIn}>
        I already have an account
      </button>
    </div>
  );
}

function VerifyStep({
  email,
  code,
  onCode,
  devCode,
  busy,
  error,
  onSubmit,
  onResend,
  onBack,
}: {
  email: string;
  code: string;
  onCode: (value: string) => void;
  devCode: string | null;
  busy: boolean;
  error: string | null;
  onSubmit: () => void;
  onResend: () => void;
  onBack: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [cooldown, setCooldown] = useState(30);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Rate-limits resending, and gives the first code a moment to arrive before
  // the user assumes it has not.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div>
        <h1 className="auth__title">{devCode ? 'Verify your email' : 'Check your email'}</h1>
        <p className="auth__subtitle">
          {devCode ? (
            <>
              Enter the six-digit code for <strong>{email}</strong>. It expires in 15 minutes.
            </>
          ) : (
            <>
              We sent a six-digit code to <strong>{email}</strong>. It expires in 15 minutes.
            </>
          )}
        </p>
      </div>

      {devCode && (
        <div className="alert alert--warning">
          <span className="alert__icon">
            <InfoIcon />
          </span>
          <span className="grow small">
            <strong>No email server configured</strong>, so here is the code: <code className="code">{devCode}</code>
            <span style={{ display: 'block', marginTop: 4 }} className="tiny">
              With a server running, this panel disappears and the code only reaches your inbox.
            </span>
          </span>
        </div>
      )}

      <label className="field">
        <span className="field__label">Verification code</span>
        <input
          ref={inputRef}
          className="input input--code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="000000"
          value={code}
          onChange={(event) => onCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
        />
      </label>

      {error && <Problem>{error}</Problem>}

      <button type="submit" className="btn btn--primary btn--block" disabled={busy || code.length !== 6}>
        {busy ? 'Verifying…' : 'Verify and continue'}
      </button>

      <button
        type="button"
        className="btn btn--ghost btn--block"
        disabled={busy || cooldown > 0}
        onClick={() => {
          onResend();
          setCooldown(30);
        }}
      >
        {cooldown > 0 ? `Send a new code in ${cooldown}s` : 'Send a new code'}
      </button>

      <button type="button" className="btn btn--ghost btn--block" onClick={onBack}>
        Back
      </button>
    </form>
  );
}

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <div className="alert alert--danger" role="alert">
      <span className="alert__icon">
        <AlertIcon />
      </span>
      <span className="grow small">{children}</span>
    </div>
  );
}
