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
  /**
   * Where the match started.
   *
   * Load-bearing: two figures in one sentence are often written identically
   * ("make 2k a month, spend 2k a month"), and looking the raw text up with
   * `indexOf` returned the first position for both — so the second figure
   * inherited the first one's context and both were read as income.
   */
  index: number;
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

    out.push({
      cents: Math.round(base * scale * 100),
      annual,
      raw: raw.trim(),
      index: match.index ?? 0,
    });
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
  return SCENARIO_CUES.some((cue) => cue.test(text));
}

/**
 * Scenario framings.
 *
 * Split into named patterns because the original single regex listed verbs in
 * the past tense only — "if i made" was covered and "if i make" was not, so
 * "if i make 5k a month, how long to save 10k?" was never recognised as a
 * scenario at all and fell through to a canned summary of the user's *stored*
 * data. Present tense is how people actually phrase a standing situation.
 */
const SCENARIO_CUES: RegExp[] = [
  /\bwhat if\b/i,
  /\bif i\s+(?:were|was|had|have|make|makes|made|earn|earned|get|got|win|won|save|saved|spend|spent|invest|invested|put|could|can|only)\b/i,
  /\bif my\b/i,
  /\b(?:suppose|supposing|assuming|imagine|pretend|hypothetical|hypothetically|in theory|theoretically)\b/i,
  /\b(?:let'?s say|say i|say my)\b/i,
  /\bwould i be able\b/i,
  /\bcould i (?:afford|save|pay|buy|retire)\b/i,
  /\bhow much (?:house|home|car|rent) can i\b/i,
  // "how long would it take me to save 10k" is a scenario even with no "if".
  /\bhow long (?:would|will|does|do|is it going to)\b/i,
  /\bhow (?:long|many months|many years)\b.{0,40}\b(?:take|reach|save|pay off|clear)\b/i,

  // Prospective intent. The cues above all describe a *supposition* ("what if",
  // "suppose"), and people far more often describe a plan: "I want to take out
  // a 5k loan at 5%, what would I pay back?" is a scenario question in every
  // sense that matters, and reading it as a question about stored data is how
  // it came back as a summary of debts the user never asked about.
  /\b(?:i|we)\s*(?:'m|’m| am| are|'re|’re)?\s*(?:want|wanna|plan|planning|think|thinking|consider|considering|looking|hoping|need|needed|about|going|gonna)\b.{0,24}\b(?:to|about|at|into)\b/i,
  /\b(?:take|taking|took|get|getting|got)\s+(?:out\s+)?an?\b.{0,24}\b(?:loan|mortgage|finance|credit|advance|overdraft)\b/i,
  /\b(?:borrow|borrowing|borrowed|refinance|refinancing|finance|financing)\b/i,
  /\bif i (?:take|took|borrow|borrowed|buy|bought|sign|signed|open|opened)\b/i,

  // "how much would I be paying back in total?" — a computation on figures the
  // question itself supplies, with no "if" anywhere in it.
  /\bhow much\b.{0,40}\b(?:would|will|do|does|should)\b.{0,30}\b(?:pay|paying|repay|owe|cost|costs|end up|be)\b/i,
  /\b(?:what|how much)\b.{0,30}\b(?:total|in total|altogether|all in)\b/i,
  /\bwhat would (?:the|my|that|a|an)\b.{0,30}\b(?:payment|repayment|cost|interest|total|monthly)\b/i,
];

// ---------------------------------------------------------------------------
// Figure roles
// ---------------------------------------------------------------------------

export type FigureRole = 'income' | 'expenses' | 'target' | 'contribution' | 'balance' | 'payment' | 'unknown';

export type Cadence = 'monthly' | 'annual' | 'once';

export interface LabelledFigure extends ParsedFigure {
  role: FigureRole;
  cadence: Cadence;
}

const ROLE_CUES: { role: Exclude<FigureRole, 'unknown' | 'target' | 'contribution'>; pattern: RegExp }[] = [
  {
    role: 'income',
    pattern: /\b(make|makes|making|earn|earns|earning|salary|income|wage|paid|pay ?check|take[- ]home|bring in|gross|net pay)\b/i,
  },
  {
    role: 'expenses',
    pattern: /\b(expense|expenses|spend|spends|spending|bills?|costs?|outgoings?|overheads?|rent|totalling|totaling|budget)\b/i,
  },
  { role: 'balance', pattern: /\b(balance|owe|owing|debt|card|loan|mortgage|principal)\b/i },
  { role: 'payment', pattern: /\b(pay|paying|payment|repay|put toward|towards|contribute)\b/i },
];

const SAVE_CUE = /\b(save|saves|saving|savings|set aside|put away|stash|target|goal|reach|accumulate|need|want)\b/i;

/**
 * Assigns each figure a role from the words around it.
 *
 * Position, not magnitude. The previous code guessed by size — smallest figure
 * is the monthly amount, largest is the target — which happens to be right for
 * "save 10k at 500 a month" and badly wrong for "make 5k, spend 1.5k, save
 * 10k", where the smallest number is the user's *expenses*. Guessing produced
 * confident, wrong arithmetic; reading the sentence does not.
 */
export function classifyFigures(text: string): LabelledFigure[] {
  const figures = parseFigures(text);
  if (figures.length === 0) return [];

  return figures.map((figure, position) => {
    const index = figure.index;
    const previous = position > 0 ? figures[position - 1] : undefined;
    // Start after the previous figure so a verb cannot be claimed twice.
    const windowStart = previous ? previous.index + previous.raw.length : Math.max(0, index - 46);
    const before = text.slice(Math.max(windowStart, index - 46), index);

    // Stop at the next figure, so "$60,000 a year and spend 2k a month" does not
    // read the *following* clause's cadence back onto the salary.
    const next = figures[position + 1];
    const afterEnd = Math.min(
      next ? next.index : text.length,
      index + figure.raw.length + 30,
    );
    const after = text.slice(index + figure.raw.length, Math.max(index + figure.raw.length, afterEnd));

    const cadence: Cadence = /\b(a|per|each|every)\s*(month|mo|week|fortnight)\b|\bmonthly\b|\/\s*mo\b/i.test(after)
      ? 'monthly'
      : figure.annual || /\b(a|per|each)\s*(year|yr)\b|\bannually\b|\byearly\b/i.test(after)
        ? 'annual'
        : 'once';

    // The nearest preceding cue wins, so each figure takes the verb that
    // governs it rather than any cue anywhere in the sentence.
    let role: FigureRole = 'unknown';
    let bestPosition = -1;
    for (const { role: candidate, pattern } of ROLE_CUES) {
      const match = before.match(new RegExp(`(?:.*)(${pattern.source})`, 'i'));
      if (match && match.index !== undefined) {
        const position = before.lastIndexOf(match[1] ?? '');
        if (position > bestPosition) {
          bestPosition = position;
          role = candidate;
        }
      }
    }

    // A saving cue outranks the others, and its cadence decides which kind:
    // "save $500 a month" is a contribution, "save $10k" is a target.
    const savePosition = (() => {
      const match = before.match(new RegExp(`(?:.*)(${SAVE_CUE.source})`, 'i'));
      return match?.[1] ? before.lastIndexOf(match[1]) : -1;
    })();
    if (savePosition > bestPosition) {
      role = cadence === 'monthly' ? 'contribution' : 'target';
    }

    return { ...figure, role, cadence };
  });
}

/**
 * What the advisor has been told about a scenario's inputs.
 *
 * `null` means "not established yet", which is different from false — the
 * advisor asks about an unknown and stops asking once it is answered.
 */
export interface ScenarioAssumptions {
  incomeIsGross: boolean | null;
  expensesIncludeIrregular: boolean | null;
}

export interface SavingsScenario {
  targetCents: number | null;
  monthlyIncomeCents: number | null;
  monthlyExpensesCents: number | null;
  /** What is actually available to save each month. */
  monthlyContributionCents: number | null;
  /** True when the contribution came from income − expenses rather than being stated. */
  derivedFromSurplus: boolean;
  assumptions: ScenarioAssumptions;
}

/**
 * Reads assumption answers out of a reply.
 *
 * The advisor asks "is that gross or take-home?" and "does that include
 * irregular costs?", so it has to understand the answers. The irregular-cost
 * pattern is deliberately typo-tolerant — this is a chat box, and "ireegular"
 * should not silently fail to register.
 */
export function detectAssumptions(text: string): Partial<ScenarioAssumptions> {
  const found: Partial<ScenarioAssumptions> = {};
  const lower = text.toLowerCase();

  if (/\b(gross|before tax|pre[- ]?tax|pretax|before deductions)\b/i.test(lower)) {
    found.incomeIsGross = true;
  } else if (/\b(net|take[- ]?home|after tax|post[- ]?tax|in my pocket|what i actually get)\b/i.test(lower)) {
    found.incomeIsGross = false;
  }

  const IRREGULAR = /\b(ir+e*g+ular|annual|yearly|one[- ]?off|unexpected|occasional|sinking)\b/i;
  if (IRREGULAR.test(lower)) {
    const negated =
      /\b(does ?n'?o?t include|do ?n'?o?t include|not include|excludes?|excluding|without|not counting|leaves out|missing)\b/i.test(
        lower,
      );
    const affirmed = /\b(includes?|including|covers?|accounts for|has|with)\b/i.test(lower);
    if (negated) found.expensesIncludeIrregular = false;
    else if (affirmed) found.expensesIncludeIrregular = true;
  }

  return found;
}

/** True when a reply is answering the advisor's assumption questions. */
export function isAssumptionAnswer(text: string): boolean {
  return Object.keys(detectAssumptions(text)).length > 0;
}

/**
 * Take-home from gross, as a range.
 *
 * A single number would be a fabrication: withholding depends on filing status,
 * state, and pre-tax deductions the app has never seen. FICA alone is 7.65%,
 * federal effective tax at this income is commonly 10–13% after the standard
 * deduction, and state ranges from nothing to about 7% — so 20–28% total is a
 * defensible band. It is labelled an estimate everywhere it is shown, because
 * the exact figure is on the user's payslip and nowhere else.
 */
export const WITHHOLDING_LOW = 0.2;
export const WITHHOLDING_HIGH = 0.28;

export function estimateNetRange(grossCents: number): { lowCents: number; highCents: number } {
  return {
    lowCents: Math.round(grossCents * (1 - WITHHOLDING_HIGH)),
    highCents: Math.round(grossCents * (1 - WITHHOLDING_LOW)),
  };
}

/** Uplift applied to a stated expense figure that excludes irregular costs. */
export const IRREGULAR_UPLIFT = 0.15;

/** Reads "make 5k a month, spend 1.5k, save 10k" into something answerable. */
export function readSavingsScenario(text: string): SavingsScenario {
  const figures = classifyFigures(text);
  const monthly = (figure: LabelledFigure | undefined) =>
    figure ? (figure.cadence === 'annual' ? Math.round(figure.cents / 12) : figure.cents) : null;

  const income = monthly(figures.find((f) => f.role === 'income'));
  const expenses = monthly(figures.find((f) => f.role === 'expenses'));
  const stated = monthly(figures.find((f) => f.role === 'contribution'));
  const target =
    figures.find((f) => f.role === 'target')?.cents ??
    // An unlabelled one-off figure in a savings question is the target.
    figures.find((f) => f.role === 'unknown' && f.cadence === 'once')?.cents ??
    null;

  const surplus = income !== null && expenses !== null ? income - expenses : null;

  return {
    targetCents: target,
    monthlyIncomeCents: income,
    monthlyExpensesCents: expenses,
    monthlyContributionCents: stated ?? surplus,
    derivedFromSurplus: stated === null && surplus !== null,
    assumptions: {
      incomeIsGross: null,
      expensesIncludeIrregular: null,
      ...detectAssumptions(text),
    },
  };
}

/**
 * Folds a later turn's figures into a running scenario.
 *
 * A correction often carries a number as well as an assumption — "my take-home
 * is 3900" both answers the gross/net question and supplies the real figure.
 * Merging only the assumption left the old $5,000 in place and quietly produced
 * a date computed from a number the user had just replaced.
 */
export function mergeScenario(previous: SavingsScenario, text: string): SavingsScenario {
  const incoming = readSavingsScenario(text);
  const assumptions = { ...previous.assumptions, ...detectAssumptions(text) };

  const monthlyIncomeCents = incoming.monthlyIncomeCents ?? previous.monthlyIncomeCents;
  const monthlyExpensesCents = incoming.monthlyExpensesCents ?? previous.monthlyExpensesCents;
  const targetCents = incoming.targetCents ?? previous.targetCents;

  // A freshly stated income or expense figure supersedes the derived surplus.
  const restated = incoming.monthlyIncomeCents !== null || incoming.monthlyExpensesCents !== null;
  const surplus =
    monthlyIncomeCents !== null && monthlyExpensesCents !== null
      ? monthlyIncomeCents - monthlyExpensesCents
      : null;

  return {
    targetCents,
    monthlyIncomeCents,
    monthlyExpensesCents,
    monthlyContributionCents: restated
      ? (surplus ?? previous.monthlyContributionCents)
      : (previous.monthlyContributionCents ?? surplus),
    derivedFromSurplus: surplus !== null,
    assumptions,
  };
}

/** True when a scenario has enough to compute a timeline. */
export function isUsableScenario(scenario: SavingsScenario): boolean {
  return scenario.targetCents !== null && scenario.monthlyContributionCents !== null;
}
