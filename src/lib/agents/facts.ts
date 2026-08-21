import type { AppState, ISODate, Period } from '../../types';
import { blendedAprPercent, compareStrategies, minimumsTotalCents, totalDebtCents } from '../debt';
import { cycleKeyOf, formatMonthShort, monthPeriod, shiftCycle } from '../dates';
import { computeSnapshot, trend, upcomingBills } from '../finance';
import { formatMoney, formatPercent, sumBy } from '../money';

/**
 * The facts layer.
 *
 * This is the difference between an advisor that sounds knowledgeable and one
 * that is. Every specialist answers from these precomputed figures rather than
 * from prose, so "your utilization is 87% on the store card" replaces "keep
 * utilization low", and the numbers are arithmetic rather than something a
 * model inferred.
 *
 * It is also the model's grounding: `formatFactSheet` renders this into the
 * system prompt, so even a single-turn answer with no tool calls is anchored to
 * real data.
 */

export interface CategoryFact {
  id: string;
  name: string;
  spentCents: number;
  percentOfSpend: number;
  percentOfIncome: number;
  capCents?: number;
  capPercent?: number;
  /** Change against the previous complete month. */
  deltaVsLastMonthCents: number;
  /** Mean over the trailing complete months, for "is this month unusual". */
  sixMonthAverageCents: number;
  /** True when the category rose in each of the last three complete months. */
  risingThreeMonths: boolean;
}

export interface DebtFact {
  id: string;
  name: string;
  balanceCents: number;
  aprPercent: number;
  minimumPaymentCents: number;
  /** Interest accruing this month at the current balance and rate. */
  monthlyInterestCents: number;
  creditLimitCents?: number;
  /** Balance ÷ limit, revolving accounts only. */
  utilizationPercent?: number;
}

export interface GoalFact {
  id: string;
  name: string;
  targetCents: number;
  savedCents: number;
  remainingCents: number;
  percentFunded: number;
  reserved: boolean;
  /** Months to fund at the current projected leftover; null when leftover ≤ 0. */
  monthsToFundAtCurrentRate: number | null;
}

export interface MonthFact {
  cycleKey: string;
  label: string;
  incomeCents: number;
  spentCents: number;
  netCents: number;
}

export interface AdvisorFacts {
  periodLabel: string;
  asOf: ISODate;

  cashflow: {
    incomeCents: number;
    incomeReceivedCents: number;
    spentCents: number;
    recurringCents: number;
    oneTimeCents: number;
    remainingBalanceCents: number;
    safeToSpendCents: number;
    cashOnHandCents: number;
    cashOnHandAnchored: boolean;
    savingsRatePercent: number;
    fixedShareOfIncomePercent: number;
    discretionaryShareOfIncomePercent: number;
  };

  categories: CategoryFact[];

  subscriptions: {
    count: number;
    monthlyCents: number;
    annualCents: number;
    items: { name: string; monthlyCents: number; annualCents: number }[];
  };

  debt: {
    totalCents: number;
    blendedAprPercent: number;
    minimumsCents: number;
    monthlyInterestCents: number;
    /** Utilization across all accounts that declare a limit. */
    overallUtilizationPercent: number | null;
    items: DebtFact[];
    payoff: {
      extraPaymentCents: number;
      avalancheMonths: number;
      snowballMonths: number;
      avalancheInterestCents: number;
      snowballInterestCents: number;
      interestSavedCents: number;
      impossible: boolean;
      /** Debt names in the order the avalanche clears them. */
      avalancheOrder: string[];
    } | null;
  };

  goals: GoalFact[];

  emergencyFund: {
    monthlyEssentialsCents: number;
    threeMonthTargetCents: number;
    sixMonthTargetCents: number;
    currentSavedCents: number;
    monthsCovered: number;
  };

  /** Months the current cash on hand covers essential costs with no income. */
  runwayMonths: number | null;

  upcoming: {
    count: number;
    totalCents: number;
    items: { name: string; amountCents: number; dueDate: ISODate; daysAway: number }[];
  };

  history: MonthFact[];
}

/** Categories treated as essentials when sizing an emergency fund. */
const ESSENTIAL_CATEGORIES = new Set([
  'housing',
  'insurance',
  'auto',
  'groceries',
  'utilities',
  'health',
  'debt',
]);

export function buildFacts(state: AppState, reference: ISODate, period?: Period): AdvisorFacts {
  const activePeriod = period ?? monthPeriod(cycleKeyOf(reference));
  const snapshot = computeSnapshot(state, activePeriod, reference);
  const history = trend(state, reference, 7);

  // The current month is partial, so comparisons use complete months only.
  const complete = history.slice(0, -1);
  const lastMonth = complete.at(-1);

  const income = snapshot.totalIncomeCents;
  const pct = (part: number, whole: number) => (whole === 0 ? 0 : (part / whole) * 100);

  const categories: CategoryFact[] = snapshot.categories.map((c) => {
    const series = complete.map((m) => m.byCategory[c.categoryId] ?? 0);
    const [a, b, d] = series.slice(-3);
    return {
      id: c.categoryId,
      name: c.name,
      spentCents: c.spentCents,
      percentOfSpend: c.percent,
      percentOfIncome: pct(c.spentCents, income),
      capCents: c.capCents,
      capPercent: c.capPercent,
      deltaVsLastMonthCents: c.spentCents - (lastMonth?.byCategory[c.categoryId] ?? 0),
      sixMonthAverageCents: series.length ? Math.round(sumBy(series, (v) => v) / series.length) : 0,
      risingThreeMonths:
        a !== undefined && b !== undefined && d !== undefined && a > 0 && b > a && d > b,
    };
  });

  const subs = state.expenses.filter(
    (e) => e.categoryId === 'subscriptions' && e.recurrence === 'recurring' && e.active,
  );
  const subsMonthly = sumBy(subs, (s) => s.amountCents);

  const debtItems: DebtFact[] = state.debts.map((d) => ({
    id: d.id,
    name: d.name,
    balanceCents: d.balanceCents,
    aprPercent: d.aprPercent,
    minimumPaymentCents: d.minimumPaymentCents,
    monthlyInterestCents: Math.round((d.balanceCents * (d.aprPercent / 100)) / 12),
    creditLimitCents: d.creditLimitCents,
    utilizationPercent:
      d.creditLimitCents && d.creditLimitCents > 0
        ? (d.balanceCents / d.creditLimitCents) * 100
        : undefined,
  }));

  const revolving = state.debts.filter((d) => d.creditLimitCents && d.creditLimitCents > 0);
  const overallUtilization =
    revolving.length > 0
      ? (sumBy(revolving, (d) => d.balanceCents) / sumBy(revolving, (d) => d.creditLimitCents ?? 0)) * 100
      : null;

  const extraPayment = Math.max(0, snapshot.remainingBalanceCents);
  const comparison = state.debts.length > 0 ? compareStrategies(state.debts, extraPayment) : null;

  const monthlyEssentials = sumBy(
    state.expenses.filter(
      (e) => e.recurrence === 'recurring' && e.active && ESSENTIAL_CATEGORIES.has(e.categoryId),
    ),
    (e) => e.amountCents,
  );
  const savedAcrossGoals = sumBy(state.goals, (g) => g.savedCents);

  const leftover = Math.max(0, snapshot.remainingBalanceCents);
  const goals: GoalFact[] = state.goals.map((g) => {
    const remaining = Math.max(0, g.targetCents - g.savedCents);
    return {
      id: g.id,
      name: g.name,
      targetCents: g.targetCents,
      savedCents: g.savedCents,
      remainingCents: remaining,
      percentFunded: g.targetCents === 0 ? 100 : (g.savedCents / g.targetCents) * 100,
      reserved: g.reserveFromSafeToSpend,
      monthsToFundAtCurrentRate: remaining === 0 ? 0 : leftover > 0 ? Math.ceil(remaining / leftover) : null,
    };
  });

  const bills = upcomingBills(state, reference, state.settings.reminderLeadDays);

  return {
    periodLabel: activePeriod.label,
    asOf: reference,

    cashflow: {
      incomeCents: income,
      incomeReceivedCents: snapshot.incomeReceivedCents,
      spentCents: snapshot.totalSpentCents,
      recurringCents: snapshot.recurringTotalCents,
      oneTimeCents: snapshot.oneTimeTotalCents,
      remainingBalanceCents: snapshot.remainingBalanceCents,
      safeToSpendCents: snapshot.safeToSpendCents,
      cashOnHandCents: snapshot.cashOnHandCents,
      cashOnHandAnchored: snapshot.cashOnHandAnchored,
      savingsRatePercent: pct(snapshot.remainingBalanceCents, income),
      fixedShareOfIncomePercent: pct(snapshot.recurringTotalCents, income),
      discretionaryShareOfIncomePercent: pct(snapshot.oneTimeTotalCents, income),
    },

    categories,

    subscriptions: {
      count: subs.length,
      monthlyCents: subsMonthly,
      annualCents: subsMonthly * 12,
      items: subs
        .slice()
        .sort((x, y) => y.amountCents - x.amountCents)
        .map((s) => ({ name: s.name, monthlyCents: s.amountCents, annualCents: s.amountCents * 12 })),
    },

    debt: {
      totalCents: totalDebtCents(state.debts),
      blendedAprPercent: blendedAprPercent(state.debts),
      minimumsCents: minimumsTotalCents(state.debts),
      monthlyInterestCents: sumBy(debtItems, (d) => d.monthlyInterestCents),
      overallUtilizationPercent: overallUtilization,
      items: debtItems,
      payoff: comparison
        ? {
            extraPaymentCents: extraPayment,
            avalancheMonths: comparison.avalanche.months,
            snowballMonths: comparison.snowball.months,
            avalancheInterestCents: comparison.avalanche.totalInterestCents,
            snowballInterestCents: comparison.snowball.totalInterestCents,
            interestSavedCents: comparison.interestSavedCents,
            impossible: comparison.avalanche.impossible,
            avalancheOrder: [...state.debts]
              .sort((x, y) => y.aprPercent - x.aprPercent)
              .map((d) => d.name),
          }
        : null,
    },

    goals,

    emergencyFund: {
      monthlyEssentialsCents: monthlyEssentials,
      threeMonthTargetCents: monthlyEssentials * 3,
      sixMonthTargetCents: monthlyEssentials * 6,
      currentSavedCents: savedAcrossGoals,
      monthsCovered: monthlyEssentials > 0 ? savedAcrossGoals / monthlyEssentials : 0,
    },

    runwayMonths:
      monthlyEssentials > 0 ? Math.max(0, snapshot.cashOnHandCents) / monthlyEssentials : null,

    upcoming: {
      count: bills.length,
      totalCents: sumBy(bills, (b) => b.amountCents),
      items: bills.map((b) => ({
        name: b.name,
        amountCents: b.amountCents,
        dueDate: b.dueDate,
        daysAway: b.daysAway,
      })),
    },

    history: history.map((m) => ({
      cycleKey: m.cycleKey,
      label: formatMonthShort(m.cycleKey),
      incomeCents: m.totalIncomeCents,
      spentCents: m.totalSpentCents,
      netCents: m.totalIncomeCents - m.totalSpentCents,
    })),
  };
}

// ---------------------------------------------------------------------------
// What-if simulation
// ---------------------------------------------------------------------------

export interface SimulationResult {
  description: string;
  monthlyDeltaCents: number;
  newSavingsRatePercent: number;
  annualImpactCents: number;
  /** Months knocked off the avalanche payoff by redirecting the change to debt. */
  debtMonthsSaved: number | null;
  debtInterestSavedCents: number | null;
  /** Months earlier the first unfunded goal would be reached. */
  goalMonthsSaved: number | null;
}

/**
 * "What if I cut dining by $100?" — answered with arithmetic rather than
 * encouragement. Being able to price a change is most of what makes advice
 * actionable instead of vague.
 */
export function simulateMonthlyChange(
  state: AppState,
  facts: AdvisorFacts,
  monthlyDeltaCents: number,
  description: string,
): SimulationResult {
  const income = facts.cashflow.incomeCents;
  const newLeftover = facts.cashflow.remainingBalanceCents + monthlyDeltaCents;

  let debtMonthsSaved: number | null = null;
  let debtInterestSavedCents: number | null = null;
  if (state.debts.length > 0 && facts.debt.payoff) {
    const improved = compareStrategies(
      state.debts,
      Math.max(0, facts.debt.payoff.extraPaymentCents + monthlyDeltaCents),
    );
    const before = facts.debt.payoff.avalancheMonths;
    const after = improved.avalanche.months;
    if (Number.isFinite(before) && Number.isFinite(after)) debtMonthsSaved = before - after;
    debtInterestSavedCents =
      facts.debt.payoff.avalancheInterestCents - improved.avalanche.totalInterestCents;
  }

  let goalMonthsSaved: number | null = null;
  const target = facts.goals.find((g) => g.remainingCents > 0);
  if (target) {
    const before = target.monthsToFundAtCurrentRate;
    const after = newLeftover > 0 ? Math.ceil(target.remainingCents / newLeftover) : null;
    if (before !== null && after !== null) goalMonthsSaved = before - after;
  }

  return {
    description,
    monthlyDeltaCents,
    newSavingsRatePercent: income === 0 ? 0 : (newLeftover / income) * 100,
    annualImpactCents: monthlyDeltaCents * 12,
    debtMonthsSaved,
    debtInterestSavedCents,
    goalMonthsSaved,
  };
}

// ---------------------------------------------------------------------------
// Rendering for the model
// ---------------------------------------------------------------------------

const m = (cents: number) => formatMoney(cents);
const p = (value: number, digits = 1) => formatPercent(value, digits);

/**
 * A compact fact sheet for the system prompt.
 *
 * Kept terse and stable: it goes in the cached prefix, so it must not carry
 * anything that changes per request beyond the data itself.
 */
export function formatFactSheet(facts: AdvisorFacts): string {
  const lines: string[] = [];
  const c = facts.cashflow;

  lines.push(`PERIOD: ${facts.periodLabel} (as of ${facts.asOf})`);
  lines.push('');
  lines.push('CASH FLOW');
  lines.push(`- Income: ${m(c.incomeCents)} (${m(c.incomeReceivedCents)} received so far)`);
  lines.push(
    `- Spent: ${m(c.spentCents)} = ${m(c.recurringCents)} recurring + ${m(c.oneTimeCents)} one-time`,
  );
  lines.push(`- Remaining balance (projection): ${m(c.remainingBalanceCents)}`);
  lines.push(`- Safe-to-spend (today): ${m(c.safeToSpendCents)}`);
  lines.push(
    `- Cash on hand: ${m(c.cashOnHandCents)}${c.cashOnHandAnchored ? '' : ' (ESTIMATE — user has not set a real account balance)'}`,
  );
  lines.push(
    `- Savings rate: ${p(c.savingsRatePercent)} | fixed costs ${p(c.fixedShareOfIncomePercent)} of income | discretionary ${p(c.discretionaryShareOfIncomePercent)}`,
  );
  if (facts.runwayMonths !== null) {
    lines.push(`- Runway on cash alone: ${facts.runwayMonths.toFixed(1)} months of essentials`);
  }

  if (facts.categories.length > 0) {
    lines.push('');
    lines.push('CATEGORIES (this period)');
    for (const cat of facts.categories.slice(0, 10)) {
      const bits = [`${m(cat.spentCents)}`, `${p(cat.percentOfSpend)} of spend`];
      if (cat.capCents) bits.push(`${p(cat.capPercent ?? 0, 0)} of ${m(cat.capCents)} cap`);
      if (cat.deltaVsLastMonthCents !== 0) {
        bits.push(
          `${cat.deltaVsLastMonthCents > 0 ? '+' : ''}${m(cat.deltaVsLastMonthCents)} vs last month`,
        );
      }
      if (cat.risingThreeMonths) bits.push('RISING 3 MONTHS');
      lines.push(`- ${cat.name}: ${bits.join(', ')}`);
    }
  }

  if (facts.subscriptions.count > 0) {
    lines.push('');
    lines.push(
      `SUBSCRIPTIONS: ${facts.subscriptions.count} active, ${m(facts.subscriptions.monthlyCents)}/mo (${m(facts.subscriptions.annualCents)}/yr)`,
    );
    for (const s of facts.subscriptions.items) lines.push(`- ${s.name}: ${m(s.monthlyCents)}/mo`);
  }

  if (facts.debt.items.length > 0) {
    lines.push('');
    lines.push(
      `DEBT: ${m(facts.debt.totalCents)} total, ${p(facts.debt.blendedAprPercent, 2)} blended APR, ${m(facts.debt.minimumsCents)}/mo minimums, ${m(facts.debt.monthlyInterestCents)}/mo interest`,
    );
    if (facts.debt.overallUtilizationPercent !== null) {
      lines.push(`- Overall credit utilization: ${p(facts.debt.overallUtilizationPercent)}`);
    }
    for (const d of facts.debt.items) {
      const bits = [`${m(d.balanceCents)}`, `${p(d.aprPercent, 2)} APR`, `${m(d.monthlyInterestCents)}/mo interest`];
      if (d.utilizationPercent !== undefined) bits.push(`${p(d.utilizationPercent)} utilization`);
      lines.push(`- ${d.name}: ${bits.join(', ')}`);
    }
    if (facts.debt.payoff) {
      const pay = facts.debt.payoff;
      lines.push(
        pay.impossible
          ? `- At ${m(pay.extraPaymentCents)}/mo extra the balances never clear — interest keeps pace with payments.`
          : `- At ${m(pay.extraPaymentCents)}/mo extra: avalanche ${pay.avalancheMonths} mo (${m(pay.avalancheInterestCents)} interest), snowball ${pay.snowballMonths} mo (${m(pay.snowballInterestCents)} interest). Avalanche saves ${m(pay.interestSavedCents)}.`,
      );
    }
  }

  lines.push('');
  lines.push(
    `EMERGENCY FUND: essentials ${m(facts.emergencyFund.monthlyEssentialsCents)}/mo → 3-month target ${m(facts.emergencyFund.threeMonthTargetCents)}, 6-month ${m(facts.emergencyFund.sixMonthTargetCents)}. Saved across goals: ${m(facts.emergencyFund.currentSavedCents)} (${facts.emergencyFund.monthsCovered.toFixed(1)} months covered).`,
  );

  if (facts.goals.length > 0) {
    lines.push('');
    lines.push('GOALS');
    for (const g of facts.goals) {
      lines.push(
        `- ${g.name}: ${m(g.savedCents)}/${m(g.targetCents)} (${p(g.percentFunded, 0)}), ${m(g.remainingCents)} to go${
          g.monthsToFundAtCurrentRate !== null ? `, ~${g.monthsToFundAtCurrentRate} mo at current leftover` : ''
        }${g.reserved ? ', reserved from safe-to-spend' : ''}`,
      );
    }
  }

  if (facts.upcoming.count > 0) {
    lines.push('');
    lines.push(`DUE SOON: ${m(facts.upcoming.totalCents)} across ${facts.upcoming.count} bills`);
    for (const b of facts.upcoming.items) {
      lines.push(`- ${b.name}: ${m(b.amountCents)} on ${b.dueDate} (${b.daysAway}d)`);
    }
  }

  lines.push('');
  lines.push('MONTHLY HISTORY (oldest first)');
  for (const h of facts.history) {
    lines.push(`- ${h.label}: income ${m(h.incomeCents)}, spent ${m(h.spentCents)}, net ${m(h.netCents)}`);
  }

  return lines.join('\n');
}

export { shiftCycle };
