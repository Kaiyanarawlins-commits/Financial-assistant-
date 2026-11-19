import type { Reminder } from './schedule';

/**
 * The reminder text, stored where the service worker can reach it.
 *
 * A worker woken by a push cannot read `localStorage` and has no access to the
 * running app's memory, so the notification's wording has to be somewhere both
 * sides can see. IndexedDB is the only option, and it is also what lets the
 * push itself carry no payload: the server never holds the text because the
 * device already does.
 *
 * The schema is kept deliberately trivial, one store keyed by id, because
 * `public/sw.js` has to open the same database in plain JavaScript without
 * importing any of this. Two small readers are a fair price for a server that
 * knows nothing.
 */

export const DB_NAME = 'cashcompass-reminders';
export const DB_VERSION = 1;
export const STORE = 'reminders';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function run<T>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = body(tx.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
      }),
  );
}

/**
 * Replaces the stored set with the current one.
 *
 * A wholesale replace rather than a merge: a bill that was cancelled, paid
 * early or re-dated should stop being announced, and reconciling that by hand
 * is how a stale reminder survives for months.
 */
export async function saveReminders(reminders: Reminder[]): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.clear();
    for (const reminder of reminders) store.put(reminder);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export function readReminders(): Promise<Reminder[]> {
  return run<Reminder[]>('readonly', (store) => store.getAll() as IDBRequest<Reminder[]>);
}

export async function clearReminders(): Promise<void> {
  await run('readwrite', (store) => store.clear());
}

/** Best effort: storage being unavailable must never break the caller. */
export async function quietly<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch {
    return null;
  }
}
