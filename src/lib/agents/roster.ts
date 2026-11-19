import type { AppState } from '../../types';
import { formatMonths } from '../debt';
import { formatMoney, formatPercent } from '../money';
import { depreciate } from '../business/accounting';
import type { AdvisorFacts } from './facts';
import { DISCLAIMER, SHARED_GUARDRAILS } from './guardrails';

/**
 * The specialist roster.
 *
 * One generalist answering everything is what made the old advisor vague: it
 * had a single prompt covering credit, debt, investing and budgeting, so it
 * could only say what was true of all four. Each specialist here owns a narrow
 * domain, states the analysis it must perform before answering, and works from
 * the facts layer — which is what turns "keep utilization low" into "your store
 * card is at 87%; paying $420 before the statement closes takes it under 30%".
 */

export type AgentId =
  | 'budget'
  | 'debt'
  | 'credit'
  | 'savings'
  | 'investing'
  | 'subscriptions'
  | 'tax'
  | 'business'
  | 'triage';

export interface Agent {
  id: AgentId;
  /** Shown in the UI as the answering specialist. */
  name: string;
  /** One line describing the beat. */
  beat: string;
  color: string;
  /** Terms that route a question here, scored by the router. */
  keywords: string[];
  /** Tools this specialist may call on the model-backed path. */
  tools: string[];
  /** Domain instructions, appended to the shared base prompt. */
  instructions: string;
  /** Deterministic grounded answer, used offline and as the fallback. */
  localAnswer: (facts: AdvisorFacts, state: AppState, question: string) => string;
}

const m = (cents: number) => formatMoney(cents);
const p = (value: number, digits = 0) => formatPercent(value, digits);

const METHOD_LABELS: Record<string, string> = {
  'straight-line': 'straight line',
  'declining-balance': 'declining balance',
  'sum-of-years': 'sum-of-years-digits',
  'units-of-production': 'units of production',
};

const methodLabel = (method: string) => METHOD_LABELS[method] ?? method;

// ---------------------------------------------------------------------------

export const AGENTS: Record<AgentId, Agent> = {
  budget: {
    id: 'budget',
    name: 'Budget Analyst',
    beat: 'Cash flow, category drift, and where the money actually goes',
    color: '#4f7cff',
    keywords: [
      // Deliberately excludes generic words like "month", "income" and
      // "balance": they appear in almost every question and outvoted the
      // specialist keywords that actually carried the intent.
      'budget', 'budgeting', 'spend', 'spending', 'overspend', 'cash flow', 'cashflow',
      'category', 'categories', 'where did', 'where does', 'money go', '50/30/20', 'guideline',
      'cut back', 'too much', 'safe to spend', 'safe-to-spend', 'left over', 'leftover',
      'discretionary', 'fixed costs', 'cost of living',
      // Affordability is a cash-flow question, so it belongs here rather than
      // with the generalist.
      'afford', 'mortgage', 'house payment', 'down payment', 'can i buy',
    ],
    tools: ['get_financial_summary', 'get_category_detail', 'list_transactions', 'simulate_change'],
    instructions: `You are the Budget Analyst. You own cash flow: what comes in, what goes out, which categories are drifting, and what the user can actually afford.

Before answering, work through:
1. The split between fixed (recurring) and discretionary (one-time) spend as a share of income. Fixed costs above ~60% of income mean discretionary trimming cannot solve the problem, and you should say so.
2. Which categories moved most against last month and the six-month average. A category rising three months running is a trend, not noise.
3. Whether any category is disproportionate — above ~30% of total spend outside housing deserves a comment.
4. If the user asks whether they can afford something, compare it against safe-to-spend, not remaining balance, and say why.

Quantify every recommendation. "Cut dining" is useless; "dining is $124 this month against a $200 cap and $96 last month — holding it at $100 frees $24/mo, $288/yr" is advice. Use simulate_change to price any change you propose.

Never invent a number. Every figure comes from the fact sheet or a tool result.`,
    localAnswer: (f) => {
      const c = f.cashflow;
      if (c.incomeCents === 0) {
        return `You have ${m(c.spentCents)} of spending logged but no income for ${f.periodLabel}, so every ratio below would be meaningless. Add your income on the Money tab and I can run your actual numbers against the 50/30/20 guideline.`;
      }
      const top = f.categories[0];
      const movers = f.categories
        .filter((cat) => Math.abs(cat.deltaVsLastMonthCents) >= 2_000)
        .sort((a, b) => Math.abs(b.deltaVsLastMonthCents) - Math.abs(a.deltaVsLastMonthCents))
        .slice(0, 3);
      const rising = f.categories.filter((cat) => cat.risingThreeMonths);

      const out: string[] = [];
      out.push(
        `**${f.periodLabel}:** ${m(c.incomeCents)} in, ${m(c.spentCents)} out, ${m(c.remainingBalanceCents)} left — a savings rate of ${p(c.savingsRatePercent)}.`,
      );
      out.push('');
      out.push(
        `Your fixed costs are ${m(c.recurringCents)}, **${p(c.fixedShareOfIncomePercent)} of income**. Discretionary is ${m(c.oneTimeCents)} (${p(c.discretionaryShareOfIncomePercent)}).`,
      );
      out.push('');
      if (c.fixedShareOfIncomePercent > 60) {
        out.push(
          `That fixed share is the headline problem. Above 60%, trimming discretionary spending cannot move the needle much — the levers that matter are the big recurring lines (housing, auto, insurance) or income. Worth knowing before you blame yourself for coffee.`,
        );
      } else if (c.fixedShareOfIncomePercent > 50) {
        out.push(
          `That is above the 50% the 50/30/20 guideline allows for needs, but not by enough to be structural. You have real room on the discretionary side.`,
        );
      } else {
        out.push(
          `That is inside the 50% guideline for needs, which means your discretionary choices genuinely drive the outcome — the money is yours to direct.`,
        );
      }

      if (top) {
        out.push('');
        out.push(
          `Largest category: **${top.name}** at ${m(top.spentCents)}, ${p(top.percentOfSpend)} of spend and ${p(top.percentOfIncome)} of income.`,
        );
      }
      if (movers.length > 0) {
        out.push('');
        out.push('Biggest moves against last month:');
        for (const mv of movers) {
          out.push(
            `- ${mv.name}: ${mv.deltaVsLastMonthCents > 0 ? '+' : ''}${m(mv.deltaVsLastMonthCents)} (now ${m(mv.spentCents)}, six-month average ${m(mv.sixMonthAverageCents)})`,
          );
        }
      }
      if (rising.length > 0) {
        out.push('');
        out.push(
          `Rising three months running: ${rising.map((r) => r.name).join(', ')}. That is a trend rather than a one-off — worth a deliberate decision either way.`,
        );
      }

      const overCap = f.categories.filter((cat) => (cat.capPercent ?? 0) >= 100);
      if (overCap.length > 0) {
        out.push('');
        for (const cat of overCap) {
          out.push(
            `**${cat.name} is over its cap** — ${m(cat.spentCents)} against ${m(cat.capCents ?? 0)}, ${p(cat.capPercent ?? 0)} of the limit.`,
          );
        }
      }

      out.push('');
      out.push(
        `Spend against **safe-to-spend (${m(c.safeToSpendCents)})**, not the remaining balance — ${m(c.remainingBalanceCents)} still has bills to pay out of it.`,
      );
      return out.join('\n');
    },
  },

  debt: {
    id: 'debt',
    name: 'Debt Strategist',
    beat: 'Payoff order, interest cost, and what actually shortens the timeline',
    color: '#a855f7',
    keywords: [
      'debt', 'debts', 'payoff', 'pay off', 'snowball', 'avalanche', 'loan', 'loans',
      'credit card debt', 'apr', 'interest', 'minimum payment', 'consolidate',
      'consolidation', 'balance transfer', 'student loan', 'car note', 'owe',
    ],
    tools: ['get_debt_analysis', 'get_financial_summary', 'simulate_change'],
    instructions: `You are the Debt Strategist. You own payoff order, interest cost, and the arithmetic of getting to zero.

Before answering, work through:
1. What the debt costs per month in interest alone — that number motivates more than the balance does.
2. Avalanche versus snowball on the user's real balances, with the actual interest difference. Do not describe the strategies abstractly when you can run them.
3. Whether the payment is even sufficient. If the projection never clears, say so directly — the fix is a bigger payment or a lower rate, not a different ordering.
4. Whether rate reduction (balance transfer, consolidation, hardship program, non-profit credit counselling via the NFCC) beats reordering. When one debt is far above the others, it usually does.

Always call get_debt_analysis before giving a recommendation, and use simulate_change to show what an extra $50 or $100 a month actually buys in months and interest.

Flag the risks plainly: promotional balance-transfer rates end, some cards apply deferred interest retroactively, and consolidating unsecured debt into a secured loan puts an asset at risk. Never suggest borrowing to invest or raiding retirement accounts without stating the risk first.`,
    localAnswer: (f, state) => {
      if (f.debt.items.length === 0) {
        return `You have no debts logged, so I cannot run your numbers. Add them on the Plan tab with balance, APR and minimum payment, and I will compare avalanche against snowball on your real balances and show the interest difference.

The short version: **avalanche** (highest rate first) always pays less interest; **snowball** (smallest balance first) clears individual accounts sooner and people stick with it more often. The gap is small when rates are similar and large when one debt is far above the rest.`;
      }
      const d = f.debt;
      const out: string[] = [];
      out.push(
        `You owe **${m(d.totalCents)}** across ${d.items.length} ${d.items.length === 1 ? 'account' : 'accounts'} at a ${p(d.blendedAprPercent, 2)} blended rate.`,
      );
      out.push('');
      out.push(
        `That costs **${m(d.monthlyInterestCents)} a month in interest alone** — ${m(d.monthlyInterestCents * 12)} a year before you reduce a single balance. Minimums total ${m(d.minimumsCents)}/mo.`,
      );
      out.push('');
      out.push('Per account, highest rate first:');
      for (const item of [...d.items].sort((a, b) => b.aprPercent - a.aprPercent)) {
        out.push(
          `- **${item.name}**: ${m(item.balanceCents)} at ${p(item.aprPercent, 2)} — ${m(item.monthlyInterestCents)}/mo interest${
            item.utilizationPercent !== undefined ? `, ${p(item.utilizationPercent)} utilization` : ''
          }`,
        );
      }

      if (d.payoff) {
        out.push('');
        if (d.payoff.impossible) {
          out.push(
            `At your current leftover of ${m(d.payoff.extraPaymentCents)}/mo on top of the minimums, **the balances never reach zero** — interest is keeping pace with the payments.`,
          );
          out.push('');
          out.push(
            `That is the signal to change the inputs rather than the ordering. Raising the payment or cutting the rate moves this; payment order does not. A non-profit credit counselling agency (start with the NFCC) can negotiate rates without charging you.`,
          );
        } else {
          out.push(
            `Putting your projected leftover of ${m(d.payoff.extraPaymentCents)}/mo against the minimums:`,
          );
          out.push('');
          out.push(
            `- **Avalanche** (highest rate first): clear in ${formatMonths(d.payoff.avalancheMonths)}, ${m(d.payoff.avalancheInterestCents)} interest`,
          );
          out.push(
            `- **Snowball** (smallest balance first): clear in ${formatMonths(d.payoff.snowballMonths)}, ${m(d.payoff.snowballInterestCents)} interest`,
          );
          out.push('');
          out.push(
            `Avalanche saves **${m(d.payoff.interestSavedCents)}**. Order of attack: ${d.payoff.avalancheOrder.join(' → ')}.`,
          );
          if (d.payoff.interestSavedCents < 15_000) {
            out.push('');
            out.push(
              `That gap is small enough that the behavioural argument wins if it helps you finish — clearing ${d.payoff.avalancheOrder.at(-1) ?? 'the smallest account'} early is motivating, and the worst plan is the one you abandon.`,
            );
          }
        }
      }

      const highest = [...d.items].sort((a, b) => b.aprPercent - a.aprPercent)[0];
      if (highest && highest.aprPercent >= 20 && state.debts.length > 1) {
        out.push('');
        out.push(
          `One thing worth pricing: **${highest.name}** at ${p(highest.aprPercent, 2)} is far above the rest. Cutting that rate — a balance transfer, a consolidation loan, or simply calling and asking — can beat any reordering. Watch the terms: promotional rates expire, and some cards charge deferred interest retroactively if the balance is not cleared in time.`,
        );
      }

      out.push('');
      out.push(`Put every minimum on autopay first. A missed payment costs more in score damage than the strategy difference costs in interest.`);
      return out.join('\n');
    },
  },

  credit: {
    id: 'credit',
    name: 'Credit Coach',
    beat: 'Score factors, utilization, and legitimate ways to build history',
    color: '#22c55e',
    keywords: [
      'credit score', 'credit', 'fico', 'vantage', 'utilization', 'build credit',
      'credit history', 'credit report', 'dispute', 'authorized user', 'secured card',
      'hard inquiry', 'soft pull', 'collections', 'late payment', 'raise my score',
      'improve my credit', 'credit limit',
    ],
    tools: ['get_debt_analysis', 'get_financial_summary'],
    instructions: `You are the Credit Coach. You own score mechanics and legitimate credit building.

Before answering, work through:
1. The user's actual utilization, per card and overall, when credit limits are known. This is ~30% of a score and the fastest thing they can change, so lead with their real number and the exact payment that moves it under 30% and under 10%.
2. Whether any high-rate revolving balance is also a utilization problem — one payment often fixes both.
3. If no credit limits are recorded, say so and ask for them rather than lecturing generically.

The five factors, with weights: payment history ~35%, utilization ~30%, age of accounts ~15%, credit mix ~10%, new inquiries ~10%. Only utilization moves fast — it resets when the statement closes, which is why paying before the statement date (not the due date) is what the bureau sees.

Legitimate building: on-time payments (autopay the minimum, pay more manually), paying down before the statement closes, becoming an authorized user on an established well-managed account, secured cards, credit-builder loans. Keep old accounts open — closing the oldest hurts average age and cuts total limit, which raises utilization.

Disputes are free and direct with each bureau; the bureau has 30 days. Never endorse paying someone to dispute accurate entries — it does not work and the items return.

Never promise a specific score increase or timeline. Explain the mechanism and what it typically affects.`,
    localAnswer: (f) => {
      const out: string[] = [];
      const revolving = f.debt.items.filter((d) => d.utilizationPercent !== undefined);

      if (revolving.length > 0) {
        out.push(
          `**Your utilization right now: ${p(f.debt.overallUtilizationPercent ?? 0)} overall.**`,
        );
        out.push('');
        for (const card of [...revolving].sort((a, b) => (b.utilizationPercent ?? 0) - (a.utilizationPercent ?? 0))) {
          const limit = card.creditLimitCents ?? 0;
          const to30 = Math.max(0, card.balanceCents - Math.floor(limit * 0.3));
          const to10 = Math.max(0, card.balanceCents - Math.floor(limit * 0.1));
          out.push(
            `- **${card.name}**: ${m(card.balanceCents)} of ${m(limit)} — ${p(card.utilizationPercent ?? 0)}${
              to30 > 0 ? `. Paying ${m(to30)} takes it under 30%; ${m(to10)} takes it under 10%.` : ' — already under 30%.'
            }`,
          );
        }
        out.push('');
        out.push(
          `Utilization is roughly 30% of your score and it **resets every statement**, which makes it the fastest thing you can move. Pay before the statement closes, not before the due date — the statement balance is what gets reported.`,
        );
      } else if (f.debt.items.length > 0) {
        out.push(
          `You have ${f.debt.items.length} debts logged but no credit limits on them, so I cannot compute your real utilization — and that is the number worth knowing, since it is ~30% of your score and the fastest one to move.`,
        );
        out.push('');
        out.push(`Add the credit limit to each revolving account on the Plan tab and I will show you the exact payment that takes each card under 30% and under 10%.`);
      } else {
        out.push(`You have no credit accounts logged, so I will keep this to the mechanics — add your cards with balances and limits and I can compute your actual utilization.`);
      }

      out.push('');
      out.push('**The five factors, by weight:**');
      out.push('- Payment history (~35%) — the biggest. One payment 30+ days late does lasting damage. Autopay the minimum on everything, then pay more by hand; a forgetful month then costs interest instead of your score.');
      out.push('- Utilization (~30%) — balance ÷ limit, per card and overall. Under 30% is the usual advice, under 10% is better. Resets monthly.');
      out.push('- Age of accounts (~15%) — why closing your oldest card usually hurts twice: it shortens average age and removes its limit, raising utilization. Leave it open with a small recurring charge.');
      out.push('- Credit mix (~10%) and new inquiries (~10%) — minor. Do not open accounts chasing these.');
      out.push('');
      out.push('**Building from a thin file, all legitimate:** become an *authorized user* on someone established and well-managed (their history can report on your file); use a *secured card*, where your deposit becomes the limit, and graduate it; or a *credit-builder loan* from a credit union.');
      out.push('');
      out.push(`If something on your report is wrong, dispute it free and directly with each bureau — they have 30 days to investigate. Avoid anyone charging to "repair" credit by disputing accurate entries; it does not work and the items come back.`);
      out.push('');
      out.push(`I will not promise you a number or a date — scores respond to mechanisms, not schedules. ${DISCLAIMER}`);
      return out.join('\n');
    },
  },

  savings: {
    id: 'savings',
    name: 'Savings Planner',
    beat: 'Emergency fund sizing, goal timelines, and raising the savings rate',
    color: '#14b8a6',
    keywords: [
      'save', 'saving', 'savings', 'savings rate', 'emergency fund', 'rainy day',
      'goal', 'goals', 'bucket', 'target', 'set aside', 'sinking fund', 'nest egg',
      'how much should i save', 'runway', 'cushion',
    ],
    tools: ['get_financial_summary', 'get_goals', 'simulate_change'],
    instructions: `You are the Savings Planner. You own the emergency fund, savings goals and the savings rate.

Before answering, work through:
1. Size the emergency fund from the user's actual monthly *essentials* (housing, insurance, auto, groceries, utilities, health, debt minimums), not from income. Give the 3-month and 6-month figures and where they stand today.
2. Their real runway — how many months current cash covers essentials with no income. That number lands harder than a target does.
3. Goal timelines at their actual leftover, and what changing the monthly amount does to each date. Use simulate_change.
4. Whether their savings rate clears the 20% guideline, and the exact monthly gap if not.

Order operations honestly: a starter emergency fund (~$1,000, or one month of essentials) first, then any employer 401(k) match, then high-interest debt, then the full fund. Say why — the match is part of compensation, and high-interest debt is a guaranteed negative return that beats most alternatives.

Practical mechanics beat willpower: automate the transfer on payday so the decision happens once, attack the big recurring costs rather than small ones, and give money a name — unlabelled money reads as available.`,
    localAnswer: (f) => {
      const c = f.cashflow;
      const ef = f.emergencyFund;
      const out: string[] = [];

      out.push(
        `You are keeping **${p(c.savingsRatePercent)}** of your income this period — ${m(c.remainingBalanceCents)} out of ${m(c.incomeCents)}.`,
      );
      if (c.incomeCents > 0 && c.savingsRatePercent < 20) {
        const gap = Math.round(c.incomeCents * 0.2) - c.remainingBalanceCents;
        out.push('');
        out.push(`The 20% guideline would be ${m(Math.round(c.incomeCents * 0.2))}, so the gap is **${m(gap)} a month**.`);
      }

      out.push('');
      out.push('**Emergency fund.** Size it from essentials, not income.');
      out.push(
        `Your essential recurring costs are **${m(ef.monthlyEssentialsCents)}/mo** — housing, insurance, auto, groceries, utilities, health and debt minimums. That puts the range at ${m(ef.threeMonthTargetCents)} (3 months) to ${m(ef.sixMonthTargetCents)} (6 months).`,
      );
      out.push('');
      out.push(
        `You have ${m(ef.currentSavedCents)} across your goals — **${ef.monthsCovered.toFixed(1)} months of cover**.`,
      );
      if (f.runwayMonths !== null) {
        out.push(
          `On cash on hand alone, with no income at all, you would last about **${f.runwayMonths.toFixed(1)} months**.`,
        );
      }
      out.push('');
      if (ef.monthsCovered < 1) {
        out.push(
          `Under one month is the fragile zone, where an ordinary car repair becomes credit card debt. The first ${m(100_000)} does most of the work — it covers the everyday emergencies. Start there rather than at the full ${m(ef.threeMonthTargetCents)}, which is discouraging enough that people never begin.`,
        );
      } else if (ef.monthsCovered < 3) {
        out.push(
          `You are past the fragile zone and short of the target. Getting to ${m(ef.threeMonthTargetCents)} means another ${m(Math.max(0, ef.threeMonthTargetCents - ef.currentSavedCents))}.`,
        );
      } else {
        out.push(`You are inside the standard range. The useful next question is where additional savings go, not whether the cushion exists.`);
      }

      if (f.goals.length > 0) {
        out.push('');
        out.push('**Your goals at the current leftover:**');
        for (const g of f.goals) {
          out.push(
            `- ${g.name}: ${m(g.savedCents)}/${m(g.targetCents)} (${p(g.percentFunded)}) — ${m(g.remainingCents)} to go${
              g.monthsToFundAtCurrentRate !== null
                ? `, about **${g.monthsToFundAtCurrentRate} ${g.monthsToFundAtCurrentRate === 1 ? 'month' : 'months'}**`
                : ', though your current leftover is zero so there is no timeline yet'
            }`,
          );
        }
      } else {
        out.push('');
        out.push(
          `You have no goals set. With ${m(Math.max(0, c.remainingBalanceCents))} projected leftover, money without a name attached tends to find a use — a target changes that.`,
        );
      }

      out.push('');
      out.push('Three things that move a savings rate more than willpower:');
      out.push('- **Automate it on payday**, before the money is available to spend. Saving what is left at month end almost never works, because there rarely is any.');
      out.push(
        `- **Attack the fixed costs.** Yours are ${m(c.recurringCents)}/mo. One successful renegotiation — insurance, phone, a dropped subscription — repeats every month for free. Skipping coffee does not.`,
      );
      out.push('- **Name the money.** Turn on the reserve toggle on a goal and it stops showing up in safe-to-spend.');
      return out.join('\n');
    },
  },

  investing: {
    id: 'investing',
    name: 'Investing Educator',
    beat: 'Asset classes and retirement accounts, explained — never a recommendation',
    color: '#8b5cf6',
    keywords: [
      'invest', 'investing', 'investment', 'stock', 'bond', 'index fund',
      'etf', 'mutual fund', 'portfolio', 'diversify', 'diversification', 'stock market',
      '401k', '401(k)', 'ira', 'roth', 'retirement', 'pension', 'brokerage', 'compound',
      'compound interest', 'crypto', 'cryptocurrency', 'bitcoin', 'expense ratio',
      'asset allocation', 'rate of return', 'annual return',
    ],
    tools: ['get_financial_summary', 'get_debt_analysis'],
    instructions: `You are the Investing Educator. You explain how things work. You never recommend a specific security, coin or ticker — that rule is absolute and comes before helpfulness.

Before answering, work through:
1. Whether the user is actually ready to invest. High-interest debt is a guaranteed negative return: paying off a card at 25% beats any expected market return with certainty. If they carry expensive debt or have no emergency fund, say so first — with their real numbers — then answer the question they asked.
2. An employer 401(k) match, if relevant, is part of compensation. Not capturing it leaves salary on the table.
3. Their time horizon. Money needed within a few years does not belong in equities.

Explain jargon the first time you use it. Cover mechanism, typical risk/return, cost (expense ratios compound against the investor), and tax treatment at a general level — then send them to a CPA for their own situation.

On crypto, name the volatility plainly: repeated 50–80% drawdowns, no cash flows underneath most of it, price set entirely by the next buyer. In the US it is generally treated as property, so trading one coin for another is a taxable event and people are routinely surprised. Describe the risk; never predict the price.

You may name asset *classes* and account *types*. You may not name a fund, ticker or coin as something to buy.`,
    localAnswer: (f) => {
      const out: string[] = [];
      const highRate = f.debt.items.filter((d) => d.aprPercent >= 10);

      if (highRate.length > 0) {
        const worst = [...highRate].sort((a, b) => b.aprPercent - a.aprPercent)[0]!;
        out.push(
          `Before the investing question — you are carrying ${m(worst.balanceCents)} at **${p(worst.aprPercent, 2)}** on ${worst.name}.`,
        );
        out.push('');
        out.push(
          `Paying that down is a **guaranteed ${p(worst.aprPercent, 2)} return**. No investment offers that with certainty, which is why the standard order of operations puts high-interest debt ahead of investing. It costs you ${m(worst.monthlyInterestCents)} a month right now.`,
        );
        out.push('');
        out.push(`The one common exception: an employer 401(k) match. That is part of your compensation, and a 50–100% instant return beats even a 25% card. Capture the full match first, then the debt, then invest further.`);
        out.push('');
        out.push('With that said, here is how the pieces work:');
        out.push('');
      }

      if (f.emergencyFund.monthsCovered < 3) {
        out.push(
          `Also worth noting: your emergency fund covers **${f.emergencyFund.monthsCovered.toFixed(1)} months** of the ${m(f.emergencyFund.monthlyEssentialsCents)}/mo you need. Investing before that cushion exists tends to mean selling at the worst possible moment, because the market does not consult your car's repair schedule.`,
        );
        out.push('');
      }

      out.push('**The categories:**');
      out.push('- **Stocks** — partial ownership of a company. Highest long-run returns historically, largest swings. An individual stock concentrates your outcome in one company.');
      out.push('- **Bonds** — lending at interest. Steadier, lower expected return. Prices fall when rates rise, which surprises people who read "safe" as "flat".');
      out.push('- **Index funds and ETFs** — one purchase holding an entire defined market. Diversification across companies and low cost: commonly 0.03–0.20% a year against 0.5–1%+ for active management, and that gap compounds against you annually. They do not protect against the market falling — a broad index dropped roughly 50% in 2008.');
      out.push('- **Cash equivalents** — savings, money market funds, CDs, Treasury bills. Principal stable; inflation still erodes purchasing power.');
      out.push('');
      out.push('**Retirement accounts** are ordinary investments inside a tax wrapper, and the wrapper is the point:');
      out.push('- **401(k)** — through an employer, contributions pre-tax, taxed on withdrawal. Many employers match; that match is compensation.');
      out.push('- **Traditional IRA** — same tax shape, opened by you, lower limits, deductibility phases out at higher incomes.');
      out.push('- **Roth (IRA or 401(k))** — contributions already taxed, growth untaxed, qualified withdrawals tax-free. Favours those expecting a higher bracket later.');
      out.push('');
      out.push('Early withdrawals before 59½ generally trigger income tax plus a 10% penalty, with specific exceptions. Limits and phase-outs change annually — check current IRS figures rather than a number you read once.');
      out.push('');
      out.push('The mechanism underneath all of it is **compounding**: returns earning returns. Unremarkable over one year, decisive over thirty — which is why time in the market gets more attention than timing it.');
      out.push('');
      out.push(`I will not name a fund, ticker or coin to buy. ${DISCLAIMER}`);
      return out.join('\n');
    },
  },

  subscriptions: {
    id: 'subscriptions',
    name: 'Subscription Auditor',
    beat: 'Recurring charges, quiet leaks, and what to cancel',
    color: '#ec4899',
    keywords: [
      'subscription', 'subscriptions', 'recurring charge', 'streaming', 'membership',
      'cancel', 'auto-renew', 'renewal', 'free trial', 'unused', 'still paying',
    ],
    tools: ['get_subscriptions', 'list_transactions', 'simulate_change'],
    instructions: `You are the Subscription Auditor. You own recurring charges and the money that leaks through them.

Before answering, work through:
1. Total subscription cost monthly *and annually* — the annual figure is what makes the decision, since each individual charge is too small to notice.
2. The share of income and of discretionary spend they represent.
3. Which are large enough to be worth a decision on their own.

The question that actually decides a subscription is not "is this worth $12" but "did I use it in the last 30 days, and would I re-subscribe today at this price". Anything failing both is a cancellation. Say that, then price it: cancelling X saves $Y a year, which is Z months off the emergency fund target.

Flag annual renewals specifically — they are easy to forget and often renew above the introductory rate.`,
    localAnswer: (f) => {
      const s = f.subscriptions;
      if (s.count === 0) {
        return `You have nothing logged under Subscriptions. If you are paying for any, adding them as recurring expenses is worth the two minutes — subscriptions are the most common place money leaks, precisely because each one is individually too small to notice.`;
      }
      const out: string[] = [];
      out.push(
        `**${s.count} active subscriptions: ${m(s.monthlyCents)}/month, ${m(s.annualCents)}/year.**`,
      );
      out.push('');
      out.push(
        `That is ${p((s.monthlyCents / Math.max(1, f.cashflow.incomeCents)) * 100, 1)} of your income and ${p((s.monthlyCents / Math.max(1, f.cashflow.spentCents)) * 100, 1)} of your spending.`,
      );
      out.push('');
      for (const item of s.items) {
        out.push(`- **${item.name}** — ${m(item.monthlyCents)}/mo, ${m(item.annualCents)}/yr`);
      }
      out.push('');
      out.push(
        `The annual column is the one that decides things. ${s.items[0] ? `${s.items[0].name} is ${m(s.items[0].monthlyCents)} a month, which is easy to wave through — and ${m(s.items[0].annualCents)} a year, which is not.` : ''}`,
      );
      out.push('');
      out.push(
        `The question that settles each one is not "is this worth ${m(s.items[0]?.monthlyCents ?? 1200)}" but **"did I use it in the last 30 days, and would I re-subscribe today at this price?"** Anything failing both is a cancellation.`,
      );
      if (f.emergencyFund.monthlyEssentialsCents > 0) {
        const months = s.annualCents / f.emergencyFund.monthlyEssentialsCents;
        out.push('');
        out.push(
          `For scale: cancelling all of them would cover **${months.toFixed(1)} months** of your ${m(f.emergencyFund.monthlyEssentialsCents)} essentials — a real dent in the emergency fund, from money you may already not be using.`,
        );
      }
      out.push('');
      out.push(`Watch the annual renewals in particular. They are the easiest to forget and they often renew above the rate you originally signed up at.`);
      return out.join('\n');
    },
  },

  tax: {
    id: 'tax',
    name: 'Tax & Records Guide',
    beat: 'General principles and getting your records ready — never your return',
    color: '#f59e0b',
    keywords: [
      'tax', 'taxes', 'deduction', 'deductible', 'write off', 'write-off', '1099', 'w-2',
      'w2', 'irs', 'refund', 'withholding', 'quarterly', 'estimated', 'bracket',
      'filing', 'cpa', 'accountant', 'export', 'records',
    ],
    tools: ['get_financial_summary', 'get_category_detail'],
    instructions: `You are the Tax & Records Guide. You explain general principles and help the user arrive at a preparer organised. You never advise on their specific return, deductions, or filing position — that is a CPA's job and the cost of a wrong answer is high.

Principles worth explaining, since they are widely misunderstood:
- Marginal rates: a higher bracket taxes only the dollars above the threshold. "A raise pushed me into a higher bracket so I take home less" is essentially always wrong.
- Deductions reduce taxable income; credits reduce the tax itself. A $1,000 credit beats a $1,000 deduction.
- Pre-tax versus Roth is a timing choice about which side of your career gets taxed.
- 1099 income generally carries self-employment tax on top of income tax and usually requires quarterly estimated payments. Setting aside a fixed percentage of each payment as it arrives is the habit that prevents an unpleasant April.

Point at the Export tab: an annual by-category summary is a legitimate starting point for a conversation with a preparer, and it is not a substitute for one.

If asked anything about the user's own filing, deductions, or an audit, decline and redirect — do not hedge into a partial answer.`,
    localAnswer: (f) => {
      const out: string[] = [];
      out.push(
        `I keep this to general principles — anything about your own return is a CPA question, and the fee is cheaper than a wrong answer.`,
      );
      out.push('');
      out.push('**The things most often misunderstood:**');
      out.push('- **Marginal rates.** Moving into a higher bracket taxes the dollars *above* the threshold, not your whole income. "A raise pushed me into a higher bracket so I take home less" is essentially always a misunderstanding.');
      out.push('- **Deductions vs. credits.** A deduction reduces the income you are taxed on; a credit reduces the tax itself. A $1,000 credit is worth far more than a $1,000 deduction.');
      out.push('- **Pre-tax vs. Roth.** Traditional contributions lower this year\'s taxable income and are taxed on withdrawal; Roth is the reverse. It is a bet on which side of your career carries the higher rate.');
      out.push('- **Self-employment.** 1099 income generally carries self-employment tax on top of income tax and usually requires quarterly estimated payments. Setting aside a fixed percentage of every payment as it lands is the habit that prevents a painful April.');
      out.push('');
      out.push(
        `**For your records:** you have ${m(f.cashflow.spentCents)} of categorised spending in ${f.periodLabel} and ${f.history.length} months of history. The Export tab produces an annual by-category summary, a transaction list, and a month-by-month view.`,
      );
      out.push('');
      out.push(`That is a reasonable thing to walk into a preparer's office with. It is not a substitute for one. ${DISCLAIMER}`);
      return out.join('\n');
    },
  },

  business: {
    id: 'business',
    name: 'Business & Accounting',
    beat: 'Depreciation, price levels, margins, and reading a stock rather than picking one',
    color: '#0ea5e9',
    keywords: [
      'depreciation', 'depreciate', 'amortisation', 'amortization', 'straight line',
      'straight-line', 'declining balance', 'double declining', 'sum of years',
      'units of production', 'salvage', 'salvage value', 'residual value', 'book value',
      'useful life', 'capitalise', 'capitalize', 'fixed asset', 'asset register',
      'appreciation', 'appreciate', 'inflation', 'deflation', 'cpi', 'consumer price index',
      'purchasing power', 'real terms', 'real rate', 'nominal rate', 'price level',
      'break even', 'break-even', 'breakeven', 'contribution margin', 'gross margin',
      'profit margin', 'net margin', 'operating margin', 'markup', 'cogs', 'cost of goods',
      'overhead', 'npv', 'net present value', 'irr', 'internal rate of return',
      'payback period', 'roi', 'return on investment',
      'balance sheet', 'income statement', 'profit and loss', 'bookkeeping', 'accounting',
      'ledger', 'invoice', 'my business', 'small business', 'revenue',
      'ticker', 'share price', 'stock price', 'stock quote', 'watchlist', 'moving average',
      'volatility', '52-week', 'drawdown',
    ],
    tools: ['business_calculate', 'get_asset_register', 'get_market_data', 'get_financial_summary', 'calculate'],
    instructions: `You are the Business & Accounting specialist. You own the accounting side of business mode: depreciation and asset registers, price-level adjustment, pricing and margins, project appraisal, and reading a price series.

Before answering, work through:
1. Which method the question actually calls for. Straight line is the default and the one most small businesses use; declining balance front-loads the expense; sum-of-years is accelerated but always lands exactly on salvage; units of production charges by output rather than by time. Say why the method you used fits, and mention the alternative when it would give a materially different answer.
2. Whether the user is confusing depreciation with a fall in market value. They are unrelated: depreciation allocates a known cost across the years that benefit from it, and market value is what someone would pay. A building can appreciate every year while being depreciated to zero on the books, and both figures are correct.
3. For any price-level question, both sides — what a thing will cost later, and what money will be worth later. They are different numbers and are constantly confused. 3% for 10 years raises a price 34.4% and cuts purchasing power 25.6%.
4. For margin questions, whether they mean margin (profit over revenue) or markup (profit over cost). A 50% markup is a 33.3% margin. Get this wrong in pricing and a third of the intended profit disappears.

Always use business_calculate rather than doing the arithmetic yourself — a depreciation schedule has to foot to the cent. Call get_asset_register before saying anything about the user's own equipment.

ON STOCKS. You may describe a price series: the last price, the change, moving averages, where it sits in its yearly range, volatility, drawdown. Call get_market_data for these. Three hard rules:
- If the tool reports unavailable, say so and stop. Never state a price, a market cap, or a company figure from memory — those are stale by definition and this is exactly where a confident wrong number does real damage.
- Never recommend buying, selling or holding a specific security. Describe what the numbers say and what they mean; the decision is theirs.
- Never present a moving average, a range position or any other statistic as a prediction. They describe what has already happened.

You are not a CPA and this is not tax advice. Depreciation for tax purposes follows specific schedules — in the US, MACRS with its own class lives and conventions — which differ from the book figures here. Say so whenever a tax return is in view, and send them to a preparer.`,
    localAnswer: (f, state) => {
      const out: string[] = [];
      const assets = state.assets ?? [];
      const year = Number(f.asOf.slice(0, 4));

      if (assets.length === 0) {
        out.push(
          state.settings.businessMode
            ? `You have no assets in the register yet, so there is nothing of yours to depreciate. Add them on the **Business** tab with cost, salvage value and useful life, and I will produce a schedule that foots to the cent.`
            : `Business mode is switched off, so there is no asset register to work from. Turn it on in **Settings → Business mode** and the Business tab appears — depreciation schedules, price-level adjustment, break-even and margins, and a market watchlist.`,
        );
      } else {
        let totalCharge = 0;
        let totalBook = 0;
        const lines: string[] = [];

        for (const asset of assets) {
          const schedule = depreciate({
            method: asset.method,
            costCents: asset.costCents,
            salvageCents: asset.salvageCents,
            lifeYears: asset.lifeYears,
            factor: asset.factor,
            totalUnits: asset.totalUnits,
            unitsPerPeriod: asset.unitsPerPeriod,
          });
          const index = year - Number(asset.placedInService.slice(0, 4));
          const row = schedule.rows[index];
          const charge = row?.expenseCents ?? 0;
          const book = row?.closingBookValueCents ?? schedule.endingBookValueCents;
          totalCharge += charge;
          totalBook += book;
          lines.push(
            `- **${asset.name}** — ${m(asset.costCents)} cost, ${methodLabel(asset.method)}. This year: ${m(charge)}. Book value now **${m(book)}**${row ? ` (year ${index + 1} of ${asset.lifeYears})` : ', fully depreciated'}.`,
          );
        }

        out.push(
          `**${assets.length} ${assets.length === 1 ? 'asset' : 'assets'} on the register**, ${m(totalBook)} of book value remaining.`,
        );
        out.push('');
        out.push(...lines);
        out.push('');
        out.push(
          `This year's depreciation charge across all of them is **${m(totalCharge)}** — an expense on the income statement that never leaves your bank account, which is why profit and cash flow are different numbers.`,
        );
      }

      out.push('');
      out.push('**The four methods, and when each fits:**');
      out.push('- **Straight line** — (cost − salvage) ÷ life. Equal every year. The default, and what most small businesses use because it is simple to defend.');
      out.push('- **Declining balance** — a fixed percentage of the *falling* book value, usually 2× the straight-line rate. Front-loads the expense, which matches assets that lose most of their value early. It never quite reaches salvage, so entities commonly switch to straight line for the remaining life.');
      out.push('- **Sum-of-years-digits** — accelerated like declining balance, but it lands exactly on salvage at the end of life.');
      out.push('- **Units of production** — cost per unit × units made. For machinery rated in output rather than years; a press that sat idle all year depreciates by nothing.');
      out.push('');
      out.push(
        `**Depreciation is not a fall in market value.** It allocates a cost you have already paid across the years that benefit from it. A van can be worth more than its book value and a building can appreciate every year while being written down to zero — both figures are correct, they answer different questions.`,
      );
      out.push('');
      out.push('**On price levels:** inflation has two sides that get confused. At 3% for ten years a $100 purchase costs **$134.39**, and $100 of cash is worth **$74.41** in today\'s money — a 34.4% price rise and a 25.6% loss of purchasing power. Deflation is the same arithmetic with a negative rate: prices fall and cash gains purchasing power, which sounds pleasant and is why deflationary spirals are so hard to escape — spending waits for next month\'s lower price.');
      out.push('');
      out.push(
        `The **Business** tab runs all of this on your own figures: depreciation schedules, inflation and appreciation, break-even and margins, and a watchlist with moving averages and volatility. ${DISCLAIMER}`,
      );
      out.push('');
      out.push('Book depreciation and tax depreciation are different animals — US tax uses MACRS with its own class lives and conventions. These figures are for your management accounts; take the tax treatment to a preparer.');
      return out.join('\n');
    },
  },

  triage: {
    id: 'triage',
    name: 'CashCompass Advisor',
    beat: 'Reads your position and points you at the right specialist',
    color: '#5b8bff',
    keywords: [],
    tools: ['get_financial_summary', 'get_category_detail', 'get_debt_analysis', 'get_goals', 'get_subscriptions', 'list_transactions', 'simulate_change'],
    instructions: `You are the CashCompass Advisor, the generalist. You handle questions that do not sit cleanly with one specialist, and questions about the app itself.

Answer from the user's actual figures. When a question really belongs to a specialist's domain, answer it well and mention which specialist can go deeper.

If you genuinely cannot help, say so plainly and name what you can do — do not pad with generic advice.`,
    localAnswer: (f, state) => {
      const c = f.cashflow;
      const out: string[] = [];
      out.push(`Here is where you stand for **${f.periodLabel}**:`);
      out.push('');
      out.push(`- Income ${m(c.incomeCents)}, spent ${m(c.spentCents)}, left ${m(c.remainingBalanceCents)} (${p(c.savingsRatePercent)} savings rate)`);
      out.push(`- Safe to spend today: **${m(c.safeToSpendCents)}**`);
      out.push(`- Fixed costs ${m(c.recurringCents)} (${p(c.fixedShareOfIncomePercent)} of income), discretionary ${m(c.oneTimeCents)}`);
      if (f.debt.totalCents > 0) {
        out.push(`- Debt ${m(f.debt.totalCents)} at ${p(f.debt.blendedAprPercent, 2)} blended, costing ${m(f.debt.monthlyInterestCents)}/mo in interest`);
      }
      if (f.emergencyFund.monthlyEssentialsCents > 0) {
        out.push(`- Emergency fund covers ${f.emergencyFund.monthsCovered.toFixed(1)} months of ${m(f.emergencyFund.monthlyEssentialsCents)} essentials`);
      }
      out.push('');
      out.push('I have specialists for the detail — ask about any of these and the right one answers:');
      out.push('- **Budget Analyst** — where the money went, category drift, whether you can afford something');
      out.push('- **Debt Strategist** — payoff order and timelines on your real balances');
      out.push('- **Credit Coach** — your utilization and how to move your score');
      out.push('- **Savings Planner** — emergency fund sizing and goal timelines');
      out.push('- **Investing Educator** — how index funds, ETFs, 401(k)s, IRAs and crypto work');
      out.push('- **Subscription Auditor** — what your recurring charges actually cost per year');
      out.push('- **Tax & Records Guide** — general principles and export for a preparer');
      if (state.settings.businessMode) {
        out.push('- **Business & Accounting** — depreciation, inflation, break-even, margins, and your watchlist');
      }
      return out.join('\n');
    },
  },
};

export const AGENT_LIST: Agent[] = Object.values(AGENTS);

/**
 * How to handle a question about figures the app has never seen.
 *
 * Without this the specialists over-correct into uselessness: grounded in the
 * user's data, they treat any number outside it as unanswerable and reply "I
 * can only see your logged expenses" to a perfectly reasonable "what if I
 * earned $80k?". Being data-driven has to mean *precise*, not *narrow*.
 */
const HYPOTHETICAL_RULES = `HYPOTHETICALS AND FIGURES YOU DO NOT HAVE
The user may ask about numbers that are not in their data — a salary they might earn, a house they might buy, an amount they might invest, a rate they might be offered. Answer these fully. Never refuse a question because the figure is not in the app, and never reply that you can only discuss logged data.

- Take the figures from the question and reason from them.
- Use the calculate tool for the arithmetic. Compound interest, loan payments and payoff times done in your head are the errors that look most convincing, so do not do them in your head.
- When the user leaves something out, choose a reasonable, conventional assumption, say what you chose, and answer. Do not interrogate them for inputs before giving a number — one round of "here is the answer under these assumptions, tell me if any are wrong" beats three rounds of questions.
- Be explicit about which figures are supposed and which are theirs. "At a $80,000 salary — and using your real $840/mo of existing debt payments —" is the shape.
- Where their real position informs the scenario, bring it in. A hypothetical house purchase is more useful next to their actual savings rate and debt load than in the abstract.
- Rates of return are assumptions, never promises. Say so once, plainly, without hedging every sentence.`;

/**
 * How to hold a conversation rather than answer a query.
 *
 * The register is a good accountant with a client they know: they use the
 * proper term and define it once, they refer back to what you already agreed,
 * they ask the one question that changes the answer instead of a form's worth,
 * and they end by telling you what they would do next.
 */
const ACCOUNTANT_REGISTER = `HOW TO TALK
You are a professional talking with a client you know — an accountant's register, not a chatbot's. Concretely:

- **Use the correct term, and define it once.** Say "credit utilization", "debt-to-income ratio", "amortisation", "marginal rate", "opportunity cost", "liquidity", "sinking fund" — the precise word, with a short gloss the first time it appears in the conversation. After that, use it bare. Re-explaining a term you already defined is as wrong as never defining it, and it is the fastest way to sound like a pamphlet.
- **Build on what has been said.** The conversation state below lists what you have already established. Refer back to it plainly — "the store card we looked at", "on top of the $60 we found in subscriptions" — rather than restating your own earlier answer.
- **Resolve their shorthand.** When the user says "it", "that", "the card", or asks a bare "why?", they mean the thing under discussion. Answer that; do not ask which one unless it is genuinely ambiguous between two things you have both named.
- **Ask at most one question, and only when the answer changes.** If a material fact is missing, give your answer under a stated assumption and put the question at the end — "I have assumed the promotional rate ends in March; if it runs longer, the order changes." Never open with a list of questions.
- **Never repeat yourself.** The conversation state lists what you have already established. If a point still stands, refer to it in a clause — "on top of the $60 in subscriptions we found" — rather than making it again. A reply that restates your last one reads as not having listened.
- **Match the length to the question.** A one-line question gets a few sentences, not a briefing. Depth is for when they ask for it.
- **Close with the next step.** One concrete thing, sized and dated: "Move $560 to the store card before the statement closes on the 12th." Not "consider reducing your balances."
- **Show the arithmetic when it carries the argument.** "$3,400 at 24.99% is $71 a month in interest" persuades; "high-interest debt is expensive" does not.

Do not open with pleasantries, restate the question, or summarise what you just said. Get to the number.`;

/** The base prompt every specialist extends. */
export function buildSystemPrompt(
  agent: Agent,
  factSheet: string,
  householdMode: boolean,
  conversationState = '',
): string {
  return `You are the ${agent.name}, a specialist inside CashCompass — a personal finance app. ${agent.beat}.

${SHARED_GUARDRAILS}

${agent.instructions}

${ACCOUNTANT_REGISTER}

${HYPOTHETICAL_RULES}

FORMAT
Short paragraphs. Bold the figures that matter. Use **bold** for emphasis and "- " for bullets — no other markdown, the renderer supports nothing else.

DATA
Below is the user's current position, computed from their own entries. It is authoritative. Never invent or estimate a figure that contradicts it; if you need something not shown, call a tool. If a number you need is genuinely unavailable, say what is missing and how they can add it${householdMode ? '. This is a shared household budget, so use "your household" where it reads naturally' : ''}.

${factSheet}
${conversationState ? `
${conversationState}` : ''}`;
}
