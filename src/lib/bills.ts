import type { AppState, ISODate } from '../types';
import { findCategory } from './categories';
import { clampDayToMonth, cycleKeyOf, parseCycleKey, relativeDays, shiftCycle } from './dates';
import { effectivePosting } from './finance';

/**
 * The bills view.
 *
 * Everything the app knew about recurring bills was already here, scattered:
 * the dashboard showed the next few days, the Money tab listed the expenses,
 * and the reminder settings sat six cards into Settings. Three true views of
 * one thing, and no single place that answered "what do I pay every month, and
 * when does it land".
 *
 * This assembles that answer. It is pure, so what counts as a group and what
 * counts as due is testable without a browser.
 */

export interface BillLine {
  expenseId: string;
  name: string;
  amountCents: number;
  categoryId: string;
  categoryName: string;
  groupName: string;
  /** Day of the month it lands, 1–31, clamped per month when it falls short. */
  dueDay: number;
  /** The next date it actually lands, on or after the reference date. */
  nextDueDate: ISODate;
  daysAway: number;
  /** "tomorrow", "in 3 days" — the phrasing already used on the dashboard. */
  whenLabel: string;
  /** A usage-based bill whose amount is confirmed each cycle. */
  variable: boolean;
  /** This cycle's amount has not been confirmed yet, so it is last month's. */
  needsConfirmation: boolean;
}

export interface BillGroup {
  name: string;
  bills: BillLine[];
  monthlyTotalCents: number;
  /** Share of the monthly bill total, 0–100. */
  percentOfBills: number;
  /** Bills in this group landing inside the reminder window. */
  dueSoonCount: number;
}

export interface BillsOverview {
  groups: BillGroup[];
  monthlyTotalCents: number;
  count: number;
  /** Bills landing within the user's lead time, and what they come to. */
  dueSoon: BillLine[];
  dueSoonTotalCents: number;
  /** The very next bill to land, whenever that is. */
  next: BillLine | null;
  /** Bills whose amount this cycle is still unconfirmed. */
  needsConfirmation: BillLine[];
}

/**
 * The group a bill belongs to.
 *
 * A custom name wins, and the category is the fallback. Defaulting to the
 * category rather than to "Ungrouped" means the view is useful the moment it
 * opens, without anyone having to file twelve bills by hand first.
 */
export function groupNameFor(
  expense: { billGroup?: string; categoryId: string },
  state: AppState,
): string {
  const custom = expense.billGroup?.trim();
  if (custom) return custom;
  return findCategory(state.categories, expense.categoryId).name;
}

/** The next date a monthly bill on `dueDay` lands, on or after `reference`. */
export function nextDueDate(dueDay: number, reference: ISODate): ISODate {
  const thisCycle = cycleKeyOf(reference);
  for (const cycleKey of [thisCycle, shiftCycle(thisCycle, 1)]) {
    const { year, month1 } = parseCycleKey(cycleKey);
    const day = clampDayToMonth(dueDay, year, month1);
    const candidate = `${cycleKey}-${String(day).padStart(2, '0')}`;
    if (candidate >= reference) return candidate;
  }
  // Unreachable for a sane dueDay, but a date must always come back.
  const next = shiftCycle(thisCycle, 1);
  const { year, month1 } = parseCycleKey(next);
  return `${next}-${String(clampDayToMonth(dueDay, year, month1)).padStart(2, '0')}`;
}

const daysBetweenDates = (from: ISODate, to: ISODate): number =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

export function billsOverview(
  state: AppState,
  reference: ISODate,
  leadDays: number = state.settings.reminderLeadDays,
): BillsOverview {
  const cycleKey = cycleKeyOf(reference);

  const lines: BillLine[] = state.expenses
    .filter((expense) => expense.recurrence === 'recurring' && expense.active)
    .map((expense) => {
      const dueDay = expense.dueDay ?? 1;
      const due = nextDueDate(dueDay, reference);
      // The posting carries this cycle's real amount once confirmed, which is
      // what makes a variable bill show what it actually came to rather than
      // the template figure.
      const posting = effectivePosting(state, expense.id, cycleKeyOf(due));
      const category = findCategory(state.categories, expense.categoryId);

      return {
        expenseId: expense.id,
        name: expense.name,
        amountCents: posting?.amountCents ?? expense.amountCents,
        categoryId: expense.categoryId,
        categoryName: category.name,
        groupName: groupNameFor(expense, state),
        dueDay,
        nextDueDate: due,
        daysAway: daysBetweenDates(reference, due),
        whenLabel: relativeDays(reference, due),
        variable: Boolean(expense.variable),
        needsConfirmation: posting?.status === 'needs-confirmation',
      };
    })
    .sort((a, b) => a.daysAway - b.daysAway || a.name.localeCompare(b.name));

  const monthlyTotalCents = lines.reduce((sum, line) => sum + line.amountCents, 0);

  const byGroup = new Map<string, BillLine[]>();
  for (const line of lines) {
    const existing = byGroup.get(line.groupName);
    if (existing) existing.push(line);
    else byGroup.set(line.groupName, [line]);
  }

  const groups: BillGroup[] = [...byGroup.entries()]
    .map(([name, bills]) => {
      const total = bills.reduce((sum, bill) => sum + bill.amountCents, 0);
      return {
        name,
        bills,
        monthlyTotalCents: total,
        percentOfBills: monthlyTotalCents > 0 ? (total / monthlyTotalCents) * 100 : 0,
        dueSoonCount: bills.filter((bill) => bill.daysAway <= leadDays).length,
      };
    })
    // Biggest first: the point of grouping is to see what dominates.
    .sort((a, b) => b.monthlyTotalCents - a.monthlyTotalCents);

  const dueSoon = lines.filter((line) => line.daysAway <= leadDays);

  return {
    groups,
    monthlyTotalCents,
    count: lines.length,
    dueSoon,
    dueSoonTotalCents: dueSoon.reduce((sum, line) => sum + line.amountCents, 0),
    next: lines[0] ?? null,
    needsConfirmation: lines.filter(
      (line) => line.needsConfirmation && cycleKeyOf(line.nextDueDate) === cycleKey,
    ),
  };
}

/** Group names already in use, for the picker on the expense form. */
export function existingGroups(state: AppState): string[] {
  const names = new Set<string>();
  for (const expense of state.expenses) {
    if (expense.recurrence !== 'recurring') continue;
    names.add(groupNameFor(expense, state));
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}
