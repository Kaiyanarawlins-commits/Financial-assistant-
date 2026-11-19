import { createServerProvider } from './serverProvider';
import { hasLocalAccounts, localProvider, readSessionToken, rememberSessionToken } from './localProvider';
import type { AuthProvider } from './types';

export * from './types';
export * from './crypto';
export { hasLocalAccounts, readSessionToken, rememberSessionToken };

const CONFIG_KEY = 'cashcompass.authServer.v1';

/**
 * Where auth runs.
 *
 * Configurable rather than compiled in, so the same build works as a local
 * demo and against a deployed server. Read once at startup; changing it signs
 * the user out, because a session issued by one provider means nothing to the
 * other.
 */
export function getAuthServerUrl(): string {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem(CONFIG_KEY) ?? (import.meta.env.VITE_AUTH_SERVER ?? '');
}

export function setAuthServerUrl(url: string): void {
  if (typeof localStorage === 'undefined') return;
  const trimmed = url.trim().replace(/\/$/, '');
  if (trimmed) localStorage.setItem(CONFIG_KEY, trimmed);
  else localStorage.removeItem(CONFIG_KEY);
}

export function getAuthProvider(): AuthProvider {
  const url = getAuthServerUrl();
  return url ? createServerProvider(url) : localProvider;
}
