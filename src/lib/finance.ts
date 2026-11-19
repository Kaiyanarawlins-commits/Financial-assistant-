import type {
  AppState,
  CategoryBreakdown,
  CycleKey,
  ISODate,
  LedgerLine,
  Period,
  Posting,
  Snapshot,
} from '../types';
import { findCategory } from './categories';
import {
  addDays,
  clampDayToMonth,
  cycleEnd,
  cycleKeyOf,
  cycleStart,
  cyclesInPeriod,
  isWithin,
  monthPeriod,
  nextPaydayOnOrAfter,
  parseCycleKey,
  paydaysInPeriod,
  shiftCycle,
} from './dates';
import { sumBy } from './money';

/**
 * The calculation engine.
 *
 * Everything here is a pure function of (state, period, referenceDate). Nothing
 * mutates, nothing reads the clock, nothing touches storage — which is what
 * makes the balance "update instantly" requirement trivial to satisfy: the UI
 * just recomputes on every render, and it is also what makes the whole engine
 * testable without mocking time.
 */

// ---------------------------------------------------------------------------
// Recurring expansion
// ---------------------------------------------------------------------------

/**
 * The posting a recurring expense produces in one cycle.
 *
 * A stored `Posting` always wins — that is where a confirmed variable amount, a
 * one-off override or a skipped month lives. When none is stored we derive the
 * default. Because the derived value is a pure function of the template and the
 * cycle, and the stored value is keyed on `expenseId + cycleKey`, a bill can
 * never post twice for the same cycle no matter how often this runs.
 */
export function effectivePosting(
  state: AppState,
  expenseId: string,
  cycleKey: CycleKey,
): Posting | null {
  const expense = state.expenses.find((e) => e.id === expenseId);
  if (!expense || expense.recurrence !== 'recurring') return null;

  const stored = state.postings.find(
    (p) => p.expenseId === expenseId && p.cycleKey === cycleKey,
  );
  if (stored) return stored;

  // A recurring bill does not apply to cycles that ended before it was created;
  // adding "Rent" today must not retroactively invoice every past month.
  if (cycleEnd(cycleKey) < expense.createdAt) return null;
  if (!expense.active) return null;

  const { year, month1 } = parseCycleKey(cycleKey);
  const day = clampDayToMonth(expense.dueDay ?? 1, year, month1);
  return {
    id: `derived_${expenseId}_${cycleKey}`,
    expenseId,
    cycleKey,
    amountCents: expense.amountCents,
    dueDate: `${cycleKey}-${String(day).padStart(2, '0')}`,
    // A variable bill is shown at last cycle's amount but flagged until the
    // user confirms it, so the app never silently changes a recurring figure.
    status: expense.variable ? 'needs-confirmation' : 'posted',
  };
}

/** Every recurring posting that lands inside `period`. */
export function recurringLines(state: AppState, period: Period, reference: ISODate): LedgerLine[] {
  const lines: LedgerLine[] = [];
  for (const cycleKey of cyclesInPeriod(period)) {
    for (const expense of state.expenses) {
      if (expense.recurrence !== 'recurring') continue;
      const posting = effectivePosting(state, expense.id, cycleKey);
      if (!posting || posting.status === 'skipped') continue;
      if (!isWithin(posting.dueDate, period)) continue;
      lines.push({
        id: `${expense.id}@${cycleKey}`,
        name: expense.name,
        categoryId: expense.categoryId,
        amountCents: posting.amountCents,
        date: posting.dueDate,
        recurrence: 'recurring',
        upcoming: posting.dueDate > reference,
        needsConfirmation: posting.status === 'needs-confirmation',
      });
    }
  }
  return lines;
}

/** Every one-time expense dated inside `period`. */
export function oneTimeLines(state: AppState, period: Period, reference: ISODate): LedgerLine[] {
  return state.expenses
    .filter((e) => e.recurrence === 'one-time' && e.active)
    .filter((e) => e.date && isWithin(e.date, period))
    .map((e) => ({
      id: e.id,
      name: e.name,
      categoryId: e.categoryId,
      amountCents: e.amountCents,
      date: e.date as ISODate,
      recurrence: 'one-time' as const,
      upcoming: (e.date as ISODate) > reference,
      needsConfirmation: false,
    }));
}

export function allLines(state: AppState, period: Period, reference: ISODate): LedgerLine[] {
  return [...recurringLines(state, period, reference), ...oneTimeLines(state, period, reference)].sort(
    (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name.localeCompare(b.name)),
  );
}

// ---------------------------------------------------------------------------
// Income
// ---------------------------------------------------------------------------

export interface IncomeTotals {
  totalCents: number;
  receivedCents: number;
  nextPayday: ISODate | null;
}

export function incomeTotals(state: AppState, period: Period, reference: ISODate): IncomeTotals {
  let total = 0;
  let received = 0;
  let nextPayday: ISODate | null = null;

  for (const entry of state.income) {
    if (!entry.active) continue;
    for (const payday of paydaysInPeriod(entry.schedule, period)) {
      total += entry.amountCents;
      if (payday <= reference) received += entry.amountCents;
    }
    // Look past the period end too — the next payday drives buffer mode, and it
    // is often in the following month.
    const next = nextPaydayOnOrAfter(entry.schedule, reference);
    if (next && (nextPayday === null || next < nextPayday)) nextPayday = next;
  }

  if (state.settings.irregularIncomeMode) {
    const baseline = irregularIncomeBaseline(state, reference);
    if (baseline !== null) total = scaleBaselineToPeriod(baseline, period);
  }

  return { totalCents: total, receivedCents: received, nextPayday };
}

/**
 * Trailing average of actual monthly income, for freelance and commission
 * earners whose scheduled income is not a useful prediction.
 *
 * Only *complete* past cycles count — including the current, partly-elapsed
 * month would drag the average down every time it is recomputed early in a month.
 */
export function irregularIncomeBaseline(state: AppState, reference: ISODate): number | null {
  const lookback = Math.min(Math.max(state.settings.irregularLookbackMonths, 1), 12);
  const currentCycle = cycleKeyOf(reference);
  const totals: number[] = [];

  for (let i = 1; i <= lookback; i++) {
    const key = shiftCycle(currentCycle, -i);
    const period = monthPeriod(key);
    let monthTotal = 0;
    for (const entry of state.income) {
      monthTotal += paydaysInPeriod(entry.schedule, period).length * entry.amountCents;
    }
    totals.push(monthTotal);
  }

  const observed = totals.filter((t) => t > 0);
  if (observed.length === 0) return null;
  return Math.round(observed.reduce((a, b) => a + b, 0) / observed.length);
}

/** Spreads a monthly baseline over a period that may be longer or shorter than a month. */
function scaleBaselineToPeriod(monthlyCents: number, period: Period): number {
  const cycles = cyclesInPeriod(period);
  if (cycles.length <= 1) return monthlyCents;
  return monthlyCents * cycles.length;
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

/**
 * Money held back for goals the user chose to reserve. Only the *unfunded*
 * remainder is reserved; anything already saved has left the spendable pool.
 */
export function goalReserveCents(state: AppState): number {
  return sumBy(
    state.goals.filter((g) => g.reserveFromSafeToSpend),
    (g) => Math.max(0, g.targetCents - g.savedCents),
  );
}

// ---------------------------------------------------------------------------
// Cash on hand
// ---------------------------------------------------------------------------

export interface CashOnHand {
  cents: number;
  anchored: boolean;
}

/**
 * How much money is actually available right now.
 *
 * When the user has anchored a real account balance, roll it forward: add every
 * payday since, subtract everything spent since. That is the honest figure.
 *
 * Without an anchor there is no way to know what the account started with, so
 * fall back to income-received-minus-spent within the period. That fallback has
 * a known bias — it assumes each period opens at zero, which understates
 * mid-month cash for anyone whose bills land before their second paycheck — and
 * `anchored` is false so the UI can say so rather than present a guess as fact.
 */
export function cashOnHand(state: AppState, period: Period, reference: ISODate): CashOnHand {
  const { accountBalanceCents, accountBalanceAsOf } = state.settings;

  if (accountBalanceCents === undefined || !accountBalanceAsOf) {
    const income = incomeTotals(state, period, reference);
    const spentToDate = sumBy(
      allLines(state, period, reference).filter((l) => !l.upcoming),
      (l) => l.amountCents,
    );
    return { cents: income.receivedCents - spentToDate, anchored: false };
  }

  // A balance dated in the future is not something to extrapolate backwards
  // from; treat it as current.
  if (accountBalanceAsOf >= reference) {
    return { cents: accountBalanceCents, anchored: true };
  }

  // Roll forward over the window after the anchor date up to today. The anchor
  // date itself is excluded on both sides: the stated balance already reflects
  // whatever happened that day.
  const window: Period = { start: addDays(accountBalanceAsOf, 1), end: reference, label: '' };
  let received = 0;
  for (const entry of state.income) {
    if (!entry.active) continue;
    received += paydaysInPeriod(entry.schedule, window).length * entry.amountCents;
  }
  const spent = sumBy(allLines(state, window, reference), (l) => l.amountCents);

  return { cents: accountBalanceCents + received - spent, anchored: true };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * The single source of truth for every figure on the dashboard.
 *
 * Two headline numbers, deliberately computed on different bases:
 *
 *   Remaining Balance = Income(period) − Σ Recurring − Σ One-Time
 *     The spec's projection: what is left once the whole period plays out.
 *     Accrual-basis — it counts income not yet received and bills not yet due.
 *
 *   Safe-to-Spend = cash on hand − bills still to land − goal reserves
 *     The realistic number: what can be spent today without missing something.
 *     Cash-basis — see `cashOnHand` for how the balance is established.
 *
 * Subtracting unbilled recurring from Remaining directly (as the spec's quick
 * reference literally reads) would double-count them, since Remaining has
 * already deducted every recurring bill. Rebasing safe-to-spend on cash on hand
 * gives the conservative figure the spec is after without charging rent twice.
 */
export function computeSnapshot(state: AppState, period: Period, reference: ISODate): Snapshot {
  const lines = allLines(state, period, reference);
  const income = incomeTotals(state, period, reference);

  const recurringTotalCents = sumBy(
    lines.filter((l) => l.recurrence === 'recurring'),
    (l) => l.amountCents,
  );
  const oneTimeTotalCents = sumBy(
    lines.filter((l) => l.recurrence === 'one-time'),
    (l) => l.amountCents,
  );
  const totalSpentCents = recurringTotalCents + oneTimeTotalCents;
  const spentToDateCents = sumBy(
    lines.filter((l) => !l.upcoming),
    (l) => l.amountCents,
  );
  const upcomingRecurringCents = sumBy(
    lines.filter((l) => l.recurrence === 'recurring' && l.upcoming),
    (l) => l.amountCents,
  );

  const cash = cashOnHand(state, period, reference);
  const reserve = goalReserveCents(state);
  const remainingBalanceCents = income.totalCents - totalSpentCents;

  // Which upcoming bills to hold back depends on the mode. Buffer mode assumes
  // the next paycheck covers everything after it lands, so only the bills due
  // before that paycheck have to come out of today's cash.
  const horizonEnd =
    state.settings.bufferMode && income.nextPayday ? income.nextPayday : period.end;
  const heldBackCents = sumBy(
    lines.filter((l) => l.recurrence === 'recurring' && l.upcoming && l.date <= horizonEnd),
    (l) => l.amountCents,
  );

  const safeToSpendCents = cash.cents - heldBackCents - reserve;

  return {
    period,
    totalIncomeCents: income.totalCents,
    incomeReceivedCents: income.receivedCents,
    recurringTotalCents,
    oneTimeTotalCents,
    totalSpentCents,
    upcomingRecurringCents,
    spentToDateCents,
    goalReserveCents: reserve,
    remainingBalanceCents,
    safeToSpendCents,
    cashOnHandCents: cash.cents,
    cashOnHandAnchored: cash.anchored,
    nextPayday: income.nextPayday,
    categories: categoryBreakdown(state, lines),
    lines,
  };
}

// ---------------------------------------------------------------------------
// Category breakdown
// ---------------------------------------------------------------------------

export function categoryBreakdown(state: AppState, lines: LedgerLine[]): CategoryBreakdown[] {
  const totals = new Map<string, number>();
  for (const line of lines) {
    totals.set(line.categoryId, (totals.get(line.categoryId) ?? 0) + line.amountCents);
  }
  const grand = sumBy([...totals.values()], (v) => v);

  return [...totals.entries()]
    .map(([categoryId, spentCents]) => {
      const category = findCategory(state.categories, categoryId);
      const cap = category.monthlyCapCents;
      return {
        categoryId,
        name: category.name,
        color: category.color,
        spentCents,
        percent: grand === 0 ? 0 : (spentCents / grand) * 100,
        capCents: cap,
        capPercent: cap && cap > 0 ? (spentCents / cap) * 100 : undefined,
      };
    })
    .sort((a, b) => b.spentCents - a.spentCents);
}

/** The transactions behind one category's slice — the drill-down view. */
export function linesForCategory(lines: LedgerLine[], categoryId: string): LedgerLine[] {
  return lines
    .filter((l) => l.categoryId === categoryId)
    .sort((a, b) => b.amountCents - a.amountCents);
}

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------

export interface TrendPoint {
  cycleKey: CycleKey;
  totalSpentCents: number;
  totalIncomeCents: number;
  byCategory: Record<string, number>;
}

/** Spend and income per month over the trailing `months` cycles, oldest first. */
export function trend(state: AppState, reference: ISODate, months = 6): TrendPoint[] {
  const current = cycleKeyOf(reference);
  const points: TrendPoint[] = [];

  for (let i = months - 1; i >= 0; i--) {
    const cycleKey = shiftCycle(current, -i);
    const period = monthPeriod(cycleKey);
    // Each past month is evaluated at its own end date, so bills that have
    // already come and gone are not reported as "upcoming".
    const asOf = cycleKey === current ? reference : period.end;
    const lines = allLines(state, period, asOf);
    const byCategory: Record<string, number> = {};
    for (const line of lines) {
      byCategory[line.categoryId] = (byCategory[line.categoryId] ?? 0) + line.amountCents;
    }
    points.push({
      cycleKey,
      totalSpentCents: sumBy(lines, (l) => l.amountCents),
      totalIncomeCents: incomeTotals(state, period, asOf).totalCents,
      byCategory,
    });
  }
  return points;
}

// ---------------------------------------------------------------------------
// Upcoming bills / reminders
// ---------------------------------------------------------------------------

export interface UpcomingBill {
  expenseId: string;
  name: string;
  categoryId: string;
  amountCents: number;
  dueDate: ISODate;
  daysAway: number;
  needsConfirmation: boolean;
}

/**
 * Bills due within `withinDays` of the reference date, soonest first. Looks
 * across the current cycle and the next so a bill due on the 2nd still warns
 * the user on the 30th.
 */
export function upcomingBills(state: AppState, reference: ISODate, withinDays = 7): UpcomingBill[] {
  const cycles = [cycleKeyOf(reference), shiftCycle(cycleKeyOf(reference), 1)];
  const out: UpcomingBill[] = [];

  for (const cycleKey of cycles) {
    for (const expense of state.expenses) {
      if (expense.recurrence !== 'recurring') continue;
      const posting = effectivePosting(state, expense.id, cycleKey);
      if (!posting || posting.status === 'skipped') continue;
      if (posting.dueDate < reference) continue;
      const daysAway = Math.round(
        (Date.parse(`${posting.dueDate}T12:00:00Z`) - Date.parse(`${reference}T12:00:00Z`)) / 86_400_000,
      );
      if (daysAway > withinDays) continue;
      out.push({
        expenseId: expense.id,
        name: expense.name,
        categoryId: expense.categoryId,
        amountCents: posting.amountCents,
        dueDate: posting.dueDate,
        daysAway,
        needsConfirmation: posting.status === 'needs-confirmation',
      });
    }
  }
  return out.sort((a, b) => a.daysAway - b.daysAway);
}

/**
 * Variable recurring bills awaiting confirmation in the current cycle. These
 * are surfaced as a prompt rather than posted silently.
 */
export function pendingConfirmations(state: AppState, reference: ISODate): UpcomingBill[] {
  const cycleKey = cycleKeyOf(reference);
  const out: UpcomingBill[] = [];
  for (const expense of state.expenses) {
    if (expense.recurrence !== 'recurring' || !expense.variable) continue;
    const posting = effectivePosting(state, expense.id, cycleKey);
    if (!posting || posting.status !== 'needs-confirmation') continue;
    out.push({
      expenseId: expense.id,
      name: expense.name,
      categoryId: expense.categoryId,
      amountCents: posting.amountCents,
      dueDate: posting.dueDate,
      daysAway: 0,
      needsConfirmation: true,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Net worth
// ---------------------------------------------------------------------------

export function netWorthCents(assetsCents: number, liabilitiesCents: number): number {
  return assetsCents - liabilitiesCents;
}

/** Current cycle bounds as a convenience for callers that only need "this month". */
export function currentMonthPeriod(reference: ISODate): Period {
  return monthPeriod(cycleKeyOf(reference));
}

export { cycleStart, cycleEnd };
