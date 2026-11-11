import { describe, expect, it } from 'vitest';
import type { AppState } from '../types';
import { seedState } from './seed';
import { billsOverview, existingGroups, groupNameFor, nextDueDate } from './bills';

const REFERENCE = '2026-11-11';

const demo = (): AppState => seedState(REFERENCE);

describe('next due date', () => {
  it('stays in this month when the day has not passed', () => {
    expect(nextDueDate(20, '2026-11-11')).toBe('2026-11-20');
  });

  it('rolls to next month once the day has gone', () => {
    expect(nextDueDate(5, '2026-11-11')).toBe('2026-12-05');
  });

  it('counts today as due today rather than rolling it forward', () => {
    expect(nextDueDate(11, '2026-11-11')).toBe('2026-11-11');
  });

  it('clamps a day the month does not have', () => {
    // A bill on the 31st lands on the 30th in November, not in December.
    expect(nextDueDate(31, '2026-11-11')).toBe('2026-11-30');
    expect(nextDueDate(30, '2027-02-15')).toBe('2027-02-28');
  });
});

describe('grouping', () => {
  it('falls back to the category, so the view works before anything is filed', () => {
    const state = demo();
    const rent = state.expenses.find((expense) => expense.name === 'Rent')!;
    expect(groupNameFor(rent, state)).toBe('Housing');
  });

  it('prefers a custom group when one is set', () => {
    const state = demo();
    const rent = state.expenses.find((expense) => expense.name === 'Rent')!;
    rent.billGroup = 'The flat';
    expect(groupNameFor(rent, state)).toBe('The flat');
  });

  it('ignores a group that is only whitespace', () => {
    const state = demo();
    const rent = state.expenses.find((expense) => expense.name === 'Rent')!;
    rent.billGroup = '   ';
    expect(groupNameFor(rent, state)).toBe('Housing');
  });

  it('offers the names already in use for the picker', () => {
    const state = demo();
    state.expenses.find((expense) => expense.name === 'Rent')!.billGroup = 'The flat';
    const names = existingGroups(state);
    expect(names).toContain('The flat');
    expect(names).not.toContain('Housing');
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });
});

describe('bills overview', () => {
  it('totals only the active recurring bills', () => {
    const state = demo();
    const overview = billsOverview(state, REFERENCE);
    const expected = state.expenses.filter((e) => e.recurrence === 'recurring' && e.active).length;

    expect(overview.count).toBe(expected);
    expect(overview.monthlyTotalCents).toBeGreaterThan(0);
    // One-time spending must not be counted as a monthly commitment.
    expect(overview.groups.flatMap((g) => g.bills).some((b) => b.name.includes('Plane'))).toBe(false);
  });

  it('group totals sum to the overall total', () => {
    const overview = billsOverview(demo(), REFERENCE);
    const summed = overview.groups.reduce((total, group) => total + group.monthlyTotalCents, 0);
    expect(summed).toBe(overview.monthlyTotalCents);
  });

  it('orders groups by what they cost, biggest first', () => {
    const totals = billsOverview(demo(), REFERENCE).groups.map((g) => g.monthlyTotalCents);
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);
  });

  it('orders bills within a group by how soon they land', () => {
    for (const group of billsOverview(demo(), REFERENCE).groups) {
      const days = group.bills.map((bill) => bill.daysAway);
      expect([...days].sort((a, b) => a - b)).toEqual(days);
    }
  });

  it('never reports a bill as already past', () => {
    for (const group of billsOverview(demo(), REFERENCE).groups) {
      for (const bill of group.bills) {
        expect(bill.daysAway).toBeGreaterThanOrEqual(0);
        expect(bill.nextDueDate >= REFERENCE).toBe(true);
      }
    }
  });

  it('picks out what falls inside the reminder window', () => {
    const state = demo();
    state.settings.reminderLeadDays = 3;
    const overview = billsOverview(state, REFERENCE);

    expect(overview.dueSoon.every((bill) => bill.daysAway <= 3)).toBe(true);
    expect(overview.dueSoonTotalCents).toBe(
      overview.dueSoon.reduce((sum, bill) => sum + bill.amountCents, 0),
    );
  });

  it('widens the window when the user asks for more warning', () => {
    const state = demo();
    const narrow = billsOverview(state, REFERENCE, 1).dueSoon.length;
    const wide = billsOverview(state, REFERENCE, 14).dueSoon.length;
    expect(wide).toBeGreaterThanOrEqual(narrow);
  });

  it('names the next bill to land', () => {
    const overview = billsOverview(demo(), REFERENCE);
    const earliest = Math.min(
      ...overview.groups.flatMap((group) => group.bills.map((bill) => bill.daysAway)),
    );
    expect(overview.next?.daysAway).toBe(earliest);
  });

  it('separates bills into the custom groups they are given', () => {
    const state = demo();
    for (const expense of state.expenses) {
      if (expense.recurrence === 'recurring' && expense.categoryId === 'subscriptions') {
        expense.billGroup = 'Streaming';
      }
    }
    const overview = billsOverview(state, REFERENCE);
    const streaming = overview.groups.find((group) => group.name === 'Streaming');

    expect(streaming).toBeDefined();
    expect(streaming!.bills.length).toBeGreaterThan(0);
    expect(streaming!.bills.every((bill) => bill.categoryId === 'subscriptions')).toBe(true);
  });

  it('reports a variable bill that still needs confirming', () => {
    const state = demo();
    const overview = billsOverview(state, REFERENCE);
    const variable = overview.groups.flatMap((g) => g.bills).filter((bill) => bill.variable);
    expect(variable.length).toBeGreaterThan(0);
  });

  it('returns an empty overview rather than throwing when there are no bills', () => {
    const state = demo();
    state.expenses = [];
    const overview = billsOverview(state, REFERENCE);

    expect(overview.count).toBe(0);
    expect(overview.groups).toEqual([]);
    expect(overview.monthlyTotalCents).toBe(0);
    expect(overview.next).toBeNull();
  });
});
