/**
 * Financial calculators for hypothetical questions.
 *
 * The advisor's grounding in real data is what makes it precise, but it must
 * not make it *narrow*: "if I earned $80k, what house could I afford?" is a
 * perfectly good question about numbers the app has never seen. These are pure
 * functions over supplied figures, so a hypothetical gets the same arithmetic
 * rigour as a question about the user's own balances — and the model can call
 * them as a tool rather than doing compound interest in its head, which is
 * where language models reliably slip.
 *
 * Everything takes and returns integer cents unless named otherwise.
 */

export interface GrowthResult {
  futureValueCents: number;
  contributedCents: number;
  growthCents: number;
  /** Balance at the end of each year, for showing the curve. */
  yearlyBalancesCents: number[];
}

/**
 * Compound growth of a starting balance plus monthly contributions.
 *
 * Monthly compounding, contributions at period end — the conventional
 * assumption, and stated here so the number can be checked rather than trusted.
 */
export function projectGrowth(
  principalCents: number,
  monthlyContributionCents: number,
  annualRatePercent: number,
  years: number,
): GrowthResult {
  const months = Math.max(0, Math.round(years * 12));
  const monthlyRate = annualRatePercent / 100 / 12;
  let balance = principalCents;
  const yearlyBalancesCents: number[] = [];

  for (let i = 1; i <= months; i++) {
    balance = balance * (1 + monthlyRate) + monthlyContributionCents;
    if (i % 12 === 0) yearlyBalancesCents.push(Math.round(balance));
  }

  const futureValueCents = Math.round(balance);
  const contributedCents = principalCents + monthlyContributionCents * months;
  return {
    futureValueCents,
    contributedCents,
    growthCents: futureValueCents - contributedCents,
    yearlyBalancesCents,
  };
}

/** Standard amortised payment for a loan. */
export function loanPayment(principalCents: number, annualRatePercent: number, months: number): number {
  if (months <= 0) return principalCents;
  const r = annualRatePercent / 100 / 12;
  if (r === 0) return Math.round(principalCents / months);
  return Math.round((principalCents * r) / (1 - Math.pow(1 + r, -months)));
}

export interface PayoffResult {
  months: number;
  totalInterestCents: number;
  totalPaidCents: number;
  /** True when the payment does not cover monthly interest. */
  neverClears: boolean;
}

/** How long a fixed monthly payment takes to clear a balance, and its interest cost. */
export function payoffTime(
  balanceCents: number,
  annualRatePercent: number,
  monthlyPaymentCents: number,
): PayoffResult {
  const r = annualRatePercent / 100 / 12;
  const firstMonthInterest = balanceCents * r;
  if (monthlyPaymentCents <= firstMonthInterest) {
    return { months: Infinity, totalInterestCents: 0, totalPaidCents: 0, neverClears: true };
  }

  let balance = balanceCents;
  let interest = 0;
  let paid = 0;
  let months = 0;

  while (balance > 0 && months < 1200) {
    const accrued = balance * r;
    balance += accrued;
    interest += accrued;
    const payment = Math.min(monthlyPaymentCents, balance);
    balance -= payment;
    paid += payment;
    months++;
  }

  return {
    months,
    totalInterestCents: Math.round(interest),
    totalPaidCents: Math.round(paid),
    neverClears: false,
  };
}

export interface SavingsTimeline {
  months: number;
  neverReaches: boolean;
  finalBalanceCents: number;
}

/** How long to reach a target, saving a fixed amount monthly at an optional yield. */
export function timeToTarget(
  targetCents: number,
  monthlyCents: number,
  startingCents = 0,
  annualRatePercent = 0,
): SavingsTimeline {
  if (startingCents >= targetCents) {
    return { months: 0, neverReaches: false, finalBalanceCents: startingCents };
  }
  if (monthlyCents <= 0 && annualRatePercent <= 0) {
    return { months: Infinity, neverReaches: true, finalBalanceCents: startingCents };
  }

  const r = annualRatePercent / 100 / 12;
  let balance = startingCents;
  let months = 0;
  while (balance < targetCents && months < 1200) {
    balance = balance * (1 + r) + monthlyCents;
    months++;
  }
  return {
    months: balance >= targetCents ? months : Infinity,
    neverReaches: balance < targetCents,
    finalBalanceCents: Math.round(balance),
  };
}

export interface AffordabilityResult {
  /** Conventional maximum monthly housing payment (~28% of gross). */
  maxMonthlyHousingCents: number;
  /** Conventional maximum total debt payments (~36% of gross). */
  maxMonthlyAllDebtCents: number;
  /** Rough purchase price the housing payment supports, given rate and term. */
  estimatedMaxLoanCents: number;
  /** The renter's rule of thumb (~30% of gross). */
  maxRentCents: number;
  assumptions: string[];
}

/**
 * The 28/36 rule, stated with its assumptions.
 *
 * These are lender conventions rather than laws, and they say nothing about
 * whether a payment is comfortable — so the assumptions are returned alongside
 * the numbers rather than buried.
 */
export function affordability(
  grossAnnualIncomeCents: number,
  existingMonthlyDebtCents: number,
  mortgageRatePercent = 6.5,
  termYears = 30,
): AffordabilityResult {
  const grossMonthly = grossAnnualIncomeCents / 12;
  const maxMonthlyHousingCents = Math.round(grossMonthly * 0.28);
  const maxMonthlyAllDebtCents = Math.round(grossMonthly * 0.36);
  const availableForHousing = Math.max(
    0,
    Math.min(maxMonthlyHousingCents, maxMonthlyAllDebtCents - existingMonthlyDebtCents),
  );

  // Back out the loan a payment supports: the inverse of the amortisation formula.
  const r = mortgageRatePercent / 100 / 12;
  const n = termYears * 12;
  const estimatedMaxLoanCents =
    r === 0
      ? Math.round(availableForHousing * n)
      : Math.round((availableForHousing * (1 - Math.pow(1 + r, -n))) / r);

  return {
    maxMonthlyHousingCents,
    maxMonthlyAllDebtCents,
    estimatedMaxLoanCents,
    maxRentCents: Math.round(grossMonthly * 0.3),
    assumptions: [
      '28/36 rule: housing ≤28% of gross monthly income, all debt payments ≤36%',
      `Mortgage assumed at ${mortgageRatePercent}% over ${termYears} years`,
      'The loan figure excludes property tax, insurance, HOA and maintenance, which are often 20–30% on top of principal and interest',
      'Lender maximums describe what you can borrow, not what is comfortable to repay',
    ],
  };
}

/** What a sum today is worth in purchasing power after inflation. */
export function inflationAdjust(amountCents: number, annualInflationPercent: number, years: number): number {
  return Math.round(amountCents / Math.pow(1 + annualInflationPercent / 100, years));
}

/** The 4% rule: the portfolio a target annual withdrawal implies, and the reverse. */
export function retirementTarget(annualSpendCents: number, withdrawalRatePercent = 4): number {
  if (withdrawalRatePercent <= 0) return 0;
  return Math.round(annualSpendCents / (withdrawalRatePercent / 100));
}

// ---------------------------------------------------------------------------
// Parsing figures out of a question
// ---------------------------------------------------------------------------

export interface ParsedFigure {
  cents: number;
  /** True when the text marked it as a yearly figure ("$80k a year"). */
  annual: boolean;
  raw: string;
}

/**
 * Pulls money amounts out of natural language so the offline path can answer a
 * hypothetical too. Handles "$80k", "80,000 dollars", "$1.2m", "500 a month".
 */
export function parseFigures(text: string): ParsedFigure[] {
  const out: ParsedFigure[] = [];
  const pattern = /\$?\s?([\d,]+(?:\.\d+)?)\s*(k|m|thousand|million)?\b/gi;

  for (const match of text.matchAll(pattern)) {
    const [raw, digits, scaleWord] = match;
    const base = Number((digits ?? '').replace(/,/g, ''));
    if (!Number.isFinite(base) || base === 0) continue;

    // Bare small integers are usually durations or percentages, not money.
    const looksLikeMoney = raw.includes('$') || base >= 100 || Boolean(scaleWord);
    if (!looksLikeMoney) continue;

    const scale =
      scaleWord?.toLowerCase().startsWith('k') || scaleWord?.toLowerCase() === 'thousand'
        ? 1_000
        : scaleWord?.toLowerCase().startsWith('m') || scaleWord?.toLowerCase() === 'million'
          ? 1_000_000
          : 1;

    const after = text.slice((match.index ?? 0) + raw.length, (match.index ?? 0) + raw.length + 24).toLowerCase();
    const annual = /\b(a|per|each)\s*(year|yr|annum)|\bannual|\byearly|\bsalary/.test(after);

    out.push({ cents: Math.round(base * scale * 100), annual, raw: raw.trim() });
  }
  return out;
}

/** Percentages in a question ("at 7%", "6.5 percent"), for rates of return or APR. */
export function parseRates(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(/([\d.]+)\s*(?:%|percent)/gi)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) out.push(value);
  }
  return out;
}

/** Durations in a question ("in 10 years", "over 30 months"). */
export function parseYears(text: string): number | null {
  const years = text.match(/([\d.]+)\s*(?:years?|yrs?)\b/i);
  if (years) return Number(years[1]);
  const months = text.match(/([\d.]+)\s*(?:months?|mos?)\b/i);
  if (months) return Number(months[1]) / 12;
  return null;
}

/**
 * Whether a question is asking about a scenario rather than the user's data.
 *
 * Matters because the two need different handling: a hypothetical must be
 * answered from the figures in the question, and the answer has to say plainly
 * which numbers are supposed and which are real.
 */
export function isHypothetical(text: string): boolean {
  return /\b(what if|if i (were|was|had|made|earned|got|won|saved|invested|could)|suppose|supposing|hypothetical(ly)?|let'?s say|say i|imagine|assuming|pretend|in theory|theoretically|would i be able|could i afford|how much (house|home|car|rent) can i)\b/i.test(
    text,
  );
}
