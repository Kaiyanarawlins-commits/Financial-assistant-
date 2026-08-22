import type { AppState } from '../types';
import { DEFAULT_CATEGORIES } from './categories';

const STORAGE_KEY = 'cashcompass.state.v1';
export const SCHEMA_VERSION = 1;

/**
 * Whose ledger is loaded.
 *
 * Set at sign-in. Two people sharing a laptop must not see each other's
 * finances, and signing out has to leave nothing behind on screen — namespacing
 * the key is what makes both true. Empty means the pre-account single-user
 * store, which is also what an existing install upgrades from.
 */
let namespace = '';

export function setStorageNamespace(userId: string): void {
  namespace = userId ? `.${userId}` : '';
}

function storageKey(): string {
  return `${STORAGE_KEY}${namespace}`;
}

export function emptyState(): AppState {
  return {
    schemaVersion: SCHEMA_VERSION,
    income: [],
    expenses: [],
    postings: [],
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    goals: [],
    debts: [],
    netWorth: [],
    settings: {
      bufferMode: false,
      irregularIncomeMode: false,
      irregularLookbackMonths: 3,
      reminderLeadDays: 3,
      householdMode: false,
      theme: 'system',
    },
  };
}

/**
 * Loads persisted state, merging it over a fresh default.
 *
 * The merge matters: a state file written by an earlier version will be missing
 * keys this version reads, and a missing `settings.bufferMode` would otherwise
 * surface as a crash on first render rather than as a default.
 */
export function loadState(): AppState | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AppState>;
    const base = emptyState();
    return {
      ...base,
      ...parsed,
      categories: parsed.categories?.length ? parsed.categories : base.categories,
      settings: { ...base.settings, ...(parsed.settings ?? {}) },
      schemaVersion: SCHEMA_VERSION,
    };
  } catch {
    // Corrupt state should cost the user their history, not the ability to open
    // the app. Falling through to null gives them a working empty app.
    return null;
  }
}

export function saveState(state: AppState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(storageKey(), JSON.stringify(state));
  } catch {
    // Quota exceeded or private-browsing restrictions. The in-memory state is
    // still correct, so the session keeps working; only persistence is lost.
  }
}

export function clearState(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(storageKey());
}

/** Full state as a JSON backup the user can download. */
export function serializeState(state: AppState): string {
  return JSON.stringify(state, null, 2);
}

export function deserializeState(json: string): AppState | null {
  try {
    const parsed = JSON.parse(json) as Partial<AppState>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.expenses)) return null;
    const base = emptyState();
    return {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...(parsed.settings ?? {}) },
      schemaVersion: SCHEMA_VERSION,
    };
  } catch {
    return null;
  }
}
