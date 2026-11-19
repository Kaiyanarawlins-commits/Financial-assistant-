import { describe, expect, it } from 'vitest';
import type { AppState, ExpenseEntry, IncomeEntry } from '../types';
import { customPeriod, monthPeriod } from './dates';
import {
  categoryBreakdown,
  computeSnapshot,
  effectivePosting,
  linesForCategory,
  pendingConfirmations,
  trend,
  upcomingBills,
} from './finance';
import { emptyState } from './storage';

const CYCLE = '2026-03';
const PERIOD = monthPeriod(CYCLE);
const MID_MONTH = '2026-03-15';

function stateWith(patch: Partial<AppState> = {}): AppState {
  return { ...emptyState(), ...patch };
}

function income(patch: Partial<IncomeEntry> = {}): IncomeEntry {
  return {
    id: 'inc1',
    source: 'Paycheck',
    amountCents: 600_000,
    recurrence: 'recurring',
    schedule: { kind: 'monthly-days', days: [1] },
    active: true,
    createdAt: '2026-01-01',
    ...patch,
  };
}

function expense(patch: Partial<ExpenseEntry> = {}): ExpenseEntry {
  return {
    id: 'exp1',
    name: 'Rent',
    amountCents: 150_000,
    categoryId: 'housing',
    recurrence: 'recurring',
    dueDay: 1,
    active: true,
    createdAt: '2026-01-01',
    ...patch,
  };
}

describe('remaining balance', () => {
  it('follows the spec worked example: 6000 − 1500 rent − 500 flight = 4000', () => {
    const state = stateWith({
      income: [income()],
      expenses: [
        expense({ id: 'rent', name: 'Rent', amountCents: 150_000 }),
        expense({
          id: 'flight',
          name: 'Plane ticket',
          amountCents: 50_000,
          categoryId: 'travel',
          recurrence: 'one-time',
          date: '2026-03-10',
          dueDay: undefined,
        }),
      ],
    });

    const snapshot = computeSnapshot(state, PERIOD, MID_MONTH);
    expect(snapshot.totalIncomeCents).toBe(600_000);
    expect(snapshot.recurringTotalCents).toBe(150_000);
    expect(snapshot.oneTimeTotalCents).toBe(50_000);
    expect(snapshot.remainingBalanceCents).toBe(400_000);
  });

  it('recalculates the moment an expense is removed', () => {
    const base = stateWith({ income: [income()], expenses: [expense()] });
    expect(computeSnapshot(base, PERIOD, MID_MONTH).remainingBalanceCents).toBe(450_000);

    const without = { ...base, expenses: [] };
    expect(computeSnapshot(without, PERIOD, MID_MONTH).remainingBalanceCents).toBe(600_000);
  });

  it('sums multiple income entries and multiple paydays', () => {
    const state = stateWith({
      income: [
        income({ id: 'a', amountCents: 300_000, schedule: { kind: 'monthly-days', days: [1, 15] } }),
        income({ id: 'b', source: 'Freelance', amountCents: 80_000, schedule: { kind: 'monthly-days', days: [20] } }),
      ],
    });
    // 3000 x 2 paydays + 800 = 6800
    expect(computeSnapshot(state, PERIOD, MID_MONTH).totalIncomeCents).toBe(680_000);
  });

  it('excludes inactive income', () => {
    const state = stateWith({ income: [income({ active: false })] });
    expect(computeSnapshot(state, PERIOD, MID_MONTH).totalIncomeCents).toBe(0);
  });

  it('counts a one-time income entry only in the period containing it', () => {
    const bonus = income({
      id: 'bonus',
      recurrence: 'one-time',
      amountCents: 100_000,
      schedule: { kind: 'one-time', date: '2026-03-20' },
    });
    const state = stateWith({ income: [bonus] });
    expect(computeSnapshot(state, PERIOD, MID_MONTH).totalIncomeCents).toBe(100_000);
    expect(computeSnapshot(state, monthPeriod('2026-04'), '2026-04-15').totalIncomeCents).toBe(0);
  });
});

describe('recurring expansion', () => {
  it('posts a recurring bill once per cycle, never twice', () => {
    const state = stateWith({ expenses: [expense()] });
    const lines = computeSnapshot(state, PERIOD, MID_MONTH).lines;
    expect(lines.filter((l) => l.name === 'Rent')).toHaveLength(1);
  });

  it('stays idempotent when the same cycle is computed repeatedly', () => {
    const state = stateWith({ expenses: [expense()] });
    const first = computeSnapshot(state, PERIOD, MID_MONTH).totalSpentCents;
    const second = computeSnapshot(state, PERIOD, MID_MONTH).totalSpentCents;
    const third = computeSnapshot(state, PERIOD, MID_MONTH).totalSpentCents;
    expect([first, second, third]).toEqual([150_000, 150_000, 150_000]);
  });

  it('does not bill cycles that ended before the expense was created', () => {
    const state = stateWith({ expenses: [expense({ createdAt: '2026-03-01' })] });
    expect(computeSnapshot(state, monthPeriod('2026-01'), '2026-01-31').totalSpentCents).toBe(0);
    expect(computeSnapshot(state, PERIOD, MID_MONTH).totalSpentCents).toBe(150_000);
  });

  it('clamps a day-31 bill to the last day of a short month', () => {
    const state = stateWith({ expenses: [expense({ dueDay: 31 })] });
    expect(effectivePosting(state, 'exp1', '2026-02')?.dueDate).toBe('2026-02-28');
    expect(effectivePosting(state, 'exp1', '2026-04')?.dueDate).toBe('2026-04-30');
    expect(effectivePosting(state, 'exp1', '2026-01')?.dueDate).toBe('2026-01-31');
  });

  it('handles a leap-year February', () => {
    const state = stateWith({ expenses: [expense({ dueDay: 30, createdAt: '2024-01-01' })] });
    expect(effectivePosting(state, 'exp1', '2024-02')?.dueDate).toBe('2024-02-29');
  });

  it('repeats across every cycle of a multi-month period', () => {
    const state = stateWith({ expenses: [expense()] });
    const quarter = customPeriod('2026-01-01', '2026-03-31');
    expect(computeSnapshot(state, quarter, '2026-03-31').totalSpentCents).toBe(450_000);
  });
});

describe('variable recurring bills', () => {
  it('flags a variable bill for confirmation instead of posting silently', () => {
    const state = stateWith({ expenses: [expense({ id: 'power', name: 'Electric', variable: true, dueDay: 12 })] });
    const pending = pendingConfirmations(state, MID_MONTH);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.name).toBe('Electric');
    expect(computeSnapshot(state, PERIOD, MID_MONTH).lines[0]?.needsConfirmation).toBe(true);
  });

  it('clears the flag once confirmed, and uses the confirmed amount', () => {
    const state = stateWith({
      expenses: [expense({ id: 'power', name: 'Electric', amountCents: 11_500, variable: true, dueDay: 12 })],
      postings: [
        {
          id: 'p1',
          expenseId: 'power',
          cycleKey: CYCLE,
          amountCents: 14_300,
          dueDate: '2026-03-12',
          status: 'posted',
        },
      ],
    });
    expect(pendingConfirmations(state, MID_MONTH)).toHaveLength(0);
    expect(computeSnapshot(state, PERIOD, MID_MONTH).totalSpentCents).toBe(14_300);
  });

  it('drops a skipped bill from the totals', () => {
    const state = stateWith({
      expenses: [expense()],
      postings: [
        { id: 'p1', expenseId: 'exp1', cycleKey: CYCLE, amountCents: 0, dueDate: '2026-03-01', status: 'skipped' },
      ],
    });
    expect(computeSnapshot(state, PERIOD, MID_MONTH).totalSpentCents).toBe(0);
  });

  it('confirms one cycle without affecting the next', () => {
    const state = stateWith({
      expenses: [expense({ id: 'power', amountCents: 10_000, variable: true, dueDay: 12 })],
      postings: [
        { id: 'p1', expenseId: 'power', cycleKey: CYCLE, amountCents: 25_000, dueDate: '2026-03-12', status: 'posted' },
      ],
    });
    expect(computeSnapshot(state, PERIOD, MID_MONTH).totalSpentCents).toBe(25_000);
    expect(computeSnapshot(state, monthPeriod('2026-04'), '2026-04-30').totalSpentCents).toBe(10_000);
  });
});

describe('safe-to-spend', () => {
  const state = stateWith({
    income: [income({ amountCents: 600_000, schedule: { kind: 'monthly-days', days: [1] } })],
    expenses: [
      expense({ id: 'rent', dueDay: 1, amountCents: 150_000 }),
      expense({ id: 'card', name: 'Car note', dueDay: 25, amountCents: 40_000, categoryId: 'auto' }),
    ],
  });

  it('is never more optimistic than the remaining balance', () => {
    const snapshot = computeSnapshot(state, PERIOD, MID_MONTH);
    expect(snapshot.safeToSpendCents).toBeLessThanOrEqual(snapshot.remainingBalanceCents);
  });

  it('holds back bills that have not landed yet', () => {
    const snapshot = computeSnapshot(state, PERIOD, MID_MONTH);
    // Received 6000, paid rent 1500 → cash 4500. Car note 400 still to come.
    expect(snapshot.cashOnHandCents).toBe(450_000);
    expect(snapshot.upcomingRecurringCents).toBe(40_000);
    expect(snapshot.safeToSpendCents).toBe(410_000);
  });

  it('does not double-count a bill that has already been paid', () => {
    // On the 26th the car note has landed; nothing should still be held back.
    const snapshot = computeSnapshot(state, PERIOD, '2026-03-26');
    expect(snapshot.upcomingRecurringCents).toBe(0);
    expect(snapshot.safeToSpendCents).toBe(snapshot.cashOnHandCents);
    expect(snapshot.safeToSpendCents).toBe(410_000);
  });

  it('ignores income that has not been received yet', () => {
    const twicePaid = stateWith({
      ...state,
      income: [income({ amountCents: 300_000, schedule: { kind: 'monthly-days', days: [1, 20] } })],
    });
    const snapshot = computeSnapshot(twicePaid, PERIOD, MID_MONTH);
    expect(snapshot.totalIncomeCents).toBe(600_000);
    expect(snapshot.incomeReceivedCents).toBe(300_000);
    // Only the first paycheck is in hand, so safe-to-spend cannot assume the second.
    expect(snapshot.safeToSpendCents).toBeLessThan(snapshot.remainingBalanceCents);
  });

  it('reserves unfunded goal balances when the user asks it to', () => {
    const withGoal = stateWith({
      ...state,
      goals: [
        {
          id: 'g1',
          name: 'Emergency fund',
          targetCents: 200_000,
          savedCents: 50_000,
          reserveFromSafeToSpend: true,
          createdAt: '2026-01-01',
        },
      ],
    });
    const before = computeSnapshot(state, PERIOD, MID_MONTH).safeToSpendCents;
    const after = computeSnapshot(withGoal, PERIOD, MID_MONTH).safeToSpendCents;
    expect(before - after).toBe(150_000);
  });

  it('ignores goals that are not flagged for reserve', () => {
    const withGoal = stateWith({
      ...state,
      goals: [
        {
          id: 'g1',
          name: 'Laptop',
          targetCents: 200_000,
          savedCents: 0,
          reserveFromSafeToSpend: false,
          createdAt: '2026-01-01',
        },
      ],
    });
    expect(computeSnapshot(withGoal, PERIOD, MID_MONTH).safeToSpendCents).toBe(
      computeSnapshot(state, PERIOD, MID_MONTH).safeToSpendCents,
    );
  });
});

describe('cash on hand', () => {
  // The bug this guards: without an anchored balance the engine assumes each
  // month opens at zero, so someone paid on the 1st and 15th who pays rent on
  // the 1st reads as overdrawn all month despite a healthy budget.
  const paidTwice = income({ amountCents: 300_000, schedule: { kind: 'monthly-days', days: [1, 15] } });
  const rent = expense({ id: 'rent', dueDay: 1, amountCents: 250_000 });

  it('falls back to the within-period basis when no balance is set', () => {
    const state = stateWith({ income: [paidTwice], expenses: [rent] });
    const snapshot = computeSnapshot(state, PERIOD, '2026-03-10');
    expect(snapshot.cashOnHandAnchored).toBe(false);
    expect(snapshot.cashOnHandCents).toBe(50_000); // 3000 received − 2500 rent
  });

  it('rolls an anchored balance forward with paydays and spending', () => {
    const state = stateWith({
      income: [paidTwice],
      expenses: [rent],
      settings: {
        ...emptyState().settings,
        accountBalanceCents: 400_000,
        accountBalanceAsOf: '2026-02-28',
      },
    });
    const snapshot = computeSnapshot(state, PERIOD, '2026-03-10');
    // 4000 opening + 3000 paid on the 1st − 2500 rent on the 1st = 4500
    expect(snapshot.cashOnHandAnchored).toBe(true);
    expect(snapshot.cashOnHandCents).toBe(450_000);
  });

  it('excludes the anchor date itself from the roll-forward', () => {
    // The stated balance already accounts for the 1st, so rent and the paycheck
    // on that date must not be applied a second time.
    const state = stateWith({
      income: [paidTwice],
      expenses: [rent],
      settings: {
        ...emptyState().settings,
        accountBalanceCents: 400_000,
        accountBalanceAsOf: '2026-03-01',
      },
    });
    expect(computeSnapshot(state, PERIOD, '2026-03-10').cashOnHandCents).toBe(400_000);
  });

  it('picks up a payday that lands after the anchor', () => {
    const state = stateWith({
      income: [paidTwice],
      expenses: [],
      settings: {
        ...emptyState().settings,
        accountBalanceCents: 100_000,
        accountBalanceAsOf: '2026-03-10',
      },
    });
    expect(computeSnapshot(state, PERIOD, '2026-03-20').cashOnHandCents).toBe(400_000);
  });

  it('treats a future-dated balance as current rather than extrapolating backwards', () => {
    const state = stateWith({
      income: [paidTwice],
      expenses: [rent],
      settings: {
        ...emptyState().settings,
        accountBalanceCents: 250_000,
        accountBalanceAsOf: '2026-03-25',
      },
    });
    expect(computeSnapshot(state, PERIOD, '2026-03-10').cashOnHandCents).toBe(250_000);
  });

  it('keeps safe-to-spend positive for a healthy budget with front-loaded bills', () => {
    const state = stateWith({
      income: [paidTwice],
      expenses: [rent, expense({ id: 'phone', name: 'Phone', dueDay: 20, amountCents: 6_000 })],
      settings: {
        ...emptyState().settings,
        accountBalanceCents: 400_000,
        accountBalanceAsOf: '2026-02-28',
      },
    });
    const snapshot = computeSnapshot(state, PERIOD, '2026-03-10');
    expect(snapshot.safeToSpendCents).toBeGreaterThan(0);
    expect(snapshot.safeToSpendCents).toBe(444_000); // 4500 cash − 60 phone still to come
  });
});

describe('buffer mode', () => {
  it('only holds back bills due before the next payday', () => {
    const base = stateWith({
      income: [income({ amountCents: 300_000, schedule: { kind: 'monthly-days', days: [1, 15] } })],
      expenses: [
        expense({ id: 'rent', dueDay: 1, amountCents: 100_000 }),
        // Due on the 18th — after the next payday on the 15th.
        expense({ id: 'card', name: 'Car note', dueDay: 18, amountCents: 40_000, categoryId: 'auto' }),
      ],
    });
    const reference = '2026-03-10';

    const normal = computeSnapshot(base, PERIOD, reference);
    const buffered = computeSnapshot(
      { ...base, settings: { ...base.settings, bufferMode: true } },
      PERIOD,
      reference,
    );

    expect(normal.safeToSpendCents).toBe(160_000); // 3000 − 1000 rent − 400 car note
    expect(buffered.nextPayday).toBe('2026-03-15');
    expect(buffered.safeToSpendCents).toBe(200_000); // car note lands after the next paycheck
  });

  it('still holds back a bill that lands before the next payday', () => {
    const base = stateWith({
      income: [income({ amountCents: 300_000, schedule: { kind: 'monthly-days', days: [1, 20] } })],
      expenses: [expense({ id: 'card', name: 'Car note', dueDay: 12, amountCents: 40_000 })],
      settings: { ...emptyState().settings, bufferMode: true },
    });
    const snapshot = computeSnapshot(base, PERIOD, '2026-03-05');
    expect(snapshot.safeToSpendCents).toBe(260_000); // 3000 − 400 due on the 12th
  });
});

describe('income schedules', () => {
  it('pays biweekly from the anchor', () => {
    const state = stateWith({
      income: [income({ amountCents: 200_000, schedule: { kind: 'biweekly', anchor: '2026-01-02' } })],
    });
    // 2026-01-02 + 14n lands on Mar 13 and Mar 27.
    expect(computeSnapshot(state, PERIOD, '2026-03-31').totalIncomeCents).toBe(400_000);
  });

  it('pays weekly from the anchor', () => {
    const state = stateWith({
      income: [income({ amountCents: 50_000, schedule: { kind: 'weekly', anchor: '2026-03-02' } })],
    });
    // Mar 2, 9, 16, 23, 30 → five paydays.
    expect(computeSnapshot(state, PERIOD, '2026-03-31').totalIncomeCents).toBe(250_000);
  });

  it('clamps a day-31 payday in a short month', () => {
    const state = stateWith({
      income: [income({ amountCents: 100_000, schedule: { kind: 'monthly-days', days: [31] } })],
    });
    expect(computeSnapshot(state, monthPeriod('2026-02'), '2026-02-28').totalIncomeCents).toBe(100_000);
  });
});

describe('irregular income mode', () => {
  it('replaces scheduled income with a trailing average', () => {
    const state = stateWith({
      income: [
        income({ id: 'a', amountCents: 200_000, schedule: { kind: 'one-time', date: '2025-12-10' } }),
        income({ id: 'b', amountCents: 800_000, schedule: { kind: 'one-time', date: '2026-01-10' } }),
        income({ id: 'c', amountCents: 500_000, schedule: { kind: 'one-time', date: '2026-02-10' } }),
      ],
      settings: { ...emptyState().settings, irregularIncomeMode: true, irregularLookbackMonths: 3 },
    });
    // (2000 + 8000 + 5000) / 3 = 5000
    expect(computeSnapshot(state, PERIOD, MID_MONTH).totalIncomeCents).toBe(500_000);
  });

  it('falls back to scheduled income when there is no history', () => {
    const state = stateWith({
      income: [income({ amountCents: 600_000 })],
      settings: { ...emptyState().settings, irregularIncomeMode: true },
    });
    expect(computeSnapshot(state, PERIOD, MID_MONTH).totalIncomeCents).toBe(600_000);
  });
});

describe('category breakdown', () => {
  const state = stateWith({
    expenses: [
      expense({ id: 'rent', amountCents: 150_000, categoryId: 'housing' }),
      expense({ id: 'car', amountCents: 30_000, categoryId: 'auto', dueDay: 5 }),
      expense({
        id: 'flight',
        amountCents: 20_000,
        categoryId: 'auto',
        recurrence: 'one-time',
        date: '2026-03-08',
        dueDay: undefined,
      }),
    ],
  });

  it('splits spend by category with percentages summing to 100', () => {
    const breakdown = computeSnapshot(state, PERIOD, MID_MONTH).categories;
    expect(breakdown[0]).toMatchObject({ categoryId: 'housing', spentCents: 150_000 });
    expect(breakdown[1]).toMatchObject({ categoryId: 'auto', spentCents: 50_000 });
    expect(breakdown.reduce((a, c) => a + c.percent, 0)).toBeCloseTo(100, 6);
  });

  it('returns the transactions behind a category for the drill-down', () => {
    const snapshot = computeSnapshot(state, PERIOD, MID_MONTH);
    const lines = linesForCategory(snapshot.lines, 'auto');
    expect(lines.map((l) => l.amountCents)).toEqual([30_000, 20_000]);
  });

  it('reports cap usage when a soft cap is set', () => {
    const capped = stateWith({
      ...state,
      categories: emptyState().categories.map((c) =>
        c.id === 'auto' ? { ...c, monthlyCapCents: 40_000 } : c,
      ),
    });
    const auto = computeSnapshot(capped, PERIOD, MID_MONTH).categories.find((c) => c.categoryId === 'auto');
    expect(auto?.capPercent).toBeCloseTo(125, 6);
  });

  it('reports zero percent rather than dividing by zero on an empty period', () => {
    expect(categoryBreakdown(emptyState(), [])).toEqual([]);
  });
});

describe('trend', () => {
  it('reports one point per month, oldest first', () => {
    const state = stateWith({ expenses: [expense({ createdAt: '2025-01-01' })] });
    const points = trend(state, MID_MONTH, 6);
    expect(points).toHaveLength(6);
    expect(points[0]?.cycleKey).toBe('2025-10');
    expect(points[5]?.cycleKey).toBe('2026-03');
    expect(points.every((p) => p.totalSpentCents === 150_000)).toBe(true);
  });

  it('breaks each month down by category', () => {
    const state = stateWith({ expenses: [expense({ createdAt: '2025-01-01' })] });
    expect(trend(state, MID_MONTH, 2)[0]?.byCategory.housing).toBe(150_000);
  });
});

describe('upcoming bills', () => {
  it('lists bills due within the window, soonest first', () => {
    const state = stateWith({
      expenses: [
        expense({ id: 'a', name: 'Internet', dueDay: 18 }),
        expense({ id: 'b', name: 'Phone', dueDay: 16 }),
        expense({ id: 'c', name: 'Far off', dueDay: 28 }),
      ],
    });
    const bills = upcomingBills(state, MID_MONTH, 7);
    expect(bills.map((b) => b.name)).toEqual(['Phone', 'Internet']);
    expect(bills[0]?.daysAway).toBe(1);
  });

  it('looks into next month so a bill due on the 2nd warns on the 30th', () => {
    const state = stateWith({ expenses: [expense({ name: 'Rent', dueDay: 2 })] });
    const bills = upcomingBills(state, '2026-03-30', 5);
    expect(bills[0]?.dueDate).toBe('2026-04-02');
    expect(bills[0]?.daysAway).toBe(3);
  });

  it('excludes bills that have already been paid', () => {
    const state = stateWith({ expenses: [expense({ dueDay: 1 })] });
    expect(upcomingBills(state, MID_MONTH, 7)).toHaveLength(0);
  });
});

describe('period modes', () => {
  it('accumulates across a year-to-date window', () => {
    const state = stateWith({
      income: [income({ amountCents: 100_000 })],
      expenses: [expense({ amountCents: 10_000, createdAt: '2026-01-01' })],
    });
    const ytd = customPeriod('2026-01-01', '2026-03-15');
    const snapshot = computeSnapshot(state, ytd, '2026-03-15');
    expect(snapshot.totalIncomeCents).toBe(300_000);
    expect(snapshot.totalSpentCents).toBe(30_000);
  });

  it('normalises a custom range given backwards', () => {
    const period = customPeriod('2026-03-31', '2026-03-01');
    expect(period.start).toBe('2026-03-01');
    expect(period.end).toBe('2026-03-31');
  });
});
