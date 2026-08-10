import type { AppState, ExpenseEntry, ISODate } from '../types';
import { cycleKeyOf, shiftCycle, today } from './dates';
import { newId } from './id';
import { emptyState } from './storage';

/**
 * Demo data, generated relative to the current date so the dashboard, trend
 * chart and reminders all have something real to show on first run. Built
 * around the worked example in the spec — $6,000 income, $1,500 rent, a $500
 * plane ticket — then filled out into a plausible month.
 */
export function seedState(reference: ISODate = today()): AppState {
  const state = emptyState();
  const currentCycle = cycleKeyOf(reference);
  const monthsBack = (n: number) => shiftCycle(currentCycle, -n);
  // Recurring bills only apply from their creation date forward, so backdating
  // the templates five months is what gives the trend chart its history.
  const openedAt: ISODate = `${monthsBack(5)}-01`;

  state.income = [
    {
      id: newId('inc'),
      source: 'Paycheck — Northwind Design',
      amountCents: 300_000,
      recurrence: 'recurring',
      schedule: { kind: 'monthly-days', days: [1, 15] },
      active: true,
      createdAt: openedAt,
    },
    {
      id: newId('inc'),
      source: 'Freelance — retainer',
      amountCents: 80_000,
      recurrence: 'recurring',
      schedule: { kind: 'monthly-days', days: [20] },
      active: true,
      createdAt: openedAt,
    },
  ];

  const recurring = (
    name: string,
    amountCents: number,
    categoryId: string,
    dueDay: number,
    variable = false,
  ): ExpenseEntry => ({
    id: newId('exp'),
    name,
    amountCents,
    categoryId,
    recurrence: 'recurring',
    dueDay,
    variable,
    active: true,
    createdAt: openedAt,
  });

  const oneTime = (
    name: string,
    amountCents: number,
    categoryId: string,
    date: ISODate,
  ): ExpenseEntry => ({
    id: newId('exp'),
    name,
    amountCents,
    categoryId,
    recurrence: 'one-time',
    date,
    active: true,
    createdAt: date,
  });

  state.expenses = [
    recurring('Rent', 150_000, 'housing', 1),
    recurring('Car note', 38_500, 'auto', 5),
    recurring('Auto insurance', 14_200, 'insurance', 8),
    recurring('Electric', 11_500, 'utilities', 12, true),
    recurring('Internet', 7_500, 'utilities', 14),
    recurring('Phone', 6_500, 'utilities', 18),
    recurring('Gym', 3_900, 'health', 10),
    recurring('Streaming — video', 1_899, 'subscriptions', 6),
    recurring('Streaming — music', 1_099, 'subscriptions', 9),
    recurring('Cloud storage', 999, 'subscriptions', 22),
    recurring('Student loan', 28_000, 'debt', 21),
    recurring('Groceries — standing budget', 52_000, 'groceries', 2),

    oneTime('Plane ticket — Denver', 50_000, 'travel', `${currentCycle}-04`),
    oneTime('Dinner — birthday', 12_400, 'dining', `${currentCycle}-07`),
    oneTime('Concert tickets', 8_800, 'entertainment', `${currentCycle}-09`),
    oneTime('Dentist copay', 7_500, 'health', `${currentCycle}-11`),

    oneTime('Winter coat', 18_000, 'misc', `${monthsBack(1)}-14`),
    oneTime('Weekend trip', 34_000, 'travel', `${monthsBack(1)}-22`),
    oneTime('Dining out', 9_600, 'dining', `${monthsBack(1)}-08`),
    oneTime('Dining out', 7_200, 'dining', `${monthsBack(2)}-17`),
    oneTime('Car repair', 62_000, 'auto', `${monthsBack(2)}-05`),
    oneTime('Dining out', 5_400, 'dining', `${monthsBack(3)}-12`),
    oneTime('Gift', 6_000, 'misc', `${monthsBack(3)}-19`),
  ];

  state.goals = [
    {
      id: newId('goal'),
      name: 'Emergency fund',
      targetCents: 200_000,
      savedCents: 65_000,
      reserveFromSafeToSpend: false,
      createdAt: openedAt,
    },
    {
      id: newId('goal'),
      name: 'New laptop',
      targetCents: 180_000,
      savedCents: 40_000,
      reserveFromSafeToSpend: false,
      createdAt: openedAt,
    },
  ];

  state.debts = [
    { id: newId('debt'), name: 'Visa — everyday card', balanceCents: 340_000, aprPercent: 24.99, minimumPaymentCents: 8_500 },
    { id: newId('debt'), name: 'Store card', balanceCents: 92_000, aprPercent: 29.99, minimumPaymentCents: 3_500 },
    { id: newId('debt'), name: 'Student loan', balanceCents: 1_840_000, aprPercent: 5.5, minimumPaymentCents: 28_000 },
  ];

  state.netWorth = [
    { id: newId('nw'), date: `${monthsBack(4)}-01`, assetsCents: 820_000, liabilitiesCents: 2_450_000 },
    { id: newId('nw'), date: `${monthsBack(2)}-01`, assetsCents: 1_050_000, liabilitiesCents: 2_380_000 },
    { id: newId('nw'), date: `${currentCycle}-01`, assetsCents: 1_240_000, liabilitiesCents: 2_272_000 },
  ];

  // Anchor safe-to-spend to a real opening balance at the start of the month.
  // Without this the demo would assume the account starts every cycle at zero.
  state.settings.accountBalanceCents = 412_000;
  state.settings.accountBalanceAsOf = `${currentCycle}-01`;

  // A couple of soft caps so the alert path is visible in the demo.
  state.categories = state.categories.map((c) =>
    c.id === 'entertainment'
      ? { ...c, monthlyCapCents: 10_000 }
      : c.id === 'dining'
        ? { ...c, monthlyCapCents: 20_000 }
        : c,
  );

  return state;
}
