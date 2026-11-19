import type { AppState, ISODate } from '../../types';
import { upcomingBills } from '../finance';
import { formatMoney } from '../money';

/**
 * Bill reminder scheduling.
 *
 * The important design decision lives here, and it is a privacy one. The whole
 * promise of this app is that your figures never leave the device, so the push
 * server is never told what a reminder says. It is told only *when* to wake the
 * browser: a list of timestamps and nothing else.
 *
 * The notification text is written into IndexedDB on this device, and the
 * service worker reads it there when the wake arrives. So a push carries no
 * payload, the server holds no amounts, no bill names and no categories, and
 * someone with the subscription database learns that a user wants waking on
 * Tuesday morning and nothing more.
 *
 * Everything in this file is pure, so the part that decides what gets
 * announced and when is testable without a browser, a server or a clock.
 */

export interface Reminder {
  /** Stable across re-syncs, so re-running the schedule does not duplicate. */
  id: string;
  /** When to notify, as an epoch milliseconds value. */
  fireAt: number;
  title: string;
  body: string;
  /** The day the bill is actually due, for the notification's deep link. */
  dueDate: ISODate;
}

/** The hour of the day reminders land, in the user's local time. */
export const REMINDER_HOUR = 9;

/**
 * How far ahead to schedule. The client re-syncs whenever it opens, so this
 * only has to outlast a user who does not open the app for a while.
 */
export const HORIZON_DAYS = 45;

function at(date: ISODate, hour: number): number {
  // Local time on purpose: a reminder is useful at nine in the user's morning,
  // not at nine UTC.
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year!, (month ?? 1) - 1, day ?? 1, hour, 0, 0, 0).getTime();
}

/**
 * The reminders to schedule for a given state.
 *
 * One notification per day that has bills due, not one per bill: three separate
 * buzzes on the first of the month is how someone turns notifications off for
 * good.
 */
export function buildReminders(
  state: AppState,
  reference: ISODate,
  now: number = Date.now(),
): Reminder[] {
  if (!state.settings.billRemindersEnabled) return [];

  const lead = Math.max(0, state.settings.reminderLeadDays);
  const bills = upcomingBills(state, reference, HORIZON_DAYS);
  if (bills.length === 0) return [];

  // Group by the day the user should hear about them, which is the due date
  // pulled back by their chosen lead time.
  const byDay = new Map<ISODate, typeof bills>();
  for (const bill of bills) {
    const warnOn = shiftDate(bill.dueDate, -lead);
    const existing = byDay.get(warnOn);
    if (existing) existing.push(bill);
    else byDay.set(warnOn, [bill]);
  }

  const reminders: Reminder[] = [];

  for (const [warnOn, dayBills] of byDay) {
    const fireAt = at(warnOn, REMINDER_HOUR);
    // A reminder for a moment that has already passed is noise, not a
    // reminder. The dashboard already shows these.
    if (fireAt <= now) continue;

    const total = dayBills.reduce((sum, bill) => sum + bill.amountCents, 0);
    const first = dayBills[0]!;
    const when = describeWhen(warnOn, first.dueDate);

    reminders.push({
      id: `bills-${warnOn}`,
      fireAt,
      title:
        dayBills.length === 1
          ? `${first.name} ${when}`
          : `${dayBills.length} bills ${when}`,
      body:
        dayBills.length === 1
          ? `${formatMoney(first.amountCents)}${first.needsConfirmation ? ' — confirm the amount' : ''}`
          : `${formatMoney(total)} total: ${dayBills.map((bill) => bill.name).join(', ')}`,
      dueDate: first.dueDate,
    });
  }

  return reminders.sort((a, b) => a.fireAt - b.fireAt);
}

function describeWhen(warnOn: ISODate, dueDate: ISODate): string {
  const days = Math.round(
    (Date.parse(`${dueDate}T12:00:00Z`) - Date.parse(`${warnOn}T12:00:00Z`)) / 86_400_000,
  );
  if (days <= 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  return `due in ${days} days`;
}

function shiftDate(date: ISODate, days: number): ISODate {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * The only thing the server is given: when to wake the browser.
 *
 * Deliberately a separate function from `buildReminders` so that the split
 * between what stays local and what is transmitted is visible in one line
 * rather than buried in a request body somewhere.
 */
export function wakeTimes(reminders: Reminder[]): number[] {
  return [...new Set(reminders.map((reminder) => reminder.fireAt))].sort((a, b) => a - b);
}
