import { describe, expect, it } from 'vitest';
import type { AppState } from '../../types';
import { seedState } from '../seed';
import { buildReminders, wakeTimes, REMINDER_HOUR } from './schedule';
import { generateKeys, vapidHeader, sanitise, privateKeyFrom } from '../../../server/push.mjs';

const REFERENCE = '2026-11-02';

/** base64url to bytes, so the suite needs no Node Buffer typings. */
function bytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const text = (base64url: string) => new TextDecoder().decode(bytes(base64url));

const toBase64Url = (input: Uint8Array) =>
  btoa(String.fromCharCode(...input)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function demo(patch: Partial<AppState['settings']> = {}): AppState {
  const state = seedState(REFERENCE);
  state.settings = { ...state.settings, billRemindersEnabled: true, ...patch };
  return state;
}

/** Local-time epoch for a date at the reminder hour, matching the scheduler. */
function localAt(date: string, hour = REMINDER_HOUR): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d!, hour, 0, 0, 0).getTime();
}

const BEFORE = localAt('2026-11-01', 0);

describe('reminder scheduling', () => {
  it('schedules nothing until the user turns reminders on', () => {
    expect(buildReminders(demo({ billRemindersEnabled: false }), REFERENCE, BEFORE)).toEqual([]);
  });

  it('warns the chosen number of days before a bill is due', () => {
    const reminders = buildReminders(demo({ reminderLeadDays: 3 }), REFERENCE, BEFORE);
    expect(reminders.length).toBeGreaterThan(0);

    for (const reminder of reminders) {
      const due = localAt(reminder.dueDate);
      const days = Math.round((due - reminder.fireAt) / 86_400_000);
      expect(days).toBe(3);
    }
  });

  it('groups a day\'s bills into one notification rather than several', () => {
    const state = demo({ reminderLeadDays: 0 });
    const reminders = buildReminders(state, REFERENCE, BEFORE);

    // Every reminder is unique per warning day, which is what stops three
    // separate buzzes on the first of the month.
    const days = reminders.map((reminder) => reminder.id);
    expect(new Set(days).size).toBe(days.length);

    const grouped = reminders.find((reminder) => /^\d+ bills/.test(reminder.title));
    if (grouped) {
      expect(grouped.body).toMatch(/total:/);
      expect(grouped.title).toMatch(/due (today|tomorrow|in \d+ days)/);
    }
  });

  it('never schedules a reminder for a moment that has already passed', () => {
    const now = localAt('2026-12-20');
    for (const reminder of buildReminders(demo(), REFERENCE, now)) {
      expect(reminder.fireAt).toBeGreaterThan(now);
    }
  });

  it('describes the timing in words a notification can show', () => {
    const sameDay = buildReminders(demo({ reminderLeadDays: 0 }), REFERENCE, BEFORE);
    expect(sameDay.every((r) => r.title.includes('due today'))).toBe(true);

    const nextDay = buildReminders(demo({ reminderLeadDays: 1 }), REFERENCE, BEFORE);
    expect(nextDay.every((r) => r.title.includes('due tomorrow'))).toBe(true);
  });

  it('carries the amount in the body so the notification is worth reading', () => {
    const reminders = buildReminders(demo(), REFERENCE, BEFORE);
    expect(reminders.some((reminder) => /\$[\d,]+\.\d{2}/.test(reminder.body))).toBe(true);
  });
});

describe('what reaches the server', () => {
  it('sends times only, sorted and deduplicated', () => {
    const reminders = buildReminders(demo(), REFERENCE, BEFORE);
    const times = wakeTimes(reminders);

    expect(times.every((time) => typeof time === 'number')).toBe(true);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(new Set(times).size).toBe(times.length);
  });

  // The privacy claim, asserted rather than promised in a comment: whatever a
  // client sends, only these fields are ever persisted.
  it('stores nothing but the endpoint, its keys and the wake times', () => {
    const now = Date.now();
    const record = sanitise({
      subscription: {
        endpoint: 'https://push.example.com/abc',
        keys: { p256dh: 'pub', auth: 'auth' },
        // Everything below is the kind of thing a careless client might add.
        email: 'sam@example.com',
        billName: 'Rent',
        amountCents: 150000,
      },
      wakeAt: [now + 60_000],
      note: 'Rent $1,500 due Tuesday',
      state: { income: 680000 },
    });

    expect(Object.keys(record!).sort()).toEqual(
      ['endpoint', 'firedAt', 'keys', 'updatedAt', 'wakeAt'].sort(),
    );
    expect(Object.keys(record!.keys).sort()).toEqual(['auth', 'p256dh']);
    expect(JSON.stringify(record)).not.toMatch(/Rent|sam@example|150000|680000/);
  });

  it('refuses an endpoint that is not https', () => {
    expect(sanitise({ subscription: { endpoint: 'http://push.example.com/a' } })).toBeNull();
    expect(sanitise({ subscription: { endpoint: 'not a url' } })).toBeNull();
    expect(sanitise({})).toBeNull();
  });

  it('drops wake times in the past or absurdly far ahead, and caps the count', () => {
    const now = Date.now();
    const record = sanitise({
      subscription: { endpoint: 'https://push.example.com/abc', keys: {} },
      wakeAt: [
        now - 86_400_000,
        now + 60_000,
        now + 400 * 86_400_000,
        ...Array.from({ length: 200 }, (_, i) => now + (i + 2) * 3_600_000),
      ],
    });

    expect(record!.wakeAt.every((at: number) => at > now)).toBe(true);
    expect(record!.wakeAt.length).toBeLessThanOrEqual(80);
    expect(record!.wakeAt).not.toContain(now + 400 * 86_400_000);
  });
});

describe('VAPID', () => {
  it('generates a usable application server key pair', () => {
    const { publicKey, privateKey } = generateKeys();
    const raw = bytes(publicKey);
    // Uncompressed P-256 point: a leading 0x04 and two 32-byte coordinates.
    expect(raw.length).toBe(65);
    expect(raw[0]).toBe(0x04);
    expect(() => privateKeyFrom(privateKey)).not.toThrow();
  });

  it('signs a JWT the push service can verify', async () => {
    const { publicKey, privateKey } = generateKeys();
    const header = vapidHeader(
      'https://push.example.com/send/abc',
      privateKeyFrom(privateKey),
      publicKey,
    );

    expect(header).toMatch(/^vapid t=.+, k=.+$/);
    const token = header.slice('vapid t='.length, header.indexOf(', k='));
    const [head, payload, signature] = token.split('.');

    expect(JSON.parse(text(head!))).toEqual({ typ: 'JWT', alg: 'ES256' });

    const claims = JSON.parse(text(payload!));
    // The audience must be the push service's origin, not the full endpoint.
    expect(claims.aud).toBe('https://push.example.com');
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // ES256 means a raw r||s pair, not DER. WebCrypto only accepts the former,
    // so a successful verify is the proof that the encoding is right — this is
    // the mistake that makes every push service answer 401.
    const raw = bytes(publicKey);
    const key = await crypto.subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: 'P-256',
        x: toBase64Url(raw.subarray(1, 33)),
        y: toBase64Url(raw.subarray(33)),
      },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );

    const verified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      bytes(signature!),
      new TextEncoder().encode(`${head}.${payload}`),
    );
    expect(verified).toBe(true);
  });
});
