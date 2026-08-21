import type Anthropic from '@anthropic-ai/sdk';
import type { AppState, ISODate } from '../../types';
import { findCategory } from '../categories';
import { customPeriod, cycleKeyOf, monthPeriod, shiftCycle } from '../dates';
import { computeSnapshot, linesForCategory, trend } from '../finance';
import { toDollars } from '../money';
import {
  affordability,
  loanPayment,
  payoffTime,
  projectGrowth,
  retirementTarget,
  timeToTarget,
} from './calculators';
import { buildFacts, simulateMonthlyChange } from './facts';

/**
 * Tools the specialists can call.
 *
 * All of them execute locally against app state — no network, no server. Two
 * consequences worth stating: the user's finances never leave the device except
 * as the summary in the prompt, and a tool call costs a millisecond rather than
 * a round trip, so the agents can afford to look things up rather than guess.
 *
 * `calculate` is the exception that isn't about stored data at all — it exists
 * so hypotheticals ("if I invested $500/mo at 7% for 20 years") get real
 * arithmetic. Compound interest done token-by-token is exactly the kind of
 * thing a language model gets subtly and confidently wrong.
 */

export const TOOL_DEFINITIONS: Record<string, Anthropic.Beta.BetaTool> = {
  get_financial_summary: {
    name: 'get_financial_summary',
    description:
      'Full financial position for a period: income, spending, balances, category breakdown, debt, goals, emergency fund and monthly history. Call this when you need figures beyond the summary already in your context, or for a period other than the current month.',
    input_schema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['current_month', 'last_month', 'last_3_months', 'last_6_months', 'year_to_date'],
          description: 'Which window to report. Defaults to the current month.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },

  get_category_detail: {
    name: 'get_category_detail',
    description:
      'Everything about one spending category: this period\'s total, share of spend, cap status, six-month history, and the individual transactions behind it. Use before commenting on any single category.',
    input_schema: {
      type: 'object',
      properties: {
        category_id: {
          type: 'string',
          description:
            'Category id, e.g. housing, groceries, dining, entertainment, subscriptions, auto, utilities, travel, health, debt, savings, insurance, misc.',
        },
      },
      required: ['category_id'],
      additionalProperties: false,
    },
  },

  list_transactions: {
    name: 'list_transactions',
    description:
      'Individual transactions for the current period, optionally filtered by category or minimum amount. Use to find specific charges rather than describing spending in aggregate.',
    input_schema: {
      type: 'object',
      properties: {
        category_id: { type: 'string', description: 'Optional category filter.' },
        min_amount_dollars: { type: 'number', description: 'Only transactions at or above this amount.' },
        limit: { type: 'number', description: 'Maximum rows to return. Defaults to 20.' },
      },
      required: [],
      additionalProperties: false,
    },
  },

  get_debt_analysis: {
    name: 'get_debt_analysis',
    description:
      'Every debt with balance, APR, minimum, monthly interest cost and credit utilization, plus avalanche vs. snowball payoff projections at a given extra monthly payment. Always call this before giving debt advice.',
    input_schema: {
      type: 'object',
      properties: {
        extra_payment_dollars: {
          type: 'number',
          description:
            "Extra monthly payment above the minimums to model. Defaults to the user's projected leftover.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },

  get_goals: {
    name: 'get_goals',
    description:
      'Savings goals with target, saved, remaining, percent funded and months to completion at the current rate.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },

  get_subscriptions: {
    name: 'get_subscriptions',
    description: 'Active subscriptions with monthly and annual cost, plus the totals.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },

  simulate_change: {
    name: 'simulate_change',
    description:
      "Price a change to the user's monthly cash flow: what spending $X less (or more) per month does to their savings rate, debt payoff timeline, interest paid and goal dates. Use this whenever you propose a change, so the recommendation carries a number.",
    input_schema: {
      type: 'object',
      properties: {
        monthly_change_dollars: {
          type: 'number',
          description: 'Positive to free up money (a cut), negative for new spending.',
        },
        description: { type: 'string', description: 'What the change is, e.g. "cutting dining by $100".' },
      },
      required: ['monthly_change_dollars', 'description'],
      additionalProperties: false,
    },
  },

  calculate: {
    name: 'calculate',
    description:
      "Financial math on ANY figures, including hypothetical ones the app has never seen. Use this for scenario questions — 'if I earned $80k', 'if I invested $500/month at 7%', 'what house could I afford' — and for any compound interest, loan or payoff arithmetic. Do not compute these yourself; the rounding matters and this is exact.",
    input_schema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'compound_growth',
            'loan_payment',
            'payoff_time',
            'time_to_target',
            'affordability',
            'retirement_target',
          ],
          description:
            'compound_growth: future value of a balance plus monthly contributions. loan_payment: monthly payment for a loan. payoff_time: months and interest to clear a balance at a fixed payment. time_to_target: months to reach a savings target. affordability: 28/36 rule housing limits from gross income. retirement_target: portfolio implied by an annual spend at a withdrawal rate.',
        },
        principal_dollars: { type: 'number', description: 'Starting balance, loan amount, or debt balance.' },
        monthly_dollars: { type: 'number', description: 'Monthly contribution or monthly payment.' },
        annual_rate_percent: { type: 'number', description: 'Annual return rate or APR, e.g. 7 or 22.99.' },
        years: { type: 'number', description: 'Time horizon in years.' },
        target_dollars: { type: 'number', description: 'Savings target, for time_to_target.' },
        gross_annual_income_dollars: { type: 'number', description: 'Gross yearly income, for affordability.' },
        existing_monthly_debt_dollars: {
          type: 'number',
          description: 'Existing monthly debt payments, for affordability.',
        },
        annual_spend_dollars: { type: 'number', description: 'Annual spending, for retirement_target.' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
  },
};

export function toolsFor(names: string[]): Anthropic.Beta.BetaTool[] {
  return names
    .map((name) => TOOL_DEFINITIONS[name])
    .filter((tool): tool is Anthropic.Beta.BetaTool => Boolean(tool));
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

const dollars = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) : fallback;

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/**
 * Runs a tool call against local state.
 *
 * Returns plain JSON-able objects with dollar figures rather than cents — the
 * model reads and writes dollars everywhere else, and a silent unit mismatch
 * here would produce answers that are wrong by a factor of 100 while looking
 * completely reasonable.
 */
export function executeTool(
  name: string,
  input: Record<string, unknown>,
  state: AppState,
  reference: ISODate,
): unknown {
  switch (name) {
    case 'get_financial_summary': {
      const period = resolvePeriod(String(input.period ?? 'current_month'), reference);
      return buildFacts(state, reference, period);
    }

    case 'get_category_detail': {
      const categoryId = String(input.category_id ?? '');
      const period = monthPeriod(cycleKeyOf(reference));
      const snapshot = computeSnapshot(state, period, reference);
      const category = findCategory(state.categories, categoryId);
      const breakdown = snapshot.categories.find((c) => c.categoryId === categoryId);
      const points = trend(state, reference, 6);

      return {
        category: category.name,
        found: Boolean(breakdown),
        spent_dollars: toDollars(breakdown?.spentCents ?? 0),
        percent_of_spend: breakdown?.percent ?? 0,
        cap_dollars: category.monthlyCapCents ? toDollars(category.monthlyCapCents) : null,
        percent_of_cap: breakdown?.capPercent ?? null,
        six_month_history: points.map((point) => ({
          month: point.cycleKey,
          spent_dollars: toDollars(point.byCategory[categoryId] ?? 0),
        })),
        transactions: linesForCategory(snapshot.lines, categoryId).map((line) => ({
          name: line.name,
          amount_dollars: toDollars(line.amountCents),
          date: line.date,
          type: line.recurrence,
          already_paid: !line.upcoming,
        })),
      };
    }

    case 'list_transactions': {
      const period = monthPeriod(cycleKeyOf(reference));
      const snapshot = computeSnapshot(state, period, reference);
      const minCents = dollars(input.min_amount_dollars, 0);
      const limit = Math.max(1, Math.min(100, num(input.limit, 20)));
      const categoryId = input.category_id ? String(input.category_id) : null;

      return {
        transactions: snapshot.lines
          .filter((line) => (categoryId ? line.categoryId === categoryId : true))
          .filter((line) => line.amountCents >= minCents)
          .sort((a, b) => b.amountCents - a.amountCents)
          .slice(0, limit)
          .map((line) => ({
            name: line.name,
            amount_dollars: toDollars(line.amountCents),
            category: findCategory(state.categories, line.categoryId).name,
            date: line.date,
            type: line.recurrence,
            already_paid: !line.upcoming,
          })),
      };
    }

    case 'get_debt_analysis': {
      const facts = buildFacts(state, reference);
      const override = input.extra_payment_dollars;
      const extraCents =
        typeof override === 'number' ? dollars(override) : (facts.debt.payoff?.extraPaymentCents ?? 0);
      const recomputed = simulateMonthlyChange(
        state,
        facts,
        extraCents - (facts.debt.payoff?.extraPaymentCents ?? 0),
        'extra payment',
      );

      return {
        total_debt_dollars: toDollars(facts.debt.totalCents),
        blended_apr_percent: facts.debt.blendedAprPercent,
        minimums_dollars: toDollars(facts.debt.minimumsCents),
        monthly_interest_dollars: toDollars(facts.debt.monthlyInterestCents),
        overall_utilization_percent: facts.debt.overallUtilizationPercent,
        accounts: facts.debt.items.map((d) => ({
          name: d.name,
          balance_dollars: toDollars(d.balanceCents),
          apr_percent: d.aprPercent,
          minimum_dollars: toDollars(d.minimumPaymentCents),
          monthly_interest_dollars: toDollars(d.monthlyInterestCents),
          credit_limit_dollars: d.creditLimitCents ? toDollars(d.creditLimitCents) : null,
          utilization_percent: d.utilizationPercent ?? null,
        })),
        payoff_at_extra_payment: facts.debt.payoff
          ? {
              extra_payment_dollars: toDollars(extraCents),
              avalanche_months: facts.debt.payoff.avalancheMonths,
              snowball_months: facts.debt.payoff.snowballMonths,
              avalanche_interest_dollars: toDollars(facts.debt.payoff.avalancheInterestCents),
              snowball_interest_dollars: toDollars(facts.debt.payoff.snowballInterestCents),
              interest_saved_by_avalanche_dollars: toDollars(facts.debt.payoff.interestSavedCents),
              never_clears: facts.debt.payoff.impossible,
              avalanche_order: facts.debt.payoff.avalancheOrder,
              months_saved_vs_current: recomputed.debtMonthsSaved,
            }
          : null,
      };
    }

    case 'get_goals': {
      const facts = buildFacts(state, reference);
      return {
        goals: facts.goals.map((g) => ({
          name: g.name,
          target_dollars: toDollars(g.targetCents),
          saved_dollars: toDollars(g.savedCents),
          remaining_dollars: toDollars(g.remainingCents),
          percent_funded: g.percentFunded,
          months_to_fund: g.monthsToFundAtCurrentRate,
          reserved_from_safe_to_spend: g.reserved,
        })),
        emergency_fund: {
          monthly_essentials_dollars: toDollars(facts.emergencyFund.monthlyEssentialsCents),
          three_month_target_dollars: toDollars(facts.emergencyFund.threeMonthTargetCents),
          six_month_target_dollars: toDollars(facts.emergencyFund.sixMonthTargetCents),
          months_covered: facts.emergencyFund.monthsCovered,
        },
      };
    }

    case 'get_subscriptions': {
      const facts = buildFacts(state, reference);
      return {
        count: facts.subscriptions.count,
        monthly_total_dollars: toDollars(facts.subscriptions.monthlyCents),
        annual_total_dollars: toDollars(facts.subscriptions.annualCents),
        items: facts.subscriptions.items.map((s) => ({
          name: s.name,
          monthly_dollars: toDollars(s.monthlyCents),
          annual_dollars: toDollars(s.annualCents),
        })),
      };
    }

    case 'simulate_change': {
      const facts = buildFacts(state, reference);
      const result = simulateMonthlyChange(
        state,
        facts,
        dollars(input.monthly_change_dollars),
        String(input.description ?? 'change'),
      );
      return {
        description: result.description,
        monthly_change_dollars: toDollars(result.monthlyDeltaCents),
        annual_impact_dollars: toDollars(result.annualImpactCents),
        new_savings_rate_percent: result.newSavingsRatePercent,
        current_savings_rate_percent: facts.cashflow.savingsRatePercent,
        debt_months_saved: result.debtMonthsSaved,
        debt_interest_saved_dollars:
          result.debtInterestSavedCents === null ? null : toDollars(result.debtInterestSavedCents),
        goal_months_saved: result.goalMonthsSaved,
      };
    }

    case 'calculate':
      return runCalculation(input);

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function runCalculation(input: Record<string, unknown>): unknown {
  const operation = String(input.operation ?? '');

  switch (operation) {
    case 'compound_growth': {
      const years = num(input.years, 10);
      const rate = num(input.annual_rate_percent, 7);
      const result = projectGrowth(
        dollars(input.principal_dollars),
        dollars(input.monthly_dollars),
        rate,
        years,
      );
      return {
        operation,
        assumptions: `${rate}% annual return, compounded monthly, contributions at month end, over ${years} years. A rate is an assumption, not a promise — returns are not guaranteed.`,
        future_value_dollars: toDollars(result.futureValueCents),
        total_contributed_dollars: toDollars(result.contributedCents),
        growth_dollars: toDollars(result.growthCents),
        yearly_balances_dollars: result.yearlyBalancesCents.map(toDollars),
      };
    }

    case 'loan_payment': {
      const years = num(input.years, 30);
      const rate = num(input.annual_rate_percent, 6.5);
      const principal = dollars(input.principal_dollars);
      const payment = loanPayment(principal, rate, Math.round(years * 12));
      return {
        operation,
        monthly_payment_dollars: toDollars(payment),
        total_paid_dollars: toDollars(payment * Math.round(years * 12)),
        total_interest_dollars: toDollars(payment * Math.round(years * 12) - principal),
        assumptions: `${rate}% APR over ${years} years, principal and interest only — excludes tax, insurance and fees.`,
      };
    }

    case 'payoff_time': {
      const result = payoffTime(
        dollars(input.principal_dollars),
        num(input.annual_rate_percent, 20),
        dollars(input.monthly_dollars),
      );
      return {
        operation,
        months: result.neverClears ? null : result.months,
        never_clears: result.neverClears,
        total_interest_dollars: toDollars(result.totalInterestCents),
        total_paid_dollars: toDollars(result.totalPaidCents),
        note: result.neverClears
          ? 'The payment does not cover the monthly interest, so the balance never reaches zero.'
          : undefined,
      };
    }

    case 'time_to_target': {
      const result = timeToTarget(
        dollars(input.target_dollars),
        dollars(input.monthly_dollars),
        dollars(input.principal_dollars),
        num(input.annual_rate_percent, 0),
      );
      return {
        operation,
        months: result.neverReaches ? null : result.months,
        years: result.neverReaches ? null : Number((result.months / 12).toFixed(1)),
        never_reaches: result.neverReaches,
        final_balance_dollars: toDollars(result.finalBalanceCents),
      };
    }

    case 'affordability': {
      const result = affordability(
        dollars(input.gross_annual_income_dollars),
        dollars(input.existing_monthly_debt_dollars),
        num(input.annual_rate_percent, 6.5),
        num(input.years, 30),
      );
      return {
        operation,
        max_monthly_housing_dollars: toDollars(result.maxMonthlyHousingCents),
        max_monthly_all_debt_dollars: toDollars(result.maxMonthlyAllDebtCents),
        estimated_max_loan_dollars: toDollars(result.estimatedMaxLoanCents),
        max_rent_dollars: toDollars(result.maxRentCents),
        assumptions: result.assumptions,
      };
    }

    case 'retirement_target': {
      const rate = num(input.annual_rate_percent, 4);
      const annualSpend = dollars(input.annual_spend_dollars);
      return {
        operation,
        portfolio_needed_dollars: toDollars(retirementTarget(annualSpend, rate)),
        annual_spend_dollars: toDollars(annualSpend),
        withdrawal_rate_percent: rate,
        assumptions:
          'The 4% rule comes from historical US market data over 30-year retirements. It is a planning heuristic, not a guarantee, and it assumes a diversified portfolio and flexible spending.',
      };
    }

    default:
      return { error: `Unknown operation: ${operation}` };
  }
}

function resolvePeriod(name: string, reference: ISODate) {
  const current = cycleKeyOf(reference);
  switch (name) {
    case 'last_month':
      return monthPeriod(shiftCycle(current, -1));
    case 'last_3_months':
      return customPeriod(`${shiftCycle(current, -2)}-01`, reference);
    case 'last_6_months':
      return customPeriod(`${shiftCycle(current, -5)}-01`, reference);
    case 'year_to_date':
      return customPeriod(`${reference.slice(0, 4)}-01-01`, reference);
    default:
      return monthPeriod(current);
  }
}
