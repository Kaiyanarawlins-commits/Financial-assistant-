import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element missing from index.html');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

/**
 * Register the offline worker.
 *
 * Production only — in dev a service worker caches the module graph and serves
 * stale code back over Vite's HMR, which looks exactly like an unrelated bug.
 * Registration is deliberately not awaited: offline support is an enhancement,
 * and a failure to register (unsupported browser, insecure origin, blocked by
 * policy) must not affect an app that already runs entirely client-side.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .catch(() => undefined);
  });
}
