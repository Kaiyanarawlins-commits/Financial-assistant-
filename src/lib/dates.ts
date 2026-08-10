import type { CycleKey, ISODate, IncomeSchedule, Period } from '../types';

/**
 * All date maths here is done on plain `YYYY-MM-DD` strings via UTC-noon Date
 * objects. Constructing at noon rather than midnight means a daylight-saving
 * shift can never bump a date onto the previous or next day, which is how
 * "rent is due the 1st" quietly becomes "due the 31st" in naive implementations.
 */

const MS_PER_DAY = 86_400_000;

export function toDate(iso: ISODate): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12));
}

export function toISO(date: Date): ISODate {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Today in the *browser's* local zone, as an ISO date. */
export function today(): ISODate {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(iso: ISODate, days: number): ISODate {
  return toISO(new Date(toDate(iso).getTime() + days * MS_PER_DAY));
}

export function daysBetween(from: ISODate, to: ISODate): number {
  return Math.round((toDate(to).getTime() - toDate(from).getTime()) / MS_PER_DAY);
}

export function compare(a: ISODate, b: ISODate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isWithin(iso: ISODate, period: Period): boolean {
  return iso >= period.start && iso <= period.end;
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/**
 * Clamps a day-of-month to a month that may be shorter. A bill due on the 31st
 * lands on the 30th in April and the 28th in a non-leap February — it does not
 * silently skip the month.
 */
export function clampDayToMonth(day: number, year: number, month1: number): number {
  return Math.min(Math.max(1, day), daysInMonth(year, month1));
}

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

export function cycleKeyOf(iso: ISODate): CycleKey {
  return iso.slice(0, 7);
}

export function parseCycleKey(key: CycleKey): { year: number; month1: number } {
  const [y, m] = key.split('-').map(Number);
  return { year: y ?? 1970, month1: m ?? 1 };
}

export function cycleStart(key: CycleKey): ISODate {
  return `${key}-01`;
}

export function cycleEnd(key: CycleKey): ISODate {
  const { year, month1 } = parseCycleKey(key);
  return `${key}-${String(daysInMonth(year, month1)).padStart(2, '0')}`;
}

export function shiftCycle(key: CycleKey, months: number): CycleKey {
  const { year, month1 } = parseCycleKey(key);
  const zero = year * 12 + (month1 - 1) + months;
  return `${Math.floor(zero / 12)}-${String((zero % 12) + 1).padStart(2, '0')}`;
}

/** Every cycle key from `from` to `to` inclusive, chronologically. */
export function cyclesBetween(from: CycleKey, to: CycleKey): CycleKey[] {
  const out: CycleKey[] = [];
  let cursor = from;
  // Guard against an inverted range producing an unbounded loop.
  for (let i = 0; i < 600 && cursor <= to; i++) {
    out.push(cursor);
    cursor = shiftCycle(cursor, 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

export function monthPeriod(key: CycleKey): Period {
  const { year, month1 } = parseCycleKey(key);
  const label = new Date(Date.UTC(year, month1 - 1, 15)).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return { start: cycleStart(key), end: cycleEnd(key), label };
}

export function ytdPeriod(reference: ISODate): Period {
  const year = reference.slice(0, 4);
  return { start: `${year}-01-01`, end: reference, label: `${year} year to date` };
}

export function customPeriod(start: ISODate, end: ISODate): Period {
  const [lo, hi] = start <= end ? [start, end] : [end, start];
  return { start: lo, end: hi, label: `${formatShort(lo)} – ${formatShort(hi)}` };
}

/** Cycles a period touches, so recurring bills can be expanded across it. */
export function cyclesInPeriod(period: Period): CycleKey[] {
  return cyclesBetween(cycleKeyOf(period.start), cycleKeyOf(period.end));
}

// ---------------------------------------------------------------------------
// Income schedules
// ---------------------------------------------------------------------------

/**
 * Every date an income entry pays out inside `period`.
 *
 * Recurring entries repeat according to their schedule; a `one-time` schedule
 * contributes at most a single date and only if it falls inside the window.
 */
export function paydaysInPeriod(schedule: IncomeSchedule, period: Period): ISODate[] {
  switch (schedule.kind) {
    case 'one-time':
      return isWithin(schedule.date, period) ? [schedule.date] : [];

    case 'monthly-days': {
      const out: ISODate[] = [];
      for (const key of cyclesInPeriod(period)) {
        const { year, month1 } = parseCycleKey(key);
        for (const day of schedule.days) {
          const clamped = clampDayToMonth(day, year, month1);
          const iso = `${key}-${String(clamped).padStart(2, '0')}`;
          if (isWithin(iso, period)) out.push(iso);
        }
      }
      return out.sort(compare);
    }

    case 'weekly':
    case 'biweekly': {
      const step = schedule.kind === 'weekly' ? 7 : 14;
      const out: ISODate[] = [];
      // Walk forward or backward from the anchor to the first payday that is
      // not before the window, then step through it.
      const offset = daysBetween(schedule.anchor, period.start);
      const steps = Math.ceil(offset / step);
      let cursor = addDays(schedule.anchor, steps * step);
      while (cursor < period.start) cursor = addDays(cursor, step);
      while (cursor <= period.end) {
        out.push(cursor);
        cursor = addDays(cursor, step);
      }
      return out;
    }
  }
}

/** The soonest payday at or after `from`, searched up to a year out. */
export function nextPaydayOnOrAfter(schedule: IncomeSchedule, from: ISODate): ISODate | null {
  const window: Period = { start: from, end: addDays(from, 366), label: '' };
  return paydaysInPeriod(schedule, window)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatShort(iso: ISODate): string {
  return toDate(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function formatLong(iso: ISODate): string {
  return toDate(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function formatMonthShort(key: CycleKey): string {
  const { year, month1 } = parseCycleKey(key);
  return new Date(Date.UTC(year, month1 - 1, 15)).toLocaleDateString(undefined, {
    month: 'short',
    timeZone: 'UTC',
  });
}

/** "in 3 days" / "today" / "2 days ago", for bill reminders. */
export function relativeDays(from: ISODate, to: ISODate): string {
  const d = daysBetween(from, to);
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d === -1) return 'yesterday';
  return d > 0 ? `in ${d} days` : `${-d} days ago`;
}
