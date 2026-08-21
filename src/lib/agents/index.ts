import type Anthropic from '@anthropic-ai/sdk';
import type { AppState, ISODate } from '../../types';
import { redactSensitive } from '../advisor';
import { formatMoney, formatPercent } from '../money';
import { formatMonths } from '../debt';
import {
  affordability,
  isHypothetical,
  parseFigures,
  parseRates,
  parseYears,
  payoffTime,
  projectGrowth,
  retirementTarget,
  timeToTarget,
} from './calculators';
import { buildFacts, type AdvisorFacts } from './facts';
import { screenQuestion } from './guardrails';
import { route } from './router';
import { containsAny } from './matching';
import { AGENTS, type Agent } from './roster';
import { askClaude, isConfigured, type AgentReply, type ClaudeConfig, type ToolCallRecord } from './claude';

export * from './roster';
export * from './facts';
export * from './router';
export * from './guardrails';
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
  onToolCall?: (call: ToolCallRecord) => void;
  signal?: AbortSignal;
}

/**
 * The advisor entry point.
 *
 * Routes to a specialist, then answers through the model when one is
 * configured and locally when it is not. The local path is not a stub — it is
 * the same specialist working from the same facts, which is why the app is
 * useful with no API key at all and why a network failure degrades rather than
 * breaks.
 */
export async function ask(params: AskParams): Promise<AgentReply> {
  const { question, state, reference, config, history = [], onToolCall, signal } = params;
  const clean = redactSensitive(question);
  const facts = buildFacts(state, reference);
  const routed = route(clean);

  if (isConfigured(config)) {
    return askClaude(clean, {
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
      onToolCall,
      signal,
    });
  }

  return { text: answerLocally(clean, facts, state, routed.agent), agent: routed.agent, toolCalls: [] };
}

/** Synchronous local answer, for callers that cannot await (tests, previews). */
export function askLocally(question: string, state: AppState, reference: ISODate): AgentReply {
  const clean = redactSensitive(question);
  const facts = buildFacts(state, reference);
  const routed = route(clean);
  return { text: answerLocally(clean, facts, state, routed.agent), agent: routed.agent, toolCalls: [] };
}

function answerLocally(question: string, facts: AdvisorFacts, state: AppState, agent: Agent): string {
  const blocked = screenQuestion(question);
  if (blocked) return blocked.text;

  if (isHypothetical(question)) {
    const scenario = answerHypothetically(question, facts);
    if (scenario) return scenario;
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
    const target = largest.cents;
    const monthly = figures.length > 1 ? smallest.cents : Math.max(0, facts.cashflow.remainingBalanceCents);
    const rate = rates[0] ?? 0;
    const result = timeToTarget(target, monthly, 0, rate);

    if (result.neverReaches) {
      return `At ${m(monthly)} a month you would not reach ${m(target)} — the monthly amount is zero or negative. Tell me an amount you could set aside and I will give you the date.`;
    }
    return [
      `Saving **${m(monthly)} a month**${rate > 0 ? ` at ${rate}%` : ''}, you would reach **${m(target)}** in **${formatMonths(result.months)}**.`,
      '',
      monthly === Math.max(0, facts.cashflow.remainingBalanceCents)
        ? `That uses your actual projected leftover of ${m(monthly)}/mo. If you can push it higher, the timeline moves fast: at ${m(Math.round(monthly * 1.5))}/mo it becomes ${formatMonths(timeToTarget(target, Math.round(monthly * 1.5), 0, rate).months)}.`
        : `For contrast, your current projected leftover is ${m(Math.max(0, facts.cashflow.remainingBalanceCents))}/mo.`,
    ].join('\n');
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
