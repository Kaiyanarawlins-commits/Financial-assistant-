import { describe, expect, it } from 'vitest';
import type { AppState } from '../../types';
import { seedState } from '../seed';
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
import { buildFacts, formatFactSheet, simulateMonthlyChange } from './facts';
import { screenAnswer, screenQuestion } from './guardrails';
import { route } from './router';
import { containsTerm } from './matching';
import { AGENTS, AGENT_LIST, buildSystemPrompt } from './roster';
import { executeTool, toolsFor } from './tools';
import { askLocally } from './index';

const REFERENCE = '2026-08-15';

function demo(): AppState {
  // The seed carries credit limits on its revolving accounts, so utilization is
  // computable out of the box.
  return seedState(REFERENCE);
}

// ---------------------------------------------------------------------------

describe('facts', () => {
  const facts = buildFacts(demo(), REFERENCE);

  it('computes cash flow with a fixed/discretionary split', () => {
    expect(facts.cashflow.incomeCents).toBeGreaterThan(0);
    expect(facts.cashflow.recurringCents + facts.cashflow.oneTimeCents).toBe(facts.cashflow.spentCents);
    expect(facts.cashflow.fixedShareOfIncomePercent).toBeGreaterThan(0);
  });

  it('computes per-account monthly interest', () => {
    const visa = facts.debt.items.find((d) => d.name.startsWith('Visa'));
    // $3,400 at 24.99% ≈ $70.81/mo
    expect(visa?.monthlyInterestCents).toBe(Math.round((340_000 * 0.2499) / 12));
  });

  it('computes credit utilization only where a limit exists', () => {
    const visa = facts.debt.items.find((d) => d.name.startsWith('Visa'));
    const store = facts.debt.items.find((d) => d.name.startsWith('Store'));
    const loan = facts.debt.items.find((d) => d.name.startsWith('Student'));

    expect(visa?.utilizationPercent).toBeCloseTo(68, 0); // 3,400 / 5,000
    expect(store?.utilizationPercent).toBeCloseTo(76.7, 1); // 920 / 1,200
    // A term loan has no limit, so it must be excluded rather than counted as 100%.
    expect(loan?.utilizationPercent).toBeUndefined();
    // Overall spans only the revolving accounts: 4,320 / 6,200.
    expect(facts.debt.overallUtilizationPercent).toBeCloseTo(69.7, 1);
  });

  it('sizes the emergency fund from essentials rather than income', () => {
    expect(facts.emergencyFund.threeMonthTargetCents).toBe(facts.emergencyFund.monthlyEssentialsCents * 3);
    // Entertainment and dining are not essentials, so essentials < total spend.
    expect(facts.emergencyFund.monthlyEssentialsCents).toBeLessThan(facts.cashflow.spentCents);
  });

  it('renders a fact sheet carrying the real figures', () => {
    const sheet = formatFactSheet(facts);
    expect(sheet).toContain('CASH FLOW');
    expect(sheet).toContain('DEBT:');
    expect(sheet).toContain('EMERGENCY FUND');
    expect(sheet).toMatch(/\$[\d,]+\.\d{2}/);
  });

  it('flags an unanchored cash figure in the fact sheet', () => {
    const state = demo();
    state.settings.accountBalanceCents = undefined;
    state.settings.accountBalanceAsOf = undefined;
    expect(formatFactSheet(buildFacts(state, REFERENCE))).toContain('ESTIMATE');
  });
});

describe('simulation', () => {
  it('prices a monthly cut in savings rate and debt months', () => {
    const state = demo();
    const facts = buildFacts(state, REFERENCE);
    const result = simulateMonthlyChange(state, facts, 10_000, 'cutting dining by $100');

    expect(result.annualImpactCents).toBe(120_000);
    expect(result.newSavingsRatePercent).toBeGreaterThan(facts.cashflow.savingsRatePercent);
    expect(result.debtInterestSavedCents ?? 0).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe('routing', () => {
  const cases: [string, string][] = [
    ['how do I raise my credit score?', 'credit'],
    ['what is my utilization?', 'credit'],
    ['should I use snowball or avalanche?', 'debt'],
    ['how do I pay off my credit card debt?', 'debt'],
    ['where did my money go this month?', 'budget'],
    ['am I spending too much on groceries?', 'budget'],
    ['how big should my emergency fund be?', 'savings'],
    ['am I saving enough?', 'savings'],
    ['explain index funds and ETFs', 'investing'],
    ['how does a roth ira work?', 'investing'],
    ['are my subscriptions worth it?', 'subscriptions'],
    ['how do quarterly estimated taxes work?', 'tax'],
    ['what house could I afford?', 'budget'],
    ['what if I invested $400 a month at 7%?', 'investing'],
  ];

  for (const [question, expected] of cases) {
    it(`routes "${question}" to ${expected}`, () => {
      expect(route(question).agent.id).toBe(expected);
    });
  }

  it('sends "credit card debt" to the debt strategist, not the credit coach', () => {
    expect(route('help me with my credit card debt').agent.id).toBe('debt');
  });

  it('falls back to the generalist when nothing matches', () => {
    expect(route('what is the airspeed velocity of a swallow?').agent.id).toBe('triage');
  });

  // Regression: the router matched keywords as bare substrings, so "airspeed"
  // contained "irs" and sent a nonsense question to the Tax & Records Guide.
  it('does not match a keyword hidden inside another word', () => {
    expect(containsTerm('airspeed velocity', 'irs')).toBe(false);
    expect(containsTerm('a classic car', 'ira')).toBe(false);
    expect(containsTerm('the season ended', 'save')).toBe(false);
    expect(route('what is the airspeed velocity of a swallow?').agent.id).toBe('triage');
  });

  // Regression: `\bterm\b` missed every inflection, so scenario questions fell
  // through to a generic answer that looked plausible.
  it('matches common word endings', () => {
    expect(containsTerm('I invested last year', 'invest')).toBe(true);
    expect(containsTerm('planning for retirement', 'retire')).toBe(true);
    expect(containsTerm('I earned more', 'earn')).toBe(true);
    expect(containsTerm('my savings account', 'saving')).toBe(true);
    expect(containsTerm('paying off cards', 'pay')).toBe(true);
  });

  it('detects hypotheticals', () => {
    expect(route('what if I earned $90,000?').hypothetical).toBe(true);
    expect(route('could I afford a house?').hypothetical).toBe(true);
    expect(route('where did my money go?').hypothetical).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('calculators', () => {
  it('compounds monthly with contributions', () => {
    const result = projectGrowth(0, 50_000, 7, 30);
    // $500/mo at 7% for 30 years ≈ $566k–$614k depending on convention.
    expect(result.futureValueCents).toBeGreaterThan(55_000_000);
    expect(result.futureValueCents).toBeLessThan(65_000_000);
    expect(result.contributedCents).toBe(50_000 * 360);
    expect(result.growthCents).toBe(result.futureValueCents - result.contributedCents);
    expect(result.yearlyBalancesCents).toHaveLength(30);
  });

  it('reports a payment that never clears a balance', () => {
    const result = payoffTime(1_000_000, 24, 10_000); // $100/mo against $200/mo interest
    expect(result.neverClears).toBe(true);
    expect(result.months).toBe(Infinity);
  });

  it('computes payoff time and interest for a viable payment', () => {
    const result = payoffTime(340_000, 24.99, 20_000);
    expect(result.neverClears).toBe(false);
    expect(result.months).toBeGreaterThan(12);
    expect(result.totalInterestCents).toBeGreaterThan(0);
  });

  it('applies the 28/36 rule', () => {
    const result = affordability(9_600_000, 84_000, 6.5, 30); // $96k/yr, $840/mo debt
    expect(result.maxMonthlyHousingCents).toBe(Math.round((9_600_000 / 12) * 0.28));
    expect(result.maxMonthlyAllDebtCents).toBe(Math.round((9_600_000 / 12) * 0.36));
    expect(result.estimatedMaxLoanCents).toBeGreaterThan(0);
    expect(result.assumptions.length).toBeGreaterThan(2);
  });

  it('reduces borrowing capacity when existing debt eats the 36% ceiling', () => {
    const clean = affordability(9_600_000, 0);
    const burdened = affordability(9_600_000, 250_000);
    expect(burdened.estimatedMaxLoanCents).toBeLessThan(clean.estimatedMaxLoanCents);
  });

  it('computes time to a savings target', () => {
    expect(timeToTarget(200_000, 20_000).months).toBe(10);
    expect(timeToTarget(200_000, 0).neverReaches).toBe(true);
    expect(timeToTarget(200_000, 20_000, 200_000).months).toBe(0);
  });

  it('applies the 4% rule', () => {
    expect(retirementTarget(6_000_000, 4)).toBe(150_000_000);
  });
});

describe('figure parsing', () => {
  it('parses scaled amounts', () => {
    expect(parseFigures('if I made $80k a year')[0]?.cents).toBe(8_000_000);
    expect(parseFigures('a $1.2m house')[0]?.cents).toBe(120_000_000);
    expect(parseFigures('$1,250.50')[0]?.cents).toBe(125_050);
  });

  it('marks annual figures', () => {
    expect(parseFigures('$80k a year')[0]?.annual).toBe(true);
    expect(parseFigures('$500 a month')[0]?.annual).toBe(false);
  });

  it('ignores bare small numbers that are not money', () => {
    expect(parseFigures('over 30 years')).toHaveLength(0);
    expect(parseFigures('at 7%')).toHaveLength(0);
  });

  it('parses rates and durations', () => {
    expect(parseRates('at 6.5% over time')).toEqual([6.5]);
    expect(parseYears('in 25 years')).toBe(25);
    expect(parseYears('over 18 months')).toBe(1.5);
  });

  it('recognises hypothetical phrasing', () => {
    expect(isHypothetical('what if I earned more')).toBe(true);
    expect(isHypothetical("let's say I had $10,000")).toBe(true);
    expect(isHypothetical('how much house can I afford')).toBe(true);
    expect(isHypothetical('how much did I spend on groceries')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('guardrails', () => {
  it('refuses a specific security recommendation', () => {
    const hit = screenQuestion('should I buy Tesla stock?');
    expect(hit?.kind).toBe('security-recommendation');
  });

  it('refuses a guaranteed-return question', () => {
    expect(screenQuestion('what investment has guaranteed returns?')?.kind).toBe('guaranteed-return');
  });

  it('refuses individualized tax questions', () => {
    expect(screenQuestion('can I deduct my home office on my taxes?')?.kind).toBe('individual-tax-legal');
  });

  it('allows educational and hypothetical questions through', () => {
    expect(screenQuestion('explain how index funds work')).toBeNull();
    expect(screenQuestion('what if I invested $500 a month at 7%?')).toBeNull();
    expect(screenQuestion('how do I build credit?')).toBeNull();
  });

  it('screens model output for recommendations and guarantees', () => {
    expect(screenAnswer('You should buy bitcoin now')?.kind).toBe('security-recommendation');
    expect(screenAnswer('this is a guaranteed return')?.kind).toBe('guaranteed-return');
  });

  it('does not block a legitimate educational answer that names asset classes', () => {
    const educational =
      'Index funds hold every company in a defined list. Bitcoin is volatile — drawdowns of 50–80% have happened repeatedly.';
    expect(screenAnswer(educational)).toBeNull();
  });

  it('puts the hard rules in every specialist prompt', () => {
    for (const agent of AGENT_LIST) {
      const prompt = buildSystemPrompt(agent, 'FACTS', false);
      expect(prompt).toContain('Never recommend buying, selling, or holding a specific security');
      expect(prompt).toContain('Never guarantee or imply a guaranteed return');
      expect(prompt).toContain('HYPOTHETICALS');
      expect(prompt).toContain('FACTS');
    }
  });
});

// ---------------------------------------------------------------------------

describe('tools', () => {
  const state = demo();

  it('exposes a schema for every tool a specialist declares', () => {
    for (const agent of AGENT_LIST) {
      expect(toolsFor(agent.tools)).toHaveLength(agent.tools.length);
    }
  });

  it('returns debt analysis in dollars, not cents', () => {
    const result = executeTool('get_debt_analysis', {}, state, REFERENCE) as Record<string, number>;
    // $22.72k of debt in the seed — a cents leak would read as millions.
    expect(result.total_debt_dollars).toBeGreaterThan(1_000);
    expect(result.total_debt_dollars).toBeLessThan(100_000);
  });

  it('returns category detail with transactions', () => {
    const result = executeTool('get_category_detail', { category_id: 'housing' }, state, REFERENCE) as {
      found: boolean;
      spent_dollars: number;
      transactions: unknown[];
    };
    expect(result.found).toBe(true);
    expect(result.spent_dollars).toBe(1500);
    expect(result.transactions.length).toBeGreaterThan(0);
  });

  it('filters transactions by category and amount', () => {
    const result = executeTool(
      'list_transactions',
      { min_amount_dollars: 400, limit: 5 },
      state,
      REFERENCE,
    ) as { transactions: { amount_dollars: number }[] };
    expect(result.transactions.every((t) => t.amount_dollars >= 400)).toBe(true);
    expect(result.transactions.length).toBeLessThanOrEqual(5);
  });

  it('runs hypothetical arithmetic through calculate', () => {
    const result = executeTool(
      'calculate',
      { operation: 'compound_growth', monthly_dollars: 500, annual_rate_percent: 7, years: 30 },
      state,
      REFERENCE,
    ) as { future_value_dollars: number; assumptions: string };
    expect(result.future_value_dollars).toBeGreaterThan(500_000);
    expect(result.assumptions).toMatch(/not guaranteed/i);
  });

  it('computes affordability through calculate', () => {
    const result = executeTool(
      'calculate',
      { operation: 'affordability', gross_annual_income_dollars: 96_000, existing_monthly_debt_dollars: 840 },
      state,
      REFERENCE,
    ) as { max_monthly_housing_dollars: number };
    expect(result.max_monthly_housing_dollars).toBeCloseTo(2240, 0);
  });

  it('reports an unknown tool rather than throwing', () => {
    expect(executeTool('nope', {}, state, REFERENCE)).toHaveProperty('error');
  });
});

// ---------------------------------------------------------------------------

describe('local specialist answers', () => {
  const state = demo();
  const ask = (question: string) => askLocally(question, state, REFERENCE);

  it('answers credit questions with the user\'s real utilization', () => {
    const reply = ask('how do I raise my credit score?');
    expect(reply.agent.id).toBe('credit');
    expect(reply.text).toMatch(/utilization/i);
    // The specific figure, not a generic explanation.
    expect(reply.text).toMatch(/Visa|Store card/);
    expect(reply.text).toMatch(/under 30%/);
    expect(reply.text).toMatch(/\$[\d,]+\.\d{2}/);
  });

  it('answers debt questions with real balances and interest', () => {
    const reply = ask('snowball or avalanche?');
    expect(reply.agent.id).toBe('debt');
    expect(reply.text).toMatch(/Avalanche/);
    expect(reply.text).toMatch(/interest alone/);
    expect(reply.text).toMatch(/\$[\d,]+\.\d{2}/);
  });

  it('sizes the emergency fund from the user\'s essentials', () => {
    const reply = ask('how big should my emergency fund be?');
    expect(reply.agent.id).toBe('savings');
    expect(reply.text).toMatch(/essential/i);
    expect(reply.text).toMatch(/months of cover|months\*\*/);
  });

  it('quantifies subscriptions annually', () => {
    const reply = ask('are my subscriptions worth it?');
    expect(reply.agent.id).toBe('subscriptions');
    expect(reply.text).toMatch(/\/year|\/yr/);
    expect(reply.text).toMatch(/last 30 days/);
  });

  it('leads a budget answer with the fixed/discretionary split', () => {
    const reply = ask('where did my money go this month?');
    expect(reply.agent.id).toBe('budget');
    expect(reply.text).toMatch(/fixed costs are/i);
    expect(reply.text).toMatch(/of income/);
  });

  it('puts high-interest debt ahead of investing, with the real rate', () => {
    const reply = ask('should I start investing?');
    expect(reply.agent.id).toBe('investing');
    expect(reply.text).toMatch(/guaranteed .*% return/);
    expect(reply.text).toMatch(/29\.99%|24\.99%/);
  });

  it('still refuses a security recommendation on the local path', () => {
    expect(ask('should I buy bitcoin?').text).toMatch(/not licensed/i);
  });
});

describe('local hypothetical answers', () => {
  const state = demo();
  const ask = (question: string) => askLocally(question, state, REFERENCE);

  it('answers a housing affordability hypothetical with figures and assumptions', () => {
    const reply = ask('what if I earned $96,000 a year — what house could I afford?');
    expect(reply.text).toMatch(/28% of gross/);
    expect(reply.text).toMatch(/Assumptions/);
    expect(reply.text).toMatch(/\$2,240\.00/);
  });

  it('answers an investment growth hypothetical', () => {
    const reply = ask('what if I invested $400 a month at 7% for 25 years?');
    expect(reply.text).toMatch(/Future value/);
    expect(reply.text).toMatch(/assumption, not a promise/);
  });

  it('answers a retirement hypothetical using the 4% rule', () => {
    const reply = ask('suppose I wanted $60,000 a year in retirement — how much do I need?');
    expect(reply.text).toMatch(/4% rule/);
    expect(reply.text).toMatch(/\$1,500,000\.00/);
  });

  it('answers a salary-change hypothetical against real spending', () => {
    const reply = ask('what if I earned $120,000 a year?');
    expect(reply.text).toMatch(/gross/);
    expect(reply.text).toMatch(/savings rate/);
  });

  it('answers a payoff hypothetical, including one that never clears', () => {
    const reply = ask('what if I paid $50 a month on a $10,000 balance at 24%?');
    expect(reply.text).toMatch(/never clears/i);
  });

  it('never answers a hypothetical by refusing to look outside stored data', () => {
    for (const question of [
      'what if I made $200,000 a year?',
      'if I had $50,000 saved, how long would it last?',
      'could I afford $2,500 a month in rent?',
      'what if I invested $1,000 a month at 6%?',
    ]) {
      const reply = ask(question);
      expect(reply.text, question).not.toMatch(/only see|cannot see|no data|not in your/i);
      expect(reply.text.length).toBeGreaterThan(80);
    }
  });
});

describe('roster integrity', () => {
  it('gives every specialist keywords, tools and instructions', () => {
    for (const agent of AGENT_LIST) {
      expect(agent.name.length).toBeGreaterThan(0);
      expect(agent.instructions.length).toBeGreaterThan(200);
      expect(agent.tools.length).toBeGreaterThan(0);
      if (agent.id !== 'triage') expect(agent.keywords.length).toBeGreaterThan(3);
    }
  });

  it('produces a non-trivial local answer for every specialist', () => {
    const state = demo();
    const facts = buildFacts(state, REFERENCE);
    for (const agent of AGENT_LIST) {
      const answer = agent.localAnswer(facts, state, 'test');
      expect(answer.length, agent.id).toBeGreaterThan(120);
      expect(answer, agent.id).toMatch(/\$|%/);
    }
  });

  it('keeps the triage agent reachable by id', () => {
    expect(AGENTS.triage.id).toBe('triage');
  });
});
