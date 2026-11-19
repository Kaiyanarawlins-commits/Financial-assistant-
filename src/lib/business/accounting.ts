/**
 * Business-mode accounting maths.
 *
 * Same discipline as the personal engine: integer cents in, integer cents out,
 * pure functions, no state. Two things are specific to accounting rather than
 * budgeting and drive most of the design here.
 *
 * First, a depreciation schedule has to *foot*. If the yearly charges do not
 * sum exactly to cost less salvage, the books do not balance and the number is
 * worthless — so every schedule rounds each period and lets the final period
 * absorb the remainder, rather than rounding independently and hoping.
 *
 * Second, these are the figures a business puts on a tax return, so the
 * assumptions have to be visible. Each result carries the notes explaining what
 * convention was applied; the UI and the advisor both surface them rather than
 * presenting a number as if it were the only possible answer.
 */

export type DepreciationMethod =
  | 'straight-line'
  | 'declining-balance'
  | 'sum-of-years'
  | 'units-of-production';

export const DEPRECIATION_METHODS: { id: DepreciationMethod; label: string; note: string }[] = [
  {
    id: 'straight-line',
    label: 'Straight line',
    note: 'Equal charge every year. The default, and what most small businesses use.',
  },
  {
    id: 'declining-balance',
    label: 'Declining balance',
    note: 'A fixed percentage of the falling book value. Front-loads the expense.',
  },
  {
    id: 'sum-of-years',
    label: 'Sum of years',
    note: 'Accelerated, but always reaches salvage exactly at the end of life.',
  },
  {
    id: 'units-of-production',
    label: 'Units of production',
    note: 'Charged by use rather than time. For machinery with a rated output.',
  },
];

export interface DepreciationRow {
  /** 1-based. Year for the time methods, output period for units-of-production. */
  period: number;
  openingBookValueCents: number;
  expenseCents: number;
  accumulatedCents: number;
  closingBookValueCents: number;
  /** Units-of-production only. */
  units?: number;
}

export interface DepreciationSchedule {
  method: DepreciationMethod;
  costCents: number;
  salvageCents: number;
  /** Cost less salvage — the amount that may be written off in total. */
  depreciableBaseCents: number;
  rows: DepreciationRow[];
  totalExpenseCents: number;
  /** Book value once the schedule runs out. */
  endingBookValueCents: number;
  /** The annual rate applied, where the method has a single one. */
  ratePercent: number | null;
  /** Assumptions and conventions a reader needs in order to check the figure. */
  notes: string[];
}

export interface DepreciationInput {
  method: DepreciationMethod;
  costCents: number;
  salvageCents: number;
  /** Useful life in whole years. Ignored by units-of-production. */
  lifeYears: number;
  /** Declining balance only: 2 is double-declining, 1.5 is 150%. Defaults to 2. */
  factor?: number;
  /** Units-of-production only: lifetime rated output. */
  totalUnits?: number;
  /** Units-of-production only: output in each period. */
  unitsPerPeriod?: number[];
}

const round = (value: number): number => Math.round(value);

/**
 * Builds rows from a list of per-period charges.
 *
 * Centralised because it is the one place the schedule can silently stop
 * footing: `cap` clamps each charge so book value never falls below salvage,
 * which is a real accounting rule and also what stops a declining-balance
 * schedule running the asset negative.
 */
function buildRows(
  costCents: number,
  salvageCents: number,
  charges: number[],
  units?: number[],
): { rows: DepreciationRow[]; total: number } {
  const rows: DepreciationRow[] = [];
  let book = costCents;
  let accumulated = 0;

  charges.forEach((raw, index) => {
    const cap = Math.max(0, book - salvageCents);
    const expense = Math.max(0, Math.min(round(raw), cap));
    accumulated += expense;
    const opening = book;
    book -= expense;
    rows.push({
      period: index + 1,
      openingBookValueCents: opening,
      expenseCents: expense,
      accumulatedCents: accumulated,
      closingBookValueCents: book,
      ...(units ? { units: units[index] ?? 0 } : {}),
    });
  });

  return { rows, total: accumulated };
}

export function depreciate(input: DepreciationInput): DepreciationSchedule {
  const costCents = Math.max(0, round(input.costCents));
  const salvageCents = Math.max(0, Math.min(round(input.salvageCents), costCents));
  const base = costCents - salvageCents;
  const life = Math.max(1, Math.round(input.lifeYears));
  const notes: string[] = [];

  let charges: number[] = [];
  let units: number[] | undefined;
  let ratePercent: number | null = null;

  switch (input.method) {
    case 'straight-line': {
      ratePercent = 100 / life;
      const perYear = base / life;
      charges = Array.from({ length: life }, () => perYear);
      // Rounding each year independently leaves the schedule a few cents short
      // or long; the final year takes the difference so the total is exact.
      charges[life - 1] = base - round(perYear) * (life - 1);
      notes.push(
        `Straight line: (${money(costCents)} cost − ${money(salvageCents)} salvage) ÷ ${life} years.`,
      );
      notes.push('Assumes the asset was in service for the full first year — no part-year convention applied.');
      break;
    }

    case 'declining-balance': {
      const factor = input.factor && input.factor > 0 ? input.factor : 2;
      const rate = factor / life;
      ratePercent = rate * 100;
      let book = costCents;
      for (let year = 0; year < life; year++) {
        // The rate applies to book value, not to the depreciable base —
        // declining balance ignores salvage until the floor is reached.
        const charge = Math.min(book * rate, Math.max(0, book - salvageCents));
        charges.push(charge);
        book -= round(charge);
      }
      notes.push(
        `Declining balance at ${(rate * 100).toFixed(2)}% a year (${factor}× the ${(100 / life).toFixed(2)}% straight-line rate), applied to the falling book value.`,
      );
      notes.push('The rate is applied to book value, so salvage is a floor rather than part of the calculation.');
      break;
    }

    case 'sum-of-years': {
      const digits = (life * (life + 1)) / 2;
      let assigned = 0;
      for (let year = 1; year <= life; year++) {
        // The last year takes whatever is left, so the schedule foots exactly.
        const charge =
          year === life ? base - assigned : round((base * (life - year + 1)) / digits);
        assigned += charge;
        charges.push(charge);
      }
      notes.push(
        `Sum-of-years-digits: the denominator is ${digits} (1+2+…+${life}), and year 1 takes ${life}/${digits} of the ${money(base)} base.`,
      );
      break;
    }

    case 'units-of-production': {
      const total = Math.max(1, Math.round(input.totalUnits ?? 0));
      const produced = (input.unitsPerPeriod ?? []).map((n) => Math.max(0, n));
      const perUnit = base / total;
      units = produced;
      charges = produced.map((n) => n * perUnit);

      const cumulative = produced.reduce((sum, n) => sum + n, 0);
      if (cumulative >= total && charges.length > 0) {
        // Output has reached the rated life, so the schedule must close at
        // salvage exactly rather than a rounding step away from it.
        const allButLast = charges.slice(0, -1).reduce((sum, c) => sum + round(c), 0);
        charges[charges.length - 1] = base - allButLast;
      }
      ratePercent = null;
      notes.push(
        `Units of production: ${money(base)} ÷ ${total.toLocaleString()} units = ${(perUnit / 100).toFixed(4)} per unit.`,
      );
      notes.push(
        `${cumulative.toLocaleString()} of ${total.toLocaleString()} rated units used so far. Depreciation stops once output reaches the rating, whatever the calendar says.`,
      );
      break;
    }
  }

  const { rows, total } = buildRows(costCents, salvageCents, charges, units);
  const endingBookValue = rows.at(-1)?.closingBookValueCents ?? costCents;
  const unrecovered = endingBookValue - salvageCents;

  if (input.method === 'declining-balance' && unrecovered > 0) {
    notes.push(
      `After ${life} years ${money(unrecovered)} of book value still sits above salvage. Declining balance never quite reaches the floor, which is why entities commonly switch to straight line for the remaining life once that charge would be larger.`,
    );
  }

  return {
    method: input.method,
    costCents,
    salvageCents,
    depreciableBaseCents: base,
    rows,
    totalExpenseCents: total,
    endingBookValueCents: endingBookValue,
    ratePercent,
    notes,
  };
}

/** Local formatter — the module must not depend on the UI's currency choice. */
function money(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// ---------------------------------------------------------------------------
// Appreciation
// ---------------------------------------------------------------------------

export interface AppreciationRow {
  year: number;
  valueCents: number;
  /** Change during this year alone. */
  gainCents: number;
}

export interface AppreciationResult {
  startingValueCents: number;
  endingValueCents: number;
  totalGainCents: number;
  totalGainPercent: number;
  /** Compound annual growth rate — equals the input rate, restated for checking. */
  cagrPercent: number;
  rows: AppreciationRow[];
  /** True when the rate is negative, i.e. the asset is losing market value. */
  declining: boolean;
}

/**
 * Compound change in an asset's market value.
 *
 * Deliberately separate from depreciation: depreciation is an accounting
 * allocation of a known cost across the periods that benefit from it, and
 * appreciation is a change in what the thing is worth. Conflating them is the
 * most common error in small-business bookkeeping — a building can appreciate
 * in value every year while being depreciated to zero on the books, and both
 * figures are correct.
 */
export function appreciate(
  startingValueCents: number,
  annualRatePercent: number,
  years: number,
): AppreciationResult {
  const start = Math.max(0, round(startingValueCents));
  const span = Math.max(0, Math.round(years));
  const rate = annualRatePercent / 100;

  const rows: AppreciationRow[] = [];
  let value = start;
  for (let year = 1; year <= span; year++) {
    const next = round(value * (1 + rate));
    rows.push({ year, valueCents: next, gainCents: next - value });
    value = next;
  }

  const totalGain = value - start;
  return {
    startingValueCents: start,
    endingValueCents: value,
    totalGainCents: totalGain,
    totalGainPercent: start > 0 ? (totalGain / start) * 100 : 0,
    cagrPercent: span > 0 && start > 0 ? (Math.pow(value / start, 1 / span) - 1) * 100 : 0,
    rows,
    declining: annualRatePercent < 0,
  };
}

/** Compound annual growth rate implied by a start value, end value and horizon. */
export function cagr(startCents: number, endCents: number, years: number): number | null {
  if (startCents <= 0 || endCents <= 0 || years <= 0) return null;
  return (Math.pow(endCents / startCents, 1 / years) - 1) * 100;
}

// ---------------------------------------------------------------------------
// Inflation and deflation
// ---------------------------------------------------------------------------

export interface InflationRow {
  year: number;
  /** What the same basket costs in that year's money. */
  costCents: number;
  /** What today's fixed sum is worth in that year, in today's money. */
  realValueCents: number;
}

export interface InflationResult {
  amountCents: number;
  ratePercent: number;
  years: number;
  /** What the same purchase costs after `years`. */
  futureCostCents: number;
  /** What a sum held as cash is worth after `years`, in today's purchasing power. */
  purchasingPowerCents: number;
  /** Cumulative price change over the horizon. */
  cumulativePriceChangePercent: number;
  /** Purchasing power surrendered, as a positive percentage under inflation. */
  purchasingPowerLostPercent: number;
  rows: InflationRow[];
  /** True when the rate is negative. Prices fall; cash gains purchasing power. */
  deflation: boolean;
}

/**
 * The two sides of a price-level change.
 *
 * People conflate them constantly, so both are returned: what a thing will
 * *cost* later (the price goes up) and what money will be *worth* later (the
 * same cash buys less). They are reciprocals, not the same number — 3% for 10
 * years raises a price by 34.4% and cuts purchasing power by 25.6%, and quoting
 * one figure for both is a real error with real consequences.
 *
 * A negative rate is deflation and is handled by the same arithmetic.
 */
export function inflationImpact(
  amountCents: number,
  annualRatePercent: number,
  years: number,
): InflationResult {
  const amount = Math.max(0, round(amountCents));
  const span = Math.max(0, Math.round(years));
  const rate = annualRatePercent / 100;
  const factor = Math.pow(1 + rate, span);

  const rows: InflationRow[] = [];
  for (let year = 1; year <= span; year++) {
    const yearFactor = Math.pow(1 + rate, year);
    rows.push({
      year,
      costCents: round(amount * yearFactor),
      realValueCents: round(amount / yearFactor),
    });
  }

  const futureCost = round(amount * factor);
  const purchasingPower = factor === 0 ? 0 : round(amount / factor);

  return {
    amountCents: amount,
    ratePercent: annualRatePercent,
    years: span,
    futureCostCents: futureCost,
    purchasingPowerCents: purchasingPower,
    cumulativePriceChangePercent: (factor - 1) * 100,
    purchasingPowerLostPercent: (1 - 1 / factor) * 100,
    rows,
    deflation: annualRatePercent < 0,
  };
}

/**
 * The Fisher equation, exact rather than the "subtract them" approximation.
 *
 * At small rates the shortcut is close enough that nobody notices; at 12%
 * nominal against 8% inflation it says 4% when the answer is 3.70%, and the
 * error compounds. Exactness costs nothing here.
 */
export function realRatePercent(nominalPercent: number, inflationPercent: number): number {
  const nominal = nominalPercent / 100;
  const inflation = inflationPercent / 100;
  if (1 + inflation === 0) return 0;
  return ((1 + nominal) / (1 + inflation) - 1) * 100;
}

/** The nominal return needed to achieve a target real return under inflation. */
export function nominalRatePercent(realPercent: number, inflationPercent: number): number {
  return ((1 + realPercent / 100) * (1 + inflationPercent / 100) - 1) * 100;
}

/**
 * Restates a sum between two price levels using published index values.
 *
 * Takes the index numbers as inputs rather than shipping a table: CPI series are
 * revised, differ by country and basket, and a figure baked into the bundle
 * would quietly go stale. The user reads the two index values off the
 * statistics agency's own page, and this does the arithmetic.
 */
export function cpiAdjust(amountCents: number, fromIndex: number, toIndex: number): number | null {
  if (!Number.isFinite(fromIndex) || fromIndex <= 0 || !Number.isFinite(toIndex) || toIndex <= 0) {
    return null;
  }
  return round((amountCents * toIndex) / fromIndex);
}

/** Average annual inflation implied by a move between two index values. */
export function impliedInflationPercent(
  fromIndex: number,
  toIndex: number,
  years: number,
): number | null {
  if (fromIndex <= 0 || toIndex <= 0 || years <= 0) return null;
  return (Math.pow(toIndex / fromIndex, 1 / years) - 1) * 100;
}

// ---------------------------------------------------------------------------
// Break-even and margins
// ---------------------------------------------------------------------------

export interface BreakEvenResult {
  fixedCostsCents: number;
  pricePerUnitCents: number;
  variableCostPerUnitCents: number;
  /** Price less variable cost — what each sale contributes to fixed costs. */
  contributionMarginCents: number;
  contributionMarginRatioPercent: number;
  /** Rounded up: you cannot break even on part of a sale. */
  unitsToBreakEven: number | null;
  revenueAtBreakEvenCents: number | null;
  /** True when price does not exceed variable cost, so volume cannot help. */
  neverBreaksEven: boolean;
  /** Units needed for a stated profit, when one was supplied. */
  unitsForTargetProfit: number | null;
  targetProfitCents: number;
}

export function breakEven(
  fixedCostsCents: number,
  pricePerUnitCents: number,
  variableCostPerUnitCents: number,
  targetProfitCents = 0,
): BreakEvenResult {
  const fixed = Math.max(0, round(fixedCostsCents));
  const price = Math.max(0, round(pricePerUnitCents));
  const variable = Math.max(0, round(variableCostPerUnitCents));
  const contribution = price - variable;
  const target = Math.max(0, round(targetProfitCents));

  if (contribution <= 0) {
    return {
      fixedCostsCents: fixed,
      pricePerUnitCents: price,
      variableCostPerUnitCents: variable,
      contributionMarginCents: contribution,
      contributionMarginRatioPercent: price > 0 ? (contribution / price) * 100 : 0,
      unitsToBreakEven: null,
      revenueAtBreakEvenCents: null,
      neverBreaksEven: true,
      unitsForTargetProfit: null,
      targetProfitCents: target,
    };
  }

  const units = Math.ceil(fixed / contribution);
  return {
    fixedCostsCents: fixed,
    pricePerUnitCents: price,
    variableCostPerUnitCents: variable,
    contributionMarginCents: contribution,
    contributionMarginRatioPercent: (contribution / price) * 100,
    unitsToBreakEven: units,
    revenueAtBreakEvenCents: units * price,
    neverBreaksEven: false,
    unitsForTargetProfit: target > 0 ? Math.ceil((fixed + target) / contribution) : null,
    targetProfitCents: target,
  };
}

export interface MarginResult {
  revenueCents: number;
  cogsCents: number;
  operatingExpensesCents: number;
  otherCostsCents: number;
  grossProfitCents: number;
  grossMarginPercent: number;
  operatingProfitCents: number;
  operatingMarginPercent: number;
  netProfitCents: number;
  netMarginPercent: number;
  /** Profit as a percentage of cost, which is what a "50% markup" means. */
  markupOnCostPercent: number;
}

/**
 * The income-statement ratios, in statement order.
 *
 * Margin and markup are returned side by side because they are the pair people
 * mix up, and the mistake is expensive in the direction that matters: a 50%
 * markup is a 33.3% margin, so pricing at "50%" when you needed a 50% margin
 * leaves a third of the intended profit on the table.
 */
export function margins(
  revenueCents: number,
  cogsCents: number,
  operatingExpensesCents = 0,
  otherCostsCents = 0,
): MarginResult {
  const revenue = Math.max(0, round(revenueCents));
  const cogs = Math.max(0, round(cogsCents));
  const opex = Math.max(0, round(operatingExpensesCents));
  const other = Math.max(0, round(otherCostsCents));

  const gross = revenue - cogs;
  const operating = gross - opex;
  const net = operating - other;
  const pct = (part: number) => (revenue > 0 ? (part / revenue) * 100 : 0);

  return {
    revenueCents: revenue,
    cogsCents: cogs,
    operatingExpensesCents: opex,
    otherCostsCents: other,
    grossProfitCents: gross,
    grossMarginPercent: pct(gross),
    operatingProfitCents: operating,
    operatingMarginPercent: pct(operating),
    netProfitCents: net,
    netMarginPercent: pct(net),
    markupOnCostPercent: cogs > 0 ? (gross / cogs) * 100 : 0,
  };
}

/** The price that achieves a target gross margin on a known unit cost. */
export function priceForMargin(unitCostCents: number, targetMarginPercent: number): number | null {
  if (targetMarginPercent >= 100) return null;
  return round(unitCostCents / (1 - targetMarginPercent / 100));
}

// ---------------------------------------------------------------------------
// Investment appraisal
// ---------------------------------------------------------------------------

/**
 * Net present value. `cashflows[0]` is period zero and is normally the negative
 * outlay; later entries are the returns it buys.
 */
export function npv(discountRatePercent: number, cashflowsCents: number[]): number {
  const rate = discountRatePercent / 100;
  return round(
    cashflowsCents.reduce((total, flow, period) => total + flow / Math.pow(1 + rate, period), 0),
  );
}

/**
 * Internal rate of return, by bisection.
 *
 * Bisection rather than Newton–Raphson because it cannot diverge: it needs only
 * a sign change to bracket the root, and a wrong answer here is far worse than
 * a slow one. Returns null when no sign change exists in the searched range,
 * which is the honest answer for a cashflow with no real IRR.
 */
export function irr(cashflowsCents: number[], guessRangePercent = [-95, 1000]): number | null {
  if (cashflowsCents.length < 2) return null;

  const value = (ratePercent: number) =>
    cashflowsCents.reduce(
      (total, flow, period) => total + flow / Math.pow(1 + ratePercent / 100, period),
      0,
    );

  let low = guessRangePercent[0] ?? -95;
  let high = guessRangePercent[1] ?? 1000;
  let lowValue = value(low);
  let highValue = value(high);

  if (!Number.isFinite(lowValue) || !Number.isFinite(highValue)) return null;
  if (lowValue === 0) return low;
  if (highValue === 0) return high;
  if (lowValue > 0 === highValue > 0) return null;

  for (let i = 0; i < 200; i++) {
    const mid = (low + high) / 2;
    const midValue = value(mid);
    if (Math.abs(midValue) < 0.5 || high - low < 1e-7) return mid;
    if (midValue > 0 === lowValue > 0) {
      low = mid;
      lowValue = midValue;
    } else {
      high = mid;
      highValue = midValue;
    }
  }
  return (low + high) / 2;
}

/**
 * Payback period in periods, interpolated within the period that crosses zero.
 * Ignores the time value of money by definition — that is what NPV is for.
 */
export function paybackPeriods(cashflowsCents: number[]): number | null {
  let cumulative = 0;
  for (let period = 0; period < cashflowsCents.length; period++) {
    const flow = cashflowsCents[period] ?? 0;
    const before = cumulative;
    cumulative += flow;
    if (before < 0 && cumulative >= 0 && flow !== 0) {
      return period - 1 + -before / flow;
    }
  }
  return null;
}

export function roiPercent(gainCents: number, costCents: number): number | null {
  if (costCents <= 0) return null;
  return (gainCents / costCents) * 100;
}
