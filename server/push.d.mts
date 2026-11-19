/**
 * Types for the parts of the push server the test suite exercises.
 *
 * Hand-written rather than pulled from @types/node: the server is plain
 * JavaScript on purpose, and a dependency added only so a test can describe it
 * would be a poor trade.
 */

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface StoredSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  wakeAt: number[];
  firedAt: number[];
  updatedAt: number;
}

export function generateKeys(): VapidKeys;
export function privateKeyFrom(encoded: string): unknown;
export function vapidHeader(endpoint: string, privateKey: unknown, publicKey: string): string;
export function sanitise(body: unknown): StoredSubscription | null;
