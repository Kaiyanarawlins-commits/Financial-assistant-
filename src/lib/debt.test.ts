import { describe, expect, it } from 'vitest';
import type { Debt } from '../types';
import { blendedAprPercent, compareStrategies, formatMonths, projectPayoff } from './debt';

const debts: Debt[] = [
  { id: 'a', name: 'Store card', balanceCents: 90_000, aprPercent: 29.99, minimumPaymentCents: 3_000 },
  { id: 'b', name: 'Visa', balanceCents: 340_000, aprPercent: 22.99, minimumPaymentCents: 8_500 },
  { id: 'c', name: 'Student loan', balanceCents: 800_000, aprPercent: 5.5, minimumPaymentCents: 15_000 },
];

describe('payoff projection', () => {
  it('clears every balance and reports a finite timeline', () => {
    const plan = projectPayoff(debts, 40_000, 'avalanche');
    expect(plan.impossible).toBe(false);
    expect(plan.months).toBeGreaterThan(0);
    expect(plan.schedule.at(-1)?.endingBalanceCents).toBe(0);
  });

  it('pays less interest on the avalanche than on the snowball', () => {
    const { avalanche, snowball, interestSavedCents } = compareStrategies(debts, 40_000);
    expect(avalanche.totalInterestCents).toBeLessThanOrEqual(snowball.totalInterestCents);
    expect(interestSavedCents).toBeGreaterThanOrEqual(0);
  });

  it('clears the smallest balance first under the snowball', () => {
    const plan = projectPayoff(debts, 40_000, 'snowball');
    const firstCleared = plan.schedule.find((m) => m.clearedDebtNames.length > 0);
    expect(firstCleared?.clearedDebtNames).toContain('Store card');
  });

  it('targets the highest rate first under the avalanche', () => {
    const plan = projectPayoff(debts, 40_000, 'avalanche');
    const firstCleared = plan.schedule.find((m) => m.clearedDebtNames.length > 0);
    // The store card is both the smallest and the highest-rate here, so use a
    // case where the two strategies actually disagree.
    const disagreeing: Debt[] = [
      { id: 'x', name: 'Small low-rate', balanceCents: 50_000, aprPercent: 3, minimumPaymentCents: 2_000 },
      { id: 'y', name: 'Large high-rate', balanceCents: 200_000, aprPercent: 27, minimumPaymentCents: 5_000 },
    ];
    const avalanche = projectPayoff(disagreeing, 30_000, 'avalanche');
    const snowball = projectPayoff(disagreeing, 30_000, 'snowball');
    expect(avalanche.schedule.find((m) => m.clearedDebtNames.length)?.clearedDebtNames).toContain(
      'Large high-rate',
    );
    expect(snowball.schedule.find((m) => m.clearedDebtNames.length)?.clearedDebtNames).toContain(
      'Small low-rate',
    );
    expect(firstCleared).toBeDefined();
  });

  it('accelerates as cleared minimums roll into the extra payment', () => {
    const plan = projectPayoff(debts, 40_000, 'avalanche');
    const early = plan.schedule[1]!.principalCents;
    const late = plan.schedule.at(-3)!.principalCents;
    expect(late).toBeGreaterThan(early);
  });

  it('flags a payment too small to ever clear the balance', () => {
    const stuck: Debt[] = [
      { id: 'z', name: 'Maxed card', balanceCents: 1_000_000, aprPercent: 29.99, minimumPaymentCents: 1_000 },
    ];
    const plan = projectPayoff(stuck, 0, 'avalanche');
    expect(plan.impossible).toBe(true);
    expect(plan.months).toBe(Infinity);
  });

  it('handles an empty debt list', () => {
    const plan = projectPayoff([], 10_000, 'avalanche');
    expect(plan.months).toBe(0);
    expect(plan.impossible).toBe(false);
  });

  it('weights the blended APR by balance, not by count', () => {
    // The 800k loan at 5.5% dominates the two small high-rate cards.
    expect(blendedAprPercent(debts)).toBeLessThan(15);
    expect(blendedAprPercent([])).toBe(0);
  });
});

describe('formatMonths', () => {
  it('reads as years and months', () => {
    expect(formatMonths(0)).toBe('paid off');
    expect(formatMonths(7)).toBe('7 mo');
    expect(formatMonths(24)).toBe('2 yr');
    expect(formatMonths(27)).toBe('2 yr 3 mo');
    expect(formatMonths(Infinity)).toBe('never at this payment');
  });
});
