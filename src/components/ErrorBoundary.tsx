import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Crash recovery.
 *
 * Without this, one bad render blanks the page. That is bad in any app and
 * specific trouble in this one: the user's entire ledger lives in
 * `localStorage`, nowhere else, with no server copy — so a white screen does
 * not read as "the app broke", it reads as "my financial data is gone". The
 * first job here is therefore to say, immediately and plainly, that the data is
 * still on the device.
 *
 * The second job is to let them leave with it. The download below reads the raw
 * stored string and hands it over without parsing, importing, or touching any
 * other module in the app. That independence is the point: whatever broke, this
 * path has almost no surface left to break on.
 */

const STORAGE_PREFIX = 'cashcompass.state.v1';

interface Props {
  children: ReactNode;
  /**
   * A view-level boundary keeps the shell and navigation alive, so a crash in
   * one tab costs that tab rather than the session. The root boundary has
   * nothing left to fall back to and says so.
   */
  scope?: 'root' | 'view';
  /** Remounts the subtree when it changes — switching tabs clears a view crash. */
  resetKey?: string;
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(previous: Props) {
    // Navigating away from the broken view is the most natural way a user tries
    // to recover, so make it work rather than stranding them on the message.
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // No telemetry — nothing in this app phones home, and a crash reporter
    // would be the first thing to break that promise. The console is for
    // whoever is looking at it.
    console.error('CashCompass crashed:', error, info.componentStack);
  }

  /**
   * Hands over whatever is stored, byte for byte.
   *
   * Deliberately dependency-free: no JSON.parse, no serializer, no import from
   * the app's own modules. A boundary that needs the broken program to work is
   * not a boundary.
   */
  private static stored(): string | null {
    try {
      const keys = Object.keys(localStorage).filter((key) => key.startsWith(STORAGE_PREFIX));
      if (keys.length === 0) return null;
      if (keys.length === 1) return localStorage.getItem(keys[0]!) || null;
      return JSON.stringify(
        Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)])),
        null,
        2,
      );
    } catch {
      // Storage blocked — private browsing, or a sandboxed frame.
      return null;
    }
  }

  private download = () => {
    try {
      const payload = ErrorBoundary.stored();
      if (!payload) return;

      const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `cashcompass-recovery-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    } catch {
      // Storage blocked or unavailable. The reload path still stands.
    }
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const { scope = 'root', label } = this.props;

    if (scope === 'view') {
      return (
        <div className="card">
          <div className="empty">
            <div className="empty__title">{label ? `${label} hit a problem` : 'This view hit a problem'}</div>
            <div className="small">
              The rest of the app still works — switch tabs and come back. Your figures are
              untouched.
            </div>
          </div>
          <button
            type="button"
            className="btn btn--block"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    }

    // Only promise a backup that exists. A crash before the first save — or in
    // a browser where storage is blocked — leaves nothing on disk, and offering
    // a download that silently writes an empty file would turn the one
    // reassuring sentence on this screen into a lie.
    const hasStoredData = ErrorBoundary.stored() !== null;

    return (
      <div className="auth">
        <div className="auth__panel">
          <h1 className="auth__title">Something broke</h1>
          <p className="auth__subtitle">
            {hasStoredData ? (
              <>
                <strong>Your data is safe.</strong> Everything you have entered is still stored on
                this device — nothing was lost, and nothing was sent anywhere. This is a display
                problem, and reloading usually clears it.
              </>
            ) : (
              <>
                This is a display problem, and reloading usually clears it. Nothing was sent
                anywhere.
              </>
            )}
          </p>

          <div className="stack" style={{ marginTop: 18 }}>
            <button type="button" className="btn btn--primary btn--block" onClick={() => window.location.reload()}>
              Reload the app
            </button>
            {hasStoredData && (
              <button type="button" className="btn btn--block" onClick={this.download}>
                Download a copy of my data first
              </button>
            )}
          </div>

          <p className="auth__footnote">
            {hasStoredData && (
              <>
                If it keeps happening, the downloaded file is a complete backup — you can restore it
                under <strong>Settings → Your data</strong> after reloading.
                <br />
                <br />
              </>
            )}
            <code>{error.message || String(error)}</code>
          </p>
        </div>
      </div>
    );
  }
}
