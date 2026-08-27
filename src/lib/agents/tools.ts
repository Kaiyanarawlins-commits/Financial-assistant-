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
import {
  appreciate,
  breakEven,
  cagr,
  depreciate,
  inflationImpact,
  irr,
  margins,
  npv,
  paybackPeriods,
  realRatePercent,
  roiPercent,
  type DepreciationMethod,
} from '../business/accounting';
import {
  describeMarketError,
  fetchHistory,
  fetchQuote,
  isMarketConfigured,
  loadMarketConfig,
  MarketError,
  normaliseSymbol,
  providerSupportsHistory,
} from '../business/market';
import { study } from '../business/study';

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

  business_calculate: {
    name: 'business_calculate',
    description:
      "Business accounting math: depreciation schedules (straight line, declining balance, sum-of-years-digits, units of production), asset appreciation, inflation and deflation adjustment, real vs nominal rates, break-even, margins and markup, NPV, IRR and ROI. Use this for any accounting question rather than working it out yourself — a depreciation schedule has to foot to the cent, and these do.",
    input_schema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'depreciation',
            'appreciation',
            'inflation',
            'real_rate',
            'break_even',
            'margins',
            'npv',
            'irr',
            'roi',
          ],
          description:
            'depreciation: full schedule for an asset. appreciation: compound change in market value. inflation: what a sum will cost and what it will be worth (negative rate = deflation). real_rate: inflation-adjusted return, exact Fisher. break_even: units and revenue needed. margins: gross/operating/net margin and markup. npv/irr: appraise a cashflow series. roi: simple return on cost.',
        },
        method: {
          type: 'string',
          enum: ['straight-line', 'declining-balance', 'sum-of-years', 'units-of-production'],
          description: 'Depreciation method. Defaults to straight-line.',
        },
        cost_dollars: { type: 'number', description: 'Asset cost, for depreciation.' },
        salvage_dollars: { type: 'number', description: 'Salvage/residual value at end of life.' },
        life_years: { type: 'number', description: 'Useful life in years.' },
        factor: { type: 'number', description: 'Declining balance multiplier: 2 for double-declining.' },
        total_units: { type: 'number', description: 'Units-of-production: lifetime rated output.' },
        units_per_period: {
          type: 'array',
          items: { type: 'number' },
          description: 'Units-of-production: output in each period.',
        },
        amount_dollars: {
          type: 'number',
          description: 'The sum being appreciated, inflated, or used as a starting value.',
        },
        annual_rate_percent: {
          type: 'number',
          description: 'Growth, inflation or discount rate. Negative for deflation or decline.',
        },
        inflation_percent: { type: 'number', description: 'Inflation rate, for real_rate.' },
        years: { type: 'number', description: 'Horizon in years.' },
        fixed_costs_dollars: { type: 'number', description: 'Break-even: fixed costs per period.' },
        price_per_unit_dollars: { type: 'number', description: 'Break-even: selling price per unit.' },
        variable_cost_per_unit_dollars: { type: 'number', description: 'Break-even: variable cost per unit.' },
        target_profit_dollars: { type: 'number', description: 'Break-even: profit to solve for.' },
        revenue_dollars: { type: 'number', description: 'Margins: total revenue.' },
        cogs_dollars: { type: 'number', description: 'Margins: cost of goods sold.' },
        operating_expenses_dollars: { type: 'number', description: 'Margins: operating expenses.' },
        cashflows_dollars: {
          type: 'array',
          items: { type: 'number' },
          description: 'NPV/IRR: period 0 first, normally negative, then the returns.',
        },
        gain_dollars: { type: 'number', description: 'ROI: profit made.' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
  },

  get_asset_register: {
    name: 'get_asset_register',
    description:
      "The user's depreciable assets with cost, method, this year's depreciation charge, accumulated depreciation and current book value. Call this before answering anything about their own equipment or write-offs.",
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },

  get_market_data: {
    name: 'get_market_data',
    description:
      "Current price and study metrics for a stock ticker: last price, day change, 20/50/200-day moving averages, position in the yearly range, annualised volatility and maximum drawdown. Only works when the user has connected a market data provider in Settings; if it reports unavailable, say so plainly and never state a price from memory.",
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Ticker symbol, e.g. AAPL.' },
      },
      required: ['symbol'],
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
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  state: AppState,
  reference: ISODate,
): Promise<unknown> {
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

    case 'business_calculate':
      return runBusinessCalculation(input);

    case 'get_asset_register':
      return assetRegister(state, reference);

    case 'get_market_data':
      return marketData(String(input.symbol ?? ''));

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// Business mode
// ---------------------------------------------------------------------------

function runBusinessCalculation(input: Record<string, unknown>): unknown {
  const operation = String(input.operation ?? '');

  switch (operation) {
    case 'depreciation': {
      const schedule = depreciate({
        method: (String(input.method ?? 'straight-line') as DepreciationMethod),
        costCents: dollars(input.cost_dollars),
        salvageCents: dollars(input.salvage_dollars),
        lifeYears: num(input.years ?? input.life_years, 5),
        factor: typeof input.factor === 'number' ? input.factor : undefined,
        totalUnits: typeof input.total_units === 'number' ? input.total_units : undefined,
        unitsPerPeriod: Array.isArray(input.units_per_period)
          ? (input.units_per_period as unknown[]).map((n) => num(n, 0))
          : undefined,
      });
      return {
        operation,
        method: schedule.method,
        cost_dollars: toDollars(schedule.costCents),
        salvage_dollars: toDollars(schedule.salvageCents),
        depreciable_base_dollars: toDollars(schedule.depreciableBaseCents),
        annual_rate_percent: schedule.ratePercent,
        total_depreciation_dollars: toDollars(schedule.totalExpenseCents),
        ending_book_value_dollars: toDollars(schedule.endingBookValueCents),
        schedule: schedule.rows.map((row) => ({
          year: row.period,
          opening_book_value_dollars: toDollars(row.openingBookValueCents),
          depreciation_dollars: toDollars(row.expenseCents),
          accumulated_dollars: toDollars(row.accumulatedCents),
          closing_book_value_dollars: toDollars(row.closingBookValueCents),
          units: row.units,
        })),
        notes: schedule.notes,
      };
    }

    case 'appreciation': {
      const years = num(input.years, 10);
      const rate = num(input.annual_rate_percent, 3);
      const result = appreciate(dollars(input.amount_dollars), rate, years);
      return {
        operation,
        starting_value_dollars: toDollars(result.startingValueCents),
        ending_value_dollars: toDollars(result.endingValueCents),
        total_gain_dollars: toDollars(result.totalGainCents),
        total_gain_percent: result.totalGainPercent,
        cagr_percent: result.cagrPercent,
        declining: result.declining,
        yearly_values_dollars: result.rows.map((row) => toDollars(row.valueCents)),
        assumptions: `${rate}% a year compounded annually over ${years} years. Market value, not book value — an appreciating asset can still be depreciated on the books, and both figures are correct.`,
      };
    }

    case 'inflation': {
      const years = num(input.years, 10);
      const rate = num(input.annual_rate_percent, 3);
      const result = inflationImpact(dollars(input.amount_dollars), rate, years);
      return {
        operation,
        amount_dollars: toDollars(result.amountCents),
        rate_percent: rate,
        years,
        deflation: result.deflation,
        future_cost_dollars: toDollars(result.futureCostCents),
        purchasing_power_dollars: toDollars(result.purchasingPowerCents),
        cumulative_price_change_percent: result.cumulativePriceChangePercent,
        purchasing_power_lost_percent: result.purchasingPowerLostPercent,
        note: 'These are two different figures and are commonly confused: the price rises by the first percentage while purchasing power falls by the second, which is always the smaller number.',
      };
    }

    case 'real_rate': {
      const nominal = num(input.annual_rate_percent, 0);
      const inflation = num(input.inflation_percent, 0);
      return {
        operation,
        nominal_rate_percent: nominal,
        inflation_percent: inflation,
        real_rate_percent: realRatePercent(nominal, inflation),
        approximation_percent: nominal - inflation,
        note: 'The exact Fisher figure, not the subtraction shortcut. The gap widens as rates rise.',
      };
    }

    case 'break_even': {
      const result = breakEven(
        dollars(input.fixed_costs_dollars),
        dollars(input.price_per_unit_dollars),
        dollars(input.variable_cost_per_unit_dollars),
        dollars(input.target_profit_dollars),
      );
      return {
        operation,
        fixed_costs_dollars: toDollars(result.fixedCostsCents),
        price_per_unit_dollars: toDollars(result.pricePerUnitCents),
        variable_cost_per_unit_dollars: toDollars(result.variableCostPerUnitCents),
        contribution_margin_dollars: toDollars(result.contributionMarginCents),
        contribution_margin_percent: result.contributionMarginRatioPercent,
        units_to_break_even: result.unitsToBreakEven,
        revenue_at_break_even_dollars:
          result.revenueAtBreakEvenCents === null ? null : toDollars(result.revenueAtBreakEvenCents),
        units_for_target_profit: result.unitsForTargetProfit,
        never_breaks_even: result.neverBreaksEven,
        note: result.neverBreaksEven
          ? 'Price does not exceed variable cost, so every additional sale increases the loss. Volume cannot fix this — the price or the unit cost has to change.'
          : undefined,
      };
    }

    case 'margins': {
      const result = margins(
        dollars(input.revenue_dollars),
        dollars(input.cogs_dollars),
        dollars(input.operating_expenses_dollars),
      );
      return {
        operation,
        revenue_dollars: toDollars(result.revenueCents),
        cogs_dollars: toDollars(result.cogsCents),
        operating_expenses_dollars: toDollars(result.operatingExpensesCents),
        gross_profit_dollars: toDollars(result.grossProfitCents),
        gross_margin_percent: result.grossMarginPercent,
        operating_profit_dollars: toDollars(result.operatingProfitCents),
        operating_margin_percent: result.operatingMarginPercent,
        net_profit_dollars: toDollars(result.netProfitCents),
        net_margin_percent: result.netMarginPercent,
        markup_on_cost_percent: result.markupOnCostPercent,
        note: 'Margin is profit over revenue; markup is profit over cost. A 50% markup is a 33.3% margin, and pricing one when you meant the other is the most expensive arithmetic error in small business.',
      };
    }

    case 'npv':
    case 'irr': {
      const flows = Array.isArray(input.cashflows_dollars)
        ? (input.cashflows_dollars as unknown[]).map((value) => dollars(value))
        : [];
      const rate = num(input.annual_rate_percent, 10);
      const internal = irr(flows);
      return {
        operation,
        cashflows_dollars: flows.map(toDollars),
        discount_rate_percent: rate,
        npv_dollars: toDollars(npv(rate, flows)),
        irr_percent: internal,
        payback_periods: paybackPeriods(flows),
        note:
          internal === null
            ? 'No internal rate of return exists for this cashflow — it never changes sign, so there is no break-even discount rate.'
            : 'IRR ignores the scale of the investment. Compare NPV when ranking projects of different sizes.',
      };
    }

    case 'roi': {
      const gain = dollars(input.gain_dollars);
      const cost = dollars(input.amount_dollars ?? input.cost_dollars);
      const years = num(input.years, 0);
      const simple = roiPercent(gain, cost);
      return {
        operation,
        gain_dollars: toDollars(gain),
        cost_dollars: toDollars(cost),
        roi_percent: simple,
        annualised_percent: years > 0 && cost > 0 ? cagr(cost, cost + gain, years) : null,
        note: years > 0 ? undefined : 'Simple ROI has no time dimension. Supply years for an annualised figure.',
      };
    }

    default:
      return { error: `Unknown operation: ${operation}` };
  }
}

/** The user's own depreciable assets, priced to the reference year. */
function assetRegister(state: AppState, reference: ISODate) {
  const currentYear = Number(reference.slice(0, 4));

  const items = state.assets.map((asset) => {
    const schedule = depreciate({
      method: asset.method,
      costCents: asset.costCents,
      salvageCents: asset.salvageCents,
      lifeYears: asset.lifeYears,
      factor: asset.factor,
      totalUnits: asset.totalUnits,
      unitsPerPeriod: asset.unitsPerPeriod,
    });
    // Depreciation starts in the year the asset was placed in service, so the
    // year index is the elapsed count rather than the calendar year.
    const yearIndex = currentYear - Number(asset.placedInService.slice(0, 4));
    const row = schedule.rows[yearIndex] ?? null;

    return {
      name: asset.name,
      method: asset.method,
      placed_in_service: asset.placedInService,
      cost_dollars: toDollars(asset.costCents),
      salvage_dollars: toDollars(asset.salvageCents),
      life_years: asset.lifeYears,
      year_of_life: row ? yearIndex + 1 : null,
      this_year_depreciation_dollars: row ? toDollars(row.expenseCents) : 0,
      accumulated_depreciation_dollars: row ? toDollars(row.accumulatedCents) : toDollars(schedule.totalExpenseCents),
      book_value_dollars: row
        ? toDollars(row.closingBookValueCents)
        : toDollars(schedule.endingBookValueCents),
      fully_depreciated: !row,
    };
  });

  return {
    count: items.length,
    total_cost_dollars: items.reduce((sum, item) => sum + item.cost_dollars, 0),
    total_book_value_dollars: items.reduce((sum, item) => sum + item.book_value_dollars, 0),
    this_year_depreciation_dollars: items.reduce(
      (sum, item) => sum + item.this_year_depreciation_dollars,
      0,
    ),
    assets: items,
  };
}

/**
 * Live market data for one ticker.
 *
 * Returns `available: false` with a reason rather than throwing, and never
 * substitutes a remembered price — a fabricated quote is the one failure this
 * feature cannot survive, and the model is instructed to relay the reason.
 */
async function marketData(rawSymbol: string) {
  const symbol = normaliseSymbol(rawSymbol);
  if (!symbol) return { available: false, reason: 'invalid-symbol', symbol: rawSymbol };

  const config = loadMarketConfig();
  if (!isMarketConfigured(config)) {
    return {
      available: false,
      symbol,
      reason: 'no-provider',
      message:
        'No market data provider is connected. The user can add a free API key under Settings → Market data. Do not state a price from memory.',
    };
  }

  try {
    const quote = await fetchQuote(symbol, config);
    const candles = providerSupportsHistory(config.provider)
      ? await fetchHistory(symbol, config).catch(() => [])
      : [];
    const metrics = candles.length > 0 ? study(candles) : null;

    return {
      available: true,
      symbol,
      as_of: quote.asOf,
      provider: quote.provider,
      price_dollars: toDollars(quote.priceCents),
      previous_close_dollars:
        quote.previousCloseCents === null ? null : toDollars(quote.previousCloseCents),
      day_change_dollars: quote.changeCents === null ? null : toDollars(quote.changeCents),
      day_change_percent: quote.changePercent,
      study: metrics
        ? {
            sample_days: metrics.sampleDays,
            window_change_percent: metrics.windowChangePercent,
            sma20_dollars: metrics.sma20Cents === null ? null : toDollars(metrics.sma20Cents),
            sma50_dollars: metrics.sma50Cents === null ? null : toDollars(metrics.sma50Cents),
            sma200_dollars: metrics.sma200Cents === null ? null : toDollars(metrics.sma200Cents),
            period_high_dollars:
              metrics.periodHighCents === null ? null : toDollars(metrics.periodHighCents),
            period_low_dollars:
              metrics.periodLowCents === null ? null : toDollars(metrics.periodLowCents),
            position_in_range_percent: metrics.positionInRangePercent,
            annualised_volatility_percent: metrics.annualisedVolatilityPercent,
            max_drawdown_percent: metrics.maxDrawdownPercent,
            trend: metrics.trend,
          }
        : null,
      note: 'Descriptive statistics only. Never present a moving average or a range position as a forecast, and never recommend buying or selling a specific security.',
    };
  } catch (error) {
    return {
      available: false,
      symbol,
      reason: error instanceof MarketError ? error.reason : 'error',
      message: describeMarketError(error),
    };
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
