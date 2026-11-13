import type { Debt } from '../types';
import { sumBy } from './money';

/**
 * Debt payoff projection.
 *
 * Both strategies pay every debt's minimum each month and throw the whole extra
 * payment at one target debt. They differ only in which debt is the target:
 *
 *   avalanche — highest APR first. Mathematically optimal; pays the least interest.
 *   snowball  — smallest balance first. Clears individual debts soonest, which
 *               is the behavioural argument for it.
 *
 * Showing both, with the interest difference between them, is the point: it
 * makes the cost of choosing motivation over maths explicit instead of implied.
 */

export type Strategy = 'avalanche' | 'snowball';

export interface PayoffMonth {
  monthIndex: number;
  startingBalanceCents: number;
  interestCents: number;
  principalCents: number;
  endingBalanceCents: number;
  /** Debts fully cleared during this month. */
  clearedDebtNames: string[];
}

export interface PayoffPlan {
  strategy: Strategy;
  months: number;
  totalInterestCents: number;
  totalPaidCents: number;
  schedule: PayoffMonth[];
  /** Set when the extra payment is too small to ever clear the debt. */
  impossible: boolean;
}

const MAX_MONTHS = 600; // 50 years — past this the plan is not a plan.

export function minimumsTotalCents(debts: Debt[]): number {
  return sumBy(debts, (d) => d.minimumPaymentCents);
}

export function totalDebtCents(debts: Debt[]): number {
  return sumBy(debts, (d) => d.balanceCents);
}

/** Weighted average APR across all balances — the blended rate the user is really paying. */
export function blendedAprPercent(debts: Debt[]): number {
  const total = totalDebtCents(debts);
  if (total === 0) return 0;
  return sumBy(debts, (d) => d.balanceCents * d.aprPercent) / total;
}

function orderFor(strategy: Strategy, debts: Debt[]): Debt[] {
  const copy = [...debts];
  return strategy === 'avalanche'
    ? copy.sort((a, b) => b.aprPercent - a.aprPercent || a.balanceCents - b.balanceCents)
    : copy.sort((a, b) => a.balanceCents - b.balanceCents || b.aprPercent - a.aprPercent);
}

/**
 * Simulates payoff month by month.
 *
 * `extraPaymentCents` is money available *on top of* the minimums. As each debt
 * clears, its minimum rolls into the extra payment — that rollover is what makes
 * either strategy accelerate over time.
 */
export function projectPayoff(
  debts: Debt[],
  extraPaymentCents: number,
  strategy: Strategy,
): PayoffPlan {
  const working = debts
    .filter((d) => d.balanceCents > 0)
    .map((d) => ({ ...d }));

  const schedule: PayoffMonth[] = [];
  let totalInterest = 0;
  let totalPaid = 0;
  let freedMinimums = 0;

  if (working.length === 0) {
    return { strategy, months: 0, totalInterestCents: 0, totalPaidCents: 0, schedule, impossible: false };
  }

  for (let month = 1; month <= MAX_MONTHS; month++) {
    const startingBalance = sumBy(working, (d) => d.balanceCents);
    if (startingBalance <= 0) break;

    let monthInterest = 0;
    // 1. Accrue one month of interest on every outstanding balance.
    for (const debt of working) {
      if (debt.balanceCents <= 0) continue;
      const interest = Math.round((debt.balanceCents * (debt.aprPercent / 100)) / 12);
      debt.balanceCents += interest;
      monthInterest += interest;
    }

    // 2. Pay minimums on everything.
    let budget = extraPaymentCents + freedMinimums;
    const cleared: string[] = [];
    let monthPaid = 0;

    for (const debt of working) {
      if (debt.balanceCents <= 0) continue;
      const pay = Math.min(debt.minimumPaymentCents, debt.balanceCents);
      debt.balanceCents -= pay;
      monthPaid += pay;
      if (debt.balanceCents <= 0) {
        cleared.push(debt.name);
        freedMinimums += debt.minimumPaymentCents;
      }
    }

    // 3. Throw everything left at the target debt, cascading as debts clear.
    for (const debt of orderFor(strategy, working)) {
      if (budget <= 0) break;
      if (debt.balanceCents <= 0) continue;
      const pay = Math.min(budget, debt.balanceCents);
      debt.balanceCents -= pay;
      budget -= pay;
      monthPaid += pay;
      if (debt.balanceCents <= 0 && !cleared.includes(debt.name)) {
        cleared.push(debt.name);
        freedMinimums += debt.minimumPaymentCents;
      }
    }

    totalInterest += monthInterest;
    totalPaid += monthPaid;
    schedule.push({
      monthIndex: month,
      startingBalanceCents: startingBalance,
      interestCents: monthInterest,
      principalCents: monthPaid - monthInterest,
      endingBalanceCents: Math.max(0, sumBy(working, (d) => d.balanceCents)),
      clearedDebtNames: cleared,
    });

    if (sumBy(working, (d) => d.balanceCents) <= 0) break;

    // If a month made no dent, the payment does not cover the interest and the
    // balance will never reach zero. Say so rather than looping for 50 years.
    if (month > 1 && schedule[month - 1]!.endingBalanceCents >= schedule[month - 2]!.endingBalanceCents) {
      return {
        strategy,
        months: Infinity,
        totalInterestCents: totalInterest,
        totalPaidCents: totalPaid,
        schedule,
        impossible: true,
      };
    }
  }

  const finished = sumBy(working, (d) => d.balanceCents) <= 0;
  return {
    strategy,
    months: finished ? schedule.length : Infinity,
    totalInterestCents: totalInterest,
    totalPaidCents: totalPaid,
    schedule,
    impossible: !finished,
  };
}

export interface StrategyComparison {
  avalanche: PayoffPlan;
  snowball: PayoffPlan;
  /** Interest the avalanche saves over the snowball; negative would favour snowball. */
  interestSavedCents: number;
  monthsSaved: number;
}

export function compareStrategies(debts: Debt[], extraPaymentCents: number): StrategyComparison {
  const avalanche = projectPayoff(debts, extraPaymentCents, 'avalanche');
  const snowball = projectPayoff(debts, extraPaymentCents, 'snowball');
  return {
    avalanche,
    snowball,
    interestSavedCents: snowball.totalInterestCents - avalanche.totalInterestCents,
    monthsSaved: Number.isFinite(snowball.months) && Number.isFinite(avalanche.months)
      ? snowball.months - avalanche.months
      : 0,
  };
}

/** "2 yr 3 mo" — payoff timelines read better in years than in 27 months. */
export function formatMonths(months: number): string {
  if (!Number.isFinite(months)) return 'never at this payment';
  if (months === 0) return 'paid off';
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (years === 0) return `${rest} mo`;
  if (rest === 0) return `${years} yr`;
  return `${years} yr ${rest} mo`;
}
