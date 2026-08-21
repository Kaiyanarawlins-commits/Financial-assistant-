import type Anthropic from '@anthropic-ai/sdk';
import type { AppState, ISODate } from '../../types';
import { redactSensitive } from '../advisor';
import { formatMoney, formatPercent } from '../money';
import { formatMonths } from '../debt';
import {
  affordability,
  isHypothetical,
  classifyFigures,
  parseFigures,
  parseRates,
  parseYears,
  payoffTime,
  projectGrowth,
  readSavingsScenario,
  retirementTarget,
  timeToTarget,
} from './calculators';
import { buildFacts, simulateMonthlyChange, type AdvisorFacts } from './facts';
import {
  emptyMemory,
  formatMemory,
  rememberAnswer,
  rememberQuestion,
  resolveReferences,
  type ConversationMemory,
  type Entity,
} from './conversation';
import { screenQuestion } from './guardrails';
import { route } from './router';
import { containsAny } from './matching';
import { AGENTS, type Agent } from './roster';
import { askClaude, isConfigured, type AgentReply, type ClaudeConfig, type ToolCallRecord } from './claude';

export * from './roster';
export * from './facts';
export * from './router';
export * from './guardrails';
export * from './conversation';
export * from './glossary';
export { isConfigured, describeError } from './claude';
export type { AgentReply, ClaudeConfig, ModelId, ToolCallRecord } from './claude';

const m = (cents: number) => formatMoney(cents);
const p = (value: number, digits = 1) => formatPercent(value, digits);

export interface AskParams {
  question: string;
  state: AppState;
  reference: ISODate;
  config?: Partial<ClaudeConfig>;
  history?: Anthropic.Beta.BetaMessageParam[];
  /** Carried between turns so follow-ups resolve. Omit for a fresh thread. */
  memory?: ConversationMemory;
  onToolCall?: (call: ToolCallRecord) => void;
  /** Text chunks as they stream in, for progressive rendering. */
  onText?: (chunk: string) => void;
  /** Progress notes, e.g. when an answer is being re-checked. */
  onStatus?: (status: string) => void;
  signal?: AbortSignal;
}

/** A reply plus the conversation state the caller should carry into the next turn. */
export type AskResult = AgentReply & { memory: ConversationMemory };

/**
 * The advisor entry point.
 *
 * Routes to a specialist, then answers through the model when one is
 * configured and locally when it is not. The local path is not a stub — it is
 * the same specialist working from the same facts, which is why the app is
 * useful with no API key at all and why a network failure degrades rather than
 * breaks.
 */
export async function ask(params: AskParams): Promise<AskResult> {
  const {
    question,
    state,
    reference,
    config,
    history = [],
    memory = emptyMemory(),
    onToolCall,
    onText,
    onStatus,
    signal,
  } = params;

  const clean = redactSensitive(question);
  const facts = buildFacts(state, reference);

  // Expand "why?" / "what about the Visa?" against what has been said, then
  // route the expanded form so a follow-up keeps its specialist.
  const resolution = resolveReferences(clean, memory, state);
  const routed = route(resolution.question, memory.lastAgent, resolution.isFollowUp);
  const afterQuestion = rememberQuestion(memory, clean, state);

  const reply = isConfigured(config)
    ? await askClaude(resolution.question, {
        agent: routed.agent,
        facts,
        state,
        reference,
        config: {
          apiKey: config?.apiKey,
          proxyUrl: config?.proxyUrl,
          model: config?.model ?? 'claude-fable-5',
          effort: config?.effort ?? 'medium',
        },
        history,
        hypothetical: routed.hypothetical,
        conversationState: formatMemory(afterQuestion),
        onToolCall,
        onText,
        onStatus,
        signal,
      })
    : {
        text: answerLocally(
          clean,
          facts,
          state,
          routed.agent,
          afterQuestion,
          resolution.subject,
          resolution.isFollowUp,
        ),
        agent: routed.agent,
        toolCalls: [],
      };

  return {
    ...reply,
    memory: rememberAnswer(afterQuestion, reply.text, routed.agent.id, state, facts),
  };
}

/** Synchronous local answer, for callers that cannot await (tests, previews). */
export function askLocally(
  question: string,
  state: AppState,
  reference: ISODate,
  memory: ConversationMemory = emptyMemory(),
): AskResult {
  const clean = redactSensitive(question);
  const facts = buildFacts(state, reference);
  const resolution = resolveReferences(clean, memory, state);
  const routed = route(resolution.question, memory.lastAgent, resolution.isFollowUp);
  const afterQuestion = rememberQuestion(memory, clean, state);

  const text = answerLocally(
    clean,
    facts,
    state,
    routed.agent,
    afterQuestion,
    resolution.subject,
    resolution.isFollowUp,
  );
  return {
    text,
    agent: routed.agent,
    toolCalls: [],
    memory: rememberAnswer(afterQuestion, text, routed.agent.id, state, facts),
  };
}

function answerLocally(
  question: string,
  facts: AdvisorFacts,
  state: AppState,
  agent: Agent,
  memory: ConversationMemory,
  subject: Entity | null,
  isFollowUp: boolean,
): string {
  const blocked = screenQuestion(question);
  if (blocked) return blocked.text;

  if (isHypothetical(question)) {
    const scenario = answerHypothetically(question, facts);
    if (scenario) return scenario;

    // The question is a scenario carrying the user's own figures, and nothing
    // here could price it. Falling through to the specialist would answer with
    // the *stored* data instead — which is how "if I make 5k and spend 1.5k"
    // came back quoting a $6,800 income the user never mentioned. Saying what
    // was understood is worth far more than a confident answer to a different
    // question.
    if (parseFigures(question).length > 0) {
      return unpricedScenario(question);
    }
  }

  // A follow-up gets a follow-up answer. Re-running the specialist's opening
  // summary in response to "why?" is exactly what makes an assistant feel like
  // it is not listening.
  if (isFollowUp) {
    const followUp = answerFollowUp(question, facts, state, memory, subject);
    if (followUp) return followUp;
  }

  return agent.localAnswer(facts, state, question);
}

// ---------------------------------------------------------------------------
// Local hypothetical handling
// ---------------------------------------------------------------------------

/**
 * Answers a scenario question without a model.
 *
 * Pattern-matches the shape of the question, pulls the figures out of it, and
 * runs the real calculators. Narrower than the model path, but it covers the
 * scenarios people actually ask about and it keeps the promise that a
 * hypothetical is never met with "I can only see your logged data".
 *
 * Returns null when the question is a hypothetical it cannot price, so the
 * specialist's normal answer takes over.
 */
function answerHypothetically(question: string, facts: AdvisorFacts): string | null {
  const q = question.toLowerCase();
  const figures = parseFigures(question);
  const rates = parseRates(question);
  const years = parseYears(question);

  if (figures.length === 0) return null;

  const annual = figures.find((f) => f.annual);
  const largest = [...figures].sort((a, b) => b.cents - a.cents)[0]!;
  const smallest = [...figures].sort((a, b) => a.cents - b.cents)[0]!;

  // --- Housing affordability -------------------------------------------------
  if (containsAny(q, ['house', 'home', 'mortgage', 'afford', 'rent', 'apartment', 'property', 'down payment'])) {
    const grossAnnual = annual?.cents ?? (largest.cents > 3_000_000 ? largest.cents : largest.cents * 12);
    const rate = rates[0] ?? 6.5;
    const existingDebt = facts.debt.minimumsCents;
    const result = affordability(grossAnnual, existingDebt, rate, years ?? 30);

    return [
      `**At ${m(grossAnnual)} a year** — using your real ${m(existingDebt)}/mo of existing debt payments:`,
      '',
      `- Maximum monthly housing payment: **${m(result.maxMonthlyHousingCents)}** (28% of gross)`,
      `- Maximum for all debt payments combined: ${m(result.maxMonthlyAllDebtCents)} (36% of gross)`,
      `- That supports a mortgage of roughly **${m(result.estimatedMaxLoanCents)}** at ${rate}% over ${years ?? 30} years`,
      `- If you were renting instead: about ${m(result.maxRentCents)}/mo (the 30% rule)`,
      '',
      '**Assumptions, so you can check them:**',
      ...result.assumptions.map((a) => `- ${a}`),
      '',
      `The loan figure is principal and interest only. Property tax, insurance, HOA and maintenance commonly add 20–30% on top, so treat ${m(result.estimatedMaxLoanCents)} as the ceiling a lender would allow rather than a comfortable number.`,
      '',
      facts.cashflow.incomeCents > 0
        ? `For contrast, your current fixed costs run ${m(facts.cashflow.recurringCents)}/mo — ${p(facts.cashflow.fixedShareOfIncomePercent)} of what you actually earn today.`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  // --- Investment growth -----------------------------------------------------
  if (containsAny(q, ['invest', 'grow', 'return', 'compound', 'portfolio', 'retire', '401k', 'ira', 'market', 'stock'])) {
    if (containsAny(q, ['retire', 'retirement']) && annual) {
      const target = retirementTarget(annual.cents, rates[0] ?? 4);
      return [
        `To support **${m(annual.cents)} a year** in retirement at a ${rates[0] ?? 4}% withdrawal rate, you would need a portfolio of about **${m(target)}**.`,
        '',
        `That is the 4% rule, which comes from historical US market data over 30-year retirements. It is a planning heuristic, not a guarantee — it assumes a diversified portfolio and some flexibility to spend less in bad years.`,
        '',
        `Your current essentials run ${m(facts.emergencyFund.monthlyEssentialsCents)}/mo, which is ${m(facts.emergencyFund.monthlyEssentialsCents * 12)}/yr — so a portfolio of about ${m(retirementTarget(facts.emergencyFund.monthlyEssentialsCents * 12, rates[0] ?? 4))} would cover your essential costs as they stand today.`,
      ].join('\n');
    }

    const monthly = figures.length > 1 ? smallest.cents : largest.cents;
    const principal = figures.length > 1 ? largest.cents : 0;
    const rate = rates[0] ?? 7;
    const horizon = years ?? 20;
    const result = projectGrowth(principal, monthly, rate, horizon);

    return [
      `**${principal > 0 ? `${m(principal)} to start plus ` : ''}${m(monthly)} a month at ${rate}% for ${horizon} years:**`,
      '',
      `- Future value: **${m(result.futureValueCents)}**`,
      `- You contribute: ${m(result.contributedCents)}`,
      `- Growth does the rest: **${m(result.growthCents)}**`,
      '',
      `Growth is ${p((result.growthCents / Math.max(1, result.futureValueCents)) * 100, 0)} of the ending balance — that is compounding, and it is why the horizon matters more than the monthly amount.`,
      '',
      `A ${rate}% return is an assumption, not a promise. Markets do not deliver an average every year; they deliver a sequence, and the order matters more than people expect.`,
      '',
      facts.debt.items.some((d) => d.aprPercent >= 10)
        ? `Worth weighing against your actual debt first: you are paying ${p(facts.debt.blendedAprPercent, 2)} blended, ${m(facts.debt.monthlyInterestCents)}/mo in interest. Clearing high-rate debt is a guaranteed return at that rate, which no market projection can promise.`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  // --- Savings timeline ------------------------------------------------------
  if (
    (containsAny(q, ['save', 'saving', 'reach', 'target', 'goal', 'set aside']) || /how long/i.test(q)) &&
    figures.length >= 1
  ) {
    // Read the roles out of the sentence rather than guessing from magnitudes.
    const scenario = readSavingsScenario(question);
    const target = scenario.targetCents ?? largest.cents;
    const monthly =
      scenario.monthlyContributionCents ?? Math.max(0, facts.cashflow.remainingBalanceCents);
    const rate = rates[0] ?? 0;

    if (monthly <= 0) {
      return [
        scenario.monthlyIncomeCents !== null && scenario.monthlyExpensesCents !== null
          ? `On ${m(scenario.monthlyIncomeCents)} a month against ${m(scenario.monthlyExpensesCents)} of expenses there is nothing left over, so **${m(target)} is not reachable** without changing one of those two figures.`
          : `At ${m(monthly)} a month you would never reach ${m(target)}. Tell me what you could set aside and I will give you the date.`,
      ].join('\n');
    }

    const result = timeToTarget(target, monthly, 0, rate);
    const lines: string[] = [];

    if (scenario.derivedFromSurplus && scenario.monthlyIncomeCents !== null) {
      lines.push(
        `**About ${formatMonths(result.months)}.**`,
        '',
        `${m(scenario.monthlyIncomeCents)} in, ${m(scenario.monthlyExpensesCents ?? 0)} out leaves **${m(monthly)} a month**. ${m(target)} ÷ ${m(monthly)} = ${(target / monthly).toFixed(2)} months.`,
      );
    } else {
      lines.push(
        `Saving **${m(monthly)} a month**${rate > 0 ? ` at ${rate}%` : ''}, you would reach **${m(target)}** in **${formatMonths(result.months)}**.`,
      );
    }

    // The month-by-month table, so the date can be checked rather than trusted.
    lines.push('');
    for (let month = 1; month <= Math.min(result.months, 6); month++) {
      lines.push(`- End of month ${month}: ${m(monthly * month)}`);
    }
    if (result.months > 6) lines.push(`- …reaching ${m(target)} in month ${result.months}`);

    if (scenario.derivedFromSurplus) {
      lines.push('');
      lines.push(
        `Two things would move that date. **Is the ${m(scenario.monthlyIncomeCents ?? 0)} take-home or gross?** If it is gross, tax comes out first and the surplus is meaningfully smaller. And **does the ${m(scenario.monthlyExpensesCents ?? 0)} include the irregular costs** — annual insurance, car maintenance, gifts? Those are the ones people leave out, and they usually add 10–20%.`,
      );
    }

    if (rate === 0 && target >= 500_000) {
      lines.push('');
      lines.push(
        `Interest is a rounding error at this horizon — ${m(target)} in a 4% account earns roughly ${m(Math.round((target * 0.04 * result.months) / 12))} over ${formatMonths(result.months)}, which does not change the answer.`,
      );
    }

    return lines.join('\n');
  }

  // --- Debt payoff at a hypothetical payment --------------------------------
  if (
    containsAny(q, ['pay', 'paid', 'payoff', 'pay off', 'clear', 'owe', 'debt', 'card', 'loan', 'balance']) &&
    figures.length >= 1
  ) {
    const balance = largest.cents;
    const payment = figures.length > 1 ? smallest.cents : 0;
    const apr = rates[0] ?? facts.debt.blendedAprPercent ?? 20;
    if (payment > 0) {
      const result = payoffTime(balance, apr, payment);
      if (result.neverClears) {
        return `At ${m(payment)} a month against ${m(balance)} at ${p(apr, 2)}, **the balance never clears** — the payment does not cover the monthly interest of about ${m(Math.round((balance * (apr / 100)) / 12))}. You would need to pay more than that just to stand still.`;
      }
      return [
        `Paying **${m(payment)} a month** against **${m(balance)}** at ${p(apr, 2)}:`,
        '',
        `- Cleared in **${formatMonths(result.months)}**`,
        `- Total interest: **${m(result.totalInterestCents)}**`,
        `- Total paid: ${m(result.totalPaidCents)}`,
        '',
        `Adding just ${m(5_000)}/mo would change that to ${formatMonths(payoffTime(balance, apr, payment + 5_000).months)} and ${m(payoffTime(balance, apr, payment + 5_000).totalInterestCents)} of interest — extra payments hit principal directly, which is why small increases move the date so much.`,
      ].join('\n');
    }
  }

  // --- Income change ---------------------------------------------------------
  if (annual && containsAny(q, ['earn', 'make', 'made', 'salary', 'income', 'raise', 'job', 'pay', 'paid'])) {
    const newMonthly = Math.round(annual.cents / 12);
    const current = facts.cashflow.incomeCents;
    const delta = newMonthly - current;
    const newLeftover = facts.cashflow.remainingBalanceCents + delta;

    return [
      `**At ${m(annual.cents)} a year** that is ${m(newMonthly)} a month gross${current > 0 ? `, against the ${m(current)} you currently record` : ''}.`,
      '',
      current > 0
        ? `Holding your spending flat at ${m(facts.cashflow.spentCents)}, your leftover would go from ${m(facts.cashflow.remainingBalanceCents)} to **${m(newLeftover)}** — a savings rate of ${p((newLeftover / Math.max(1, newMonthly)) * 100)} instead of ${p(facts.cashflow.savingsRatePercent)}.`
        : `Against fixed costs of ${m(facts.cashflow.recurringCents)}/mo, that leaves ${m(newMonthly - facts.cashflow.recurringCents)} before discretionary spending.`,
      '',
      `Two caveats worth stating. That is **gross** — tax, and any pre-tax deductions, come out before it reaches you, so plan on meaningfully less. And lifestyle creep is the reason raises so often fail to change anything: the reliable move is to automate the *difference* into savings on the first payday, before it becomes normal.`,
      '',
      facts.debt.totalCents > 0
        ? `If you sent the extra ${m(Math.max(0, delta))}/mo at your ${m(facts.debt.totalCents)} of debt instead, that alone would be a ${p((Math.max(0, delta) * 12 / Math.max(1, facts.debt.totalCents)) * 100, 0)} annual dent in the balance.`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  return null;
}

export { AGENTS };

/**
 * What to say when a scenario cannot be priced offline.
 *
 * Names the figures it read back, so the user can see whether it understood
 * them, and points at the path that can answer anything.
 */
function unpricedScenario(question: string): string {
  const figures = classifyFigures(question);
  const described = figures
    .map((f) => {
      const cadence = f.cadence === 'monthly' ? '/month' : f.cadence === 'annual' ? '/year' : '';
      const role = f.role === 'unknown' ? '' : ` — read as ${f.role}`;
      return `- ${m(f.cents)}${cadence}${role}`;
    })
    .join('\n');

  return `I can see the figures you gave me, but not what to do with them in this shape:

${described}

I will not answer with your stored data instead — those are not the numbers you asked about.

Tell me what you want worked out and I can price it exactly: how long to reach a savings target, what a loan payment would be, how long a balance takes to clear, what an investment would grow to, or what housing a salary supports. Connecting Claude in **Settings → AI advisor** removes this limit entirely — it can reason about any scenario rather than the handful I calculate offline.`;
}

// ---------------------------------------------------------------------------
// Follow-up answers
// ---------------------------------------------------------------------------

/**
 * Answers a question that only makes sense in context.
 *
 * The offline specialists each open with a full situation summary, which is
 * right for a first question and wrong for "why?" — re-running the summary is
 * how an assistant signals it was not listening. These handlers cover the
 * follow-ups people actually ask; anything else falls through to the specialist.
 */
function answerFollowUp(
  question: string,
  facts: AdvisorFacts,
  state: AppState,
  memory: ConversationMemory,
  subject: Entity | null,
): string | null {
  const q = question.toLowerCase().trim();

  // "why?" / "how come?" — justify the last recommendation.
  if (/^(why|how come)\b/.test(q) || /\bwhy (is|does|would|should) that\b/.test(q)) {
    if (!memory.lastRecommendation) return null;
    return [
      `Because of the arithmetic behind it.`,
      '',
      `The suggestion was: *${memory.lastRecommendation}*`,
      '',
      ...whyLines(facts),
    ].join('\n');
  }

  // "how much would that save?" — price the figure last discussed.
  if (/\b(how much|what).{0,20}\b(save|saving|cost|difference|impact)\b/.test(q)) {
    const delta = memory.lastProposedMonthlyDeltaCents ?? Math.max(0, facts.cashflow.remainingBalanceCents);
    if (delta <= 0) return null;
    const result = simulateMonthlyChange(state, facts, delta, 'that change');
    const lines = [
      `Redirecting **${m(delta)} a month**:`,
      '',
      `- Annually: **${m(result.annualImpactCents)}**`,
      `- Savings rate: ${p(facts.cashflow.savingsRatePercent)} → **${p(result.newSavingsRatePercent)}**`,
    ];
    if (result.debtInterestSavedCents !== null && result.debtInterestSavedCents > 0) {
      lines.push(`- Interest saved on your debt: **${m(result.debtInterestSavedCents)}**`);
    }
    if (result.debtMonthsSaved !== null && result.debtMonthsSaved > 0) {
      lines.push(`- Debt-free **${result.debtMonthsSaved} months** sooner`);
    }
    if (result.goalMonthsSaved !== null && result.goalMonthsSaved > 0) {
      lines.push(`- Your first goal lands ${result.goalMonthsSaved} months earlier`);
    }
    return lines.join('\n');
  }

  // "is that good?" — benchmark the ratios. Checked before the entity branch,
  // because it is a question about a number, not a request for a balance.
  if (/\b(is|does|are)\b.{0,24}\b(good|bad|normal|ok|okay|high|low|healthy|reasonable|typical)\b/.test(q)) {
    return benchmarkLines(facts).join('\n');
  }

  // "what about the Visa?" — the named entity, in the current frame.
  if (subject) {
    const detail = entityDetail(subject, facts);
    if (detail) return detail;
  }

  return null;
}

function whyLines(facts: AdvisorFacts): string[] {
  const lines: string[] = [];
  if (facts.debt.monthlyInterestCents > 0) {
    lines.push(
      `Your debt costs **${m(facts.debt.monthlyInterestCents)} a month in interest** — ${m(facts.debt.monthlyInterestCents * 12)} a year before any balance moves. Every dollar redirected there earns your blended ${p(facts.debt.blendedAprPercent, 2)} with certainty, which no investment offers.`,
    );
  }
  if (facts.debt.overallUtilizationPercent !== null && facts.debt.overallUtilizationPercent > 30) {
    lines.push('');
    lines.push(
      `It also moves your utilization, currently ${p(facts.debt.overallUtilizationPercent)}. That is roughly 30% of a credit score and it resets each statement, so it is the fastest lever you have.`,
    );
  }
  if (facts.emergencyFund.monthsCovered < 3) {
    lines.push('');
    lines.push(
      `And it is the difference between covering a surprise from cash or from a card — you are at ${facts.emergencyFund.monthsCovered.toFixed(1)} months of the ${m(facts.emergencyFund.monthlyEssentialsCents)} you need each month.`,
    );
  }
  if (lines.length === 0) {
    lines.push(
      `It moves the only two numbers that compound: what you keep each month (currently ${p(facts.cashflow.savingsRatePercent)} of income) and what you owe.`,
    );
  }
  return lines;
}

function benchmarkLines(facts: AdvisorFacts): string[] {
  const c = facts.cashflow;
  const lines = ['Against the usual benchmarks:', ''];

  lines.push(
    `- **Savings rate ${p(c.savingsRatePercent)}** — the common target is 20%. ${c.savingsRatePercent >= 20 ? 'You clear it.' : `You are ${p(20 - c.savingsRatePercent)} short.`}`,
  );
  lines.push(
    `- **Fixed costs ${p(c.fixedShareOfIncomePercent)} of income** — 50% is the guideline ceiling for needs. ${c.fixedShareOfIncomePercent > 50 ? 'Above it, so discretionary trimming has limited room.' : 'Inside it.'}`,
  );
  if (facts.debt.totalCents > 0) {
    lines.push(
      `- **Debt-to-income ${p(facts.debt.debtToIncomePercent)}** — lenders use ~36% as the ceiling, ~43% as the limit for a qualified mortgage. ${facts.debt.debtToIncomePercent > 36 ? 'Yours is above the conventional ceiling.' : 'Yours is inside it.'}`,
    );
  }
  if (facts.debt.overallUtilizationPercent !== null) {
    lines.push(
      `- **Utilization ${p(facts.debt.overallUtilizationPercent)}** — under 30% is the usual advice, under 10% is better.`,
    );
  }
  lines.push(
    `- **Emergency cover ${facts.emergencyFund.monthsCovered.toFixed(1)} months** — three to six is the standard range.`,
  );
  return lines;
}

/** The current position on one account, category or goal. */
function entityDetail(subject: Entity, facts: AdvisorFacts): string | null {
  if (subject.kind === 'debt') {
    const debt = facts.debt.items.find((d) => d.id === subject.id);
    if (!debt) return null;
    const lines = [
      `**${debt.name}:** ${m(debt.balanceCents)} at ${p(debt.aprPercent, 2)} APR, costing **${m(debt.monthlyInterestCents)} a month** in interest.`,
    ];
    if (debt.utilizationPercent !== undefined && debt.creditLimitCents) {
      const to30 = Math.max(0, debt.balanceCents - Math.floor(debt.creditLimitCents * 0.3));
      lines.push('');
      lines.push(
        `Utilization is **${p(debt.utilizationPercent)}** of the ${m(debt.creditLimitCents)} limit.${
          to30 > 0 ? ` Paying ${m(to30)} before the statement closes takes it under 30%.` : ' Already under 30%.'
        }`,
      );
    }
    lines.push('');
    lines.push(
      `Minimum payment is ${m(debt.minimumPaymentCents)}, which covers ${
        debt.minimumPaymentCents > debt.monthlyInterestCents
          ? `the interest with ${m(debt.minimumPaymentCents - debt.monthlyInterestCents)} going to principal`
          : '**less than the interest** — the balance grows if you pay only the minimum'
      }.`,
    );
    return lines.join('\n');
  }

  if (subject.kind === 'category') {
    const category = facts.categories.find((c) => c.id === subject.id);
    if (!category) return null;
    const lines = [
      `**${category.name}:** ${m(category.spentCents)} this period — ${p(category.percentOfSpend)} of spend, ${p(category.percentOfIncome)} of income.`,
      '',
      `Against last month: ${category.deltaVsLastMonthCents >= 0 ? '+' : ''}${m(category.deltaVsLastMonthCents)}. Six-month average: ${m(category.sixMonthAverageCents)}.`,
    ];
    if (category.capCents) {
      lines.push('');
      lines.push(
        `You capped this at ${m(category.capCents)} — currently **${p(category.capPercent ?? 0)}** of it.`,
      );
    }
    if (category.risingThreeMonths) {
      lines.push('');
      lines.push('This has risen three months running, so it is a trend rather than one unusual month.');
    }
    return lines.join('\n');
  }

  const goal = facts.goals.find((g) => g.id === subject.id);
  if (!goal) return null;
  return [
    `**${goal.name}:** ${m(goal.savedCents)} of ${m(goal.targetCents)} — ${p(goal.percentFunded)} funded, ${m(goal.remainingCents)} to go.`,
    '',
    goal.monthsToFundAtCurrentRate !== null
      ? `At your current leftover that is about **${goal.monthsToFundAtCurrentRate} ${goal.monthsToFundAtCurrentRate === 1 ? 'month' : 'months'}**.`
      : 'Your projected leftover is zero, so there is no timeline on it yet.',
    goal.reserved ? '\nIt is reserved from safe-to-spend, so the unfunded part is already held back.' : '',
  ]
    .filter(Boolean)
    .join('\n');
}
