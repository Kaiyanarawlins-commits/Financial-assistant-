import type { AppState, ISODate } from '../../types';
import { buildReminders, wakeTimes, type Reminder } from './schedule';
import { quietly, saveReminders, clearReminders } from './store';

/**
 * The browser side of bill reminders.
 *
 * Three things have to line up before a notification can arrive, and each
 * fails differently, so each is reported separately rather than collapsed into
 * one "it did not work": the browser has to support push at all, the user has
 * to grant permission, and a push server has to be configured to do the waking.
 */

const CONFIG_KEY = 'cashcompass.push.v1';

export interface PushConfig {
  /** Base URL of a running `server/push.mjs`. Empty means reminders are off. */
  serverUrl: string;
  /** The server's VAPID public key, which it prints at startup. */
  publicKey: string;
}

export function defaultPushConfig(): PushConfig {
  return {
    serverUrl: import.meta.env.VITE_PUSH_SERVER ?? '',
    publicKey: import.meta.env.VITE_PUSH_PUBLIC_KEY ?? '',
  };
}

export function loadPushConfig(): PushConfig {
  if (typeof localStorage === 'undefined') return defaultPushConfig();
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return defaultPushConfig();
    return { ...defaultPushConfig(), ...(JSON.parse(raw) as Partial<PushConfig>) };
  } catch {
    return defaultPushConfig();
  }
}

export function savePushConfig(config: PushConfig): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    // Storage unavailable; the session still works, the setting just won't persist.
  }
}

export type PushAvailability =
  | 'ready'
  | 'unsupported'
  | 'not-configured'
  | 'permission-denied'
  | 'permission-default';

export function supportsPush(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function availability(config: PushConfig = loadPushConfig()): PushAvailability {
  if (!supportsPush()) return 'unsupported';
  if (!config.serverUrl || !config.publicKey) return 'not-configured';
  if (Notification.permission === 'denied') return 'permission-denied';
  if (Notification.permission !== 'granted') return 'permission-default';
  return 'ready';
}

/**
 * Explains the state in the terms a user can act on.
 *
 * "Unsupported" in particular is almost always an iPhone that has not added
 * the app to the home screen, which is a fixable situation and not a dead end,
 * so it says so rather than reporting the browser as incapable.
 */
export function describeAvailability(state: PushAvailability): string {
  switch (state) {
    case 'ready':
      return 'Reminders will arrive even when the app is closed.';
    case 'unsupported':
      return 'This browser cannot receive notifications. On an iPhone, add CashCompass to your home screen first — Safari only allows them for installed apps.';
    case 'not-configured':
      return 'No reminder server is set. Reminders still show inside the app; a server is what lets them reach you when it is closed.';
    case 'permission-denied':
      return 'Notifications are blocked for this site. You will need to allow them in your browser settings before this can work.';
    case 'permission-default':
      return 'Turn this on and your browser will ask permission once.';
  }
}

/** Base64url to the Uint8Array the subscription API expects. */
function decodeKey(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  // An explicit ArrayBuffer, and an explicit type parameter: the default
  // Uint8Array<ArrayBufferLike> is not assignable to BufferSource, because it
  // might be backed by a SharedArrayBuffer.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

export interface SyncResult {
  ok: boolean;
  /** How many wake-ups the server was given. Never what they are for. */
  scheduled: number;
  error?: string;
}

/**
 * Brings the server's idea of when to wake this device in line with the bills.
 *
 * Sends the subscription and a list of timestamps. It does not send, and has no
 * way to send, the bill names, the amounts or the categories: those went into
 * IndexedDB on this device a few lines earlier.
 */
export async function syncReminders(
  state: AppState,
  reference: ISODate,
  config: PushConfig = loadPushConfig(),
): Promise<SyncResult> {
  const reminders = buildReminders(state, reference);

  if (availability(config) !== 'ready') {
    await quietly(() => saveReminders(reminders));
    return { ok: false, scheduled: 0, error: describeAvailability(availability(config)) };
  }

  const reg = await registration();
  if (!reg) return { ok: false, scheduled: 0, error: 'The offline worker is not running yet.' };

  let subscription: PushSubscription | null;
  try {
    subscription =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeKey(config.publicKey),
      }));
  } catch (error) {
    return {
      ok: false,
      scheduled: 0,
      error: error instanceof Error ? error.message : 'Could not subscribe to notifications.',
    };
  }

  await quietly(() => saveReminders(reminders));

  try {
    const response = await fetch(new URL('/push/subscribe', config.serverUrl).href, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription, wakeAt: wakeTimes(reminders) }),
    });
    if (!response.ok) {
      return { ok: false, scheduled: 0, error: `The reminder server returned ${response.status}.` };
    }
  } catch {
    return { ok: false, scheduled: 0, error: 'Could not reach the reminder server.' };
  }

  return { ok: true, scheduled: wakeTimes(reminders).length };
}

/** Asks for permission. Returns the resulting availability, not a raw string. */
export async function requestPermission(
  config: PushConfig = loadPushConfig(),
): Promise<PushAvailability> {
  if (!supportsPush()) return 'unsupported';
  if (Notification.permission === 'default') {
    try {
      await Notification.requestPermission();
    } catch {
      // Older Safari rejects rather than resolving; the state check below copes.
    }
  }
  return availability(config);
}

/** Unsubscribes and clears the local text, so nothing is left to fire. */
export async function disableReminders(config: PushConfig = loadPushConfig()): Promise<void> {
  await quietly(() => clearReminders());

  const reg = await registration();
  const subscription = await reg?.pushManager.getSubscription();
  if (!subscription) return;

  if (config.serverUrl) {
    await fetch(new URL('/push/unsubscribe', config.serverUrl).href, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    }).catch(() => undefined);
  }
  await subscription.unsubscribe().catch(() => undefined);
}

export type { Reminder };
