import type { AppState, Snapshot } from '../types';
import { compareStrategies, formatMonths, totalDebtCents } from './debt';
import { formatMonthShort } from './dates';
import { formatMoney, formatPercent, sumBy } from './money';
import { trend } from './finance';

/**
 * The CashCompass Advisor.
 *
 * The system prompt below is the contract for any model-backed deployment of
 * this assistant. The rest of this file is the offline implementation that ships
 * with the app: a deterministic advisor that answers from the same scope and
 * refuses the same things, so the guardrails hold whether or not a model is
 * wired up behind it.
 */

export const ADVISOR_SYSTEM_PROMPT = `You are the CashCompass Advisor, a financial literacy assistant embedded in
the CashCompass app. You are not a licensed financial advisor, CPA, or
attorney, and you never claim to be one.

WHAT YOU HAVE ACCESS TO
- The user's current income entries, recurring and one-time expenses,
  category breakdown, remaining balance, and safe-to-spend figure.
- Historical spending trends across past months, if available.
- You do NOT have access to full account numbers, SSNs, login credentials,
  or any identifying financial account details — only amounts and categories.

WHAT YOU CAN DO
- Answer questions about budgeting, saving strategies, and building an
  emergency fund.
- Explain legal, well-established methods of building credit: paying on
  time, keeping credit utilization low, becoming an authorized user,
  using secured cards responsibly, and how/when to dispute credit report
  errors.
- Explain general investing concepts and categories (stocks, index funds,
  ETFs, retirement accounts like 401(k)/IRA, crypto) at an educational level:
  what they are, how they generally work, typical risk/return tradeoffs,
  and tax treatment basics.
- Reference the user's own data to personalize explanations, e.g.,
  "Entertainment is 18% of your spending this month — here's how that
  compares to a common budgeting guideline."
- Proactively flag patterns worth the user's attention (e.g., unused
  subscriptions, a category trending up 3 months running).

WHAT YOU MUST NOT DO
- Never recommend buying, selling, or holding a specific security, coin,
  or ticker.
- Never guarantee or imply guaranteed returns on any investment.
- Never give individualized tax or legal advice — explain general
  principles and direct the user to a CPA or attorney for their specific
  situation.
- Never encourage debt strategies that carry outsized risk (e.g., using
  retirement funds or high-interest debt to invest) without clearly
  flagging the risk first.
- Never store or ask for sensitive identifiers (SSN, full account numbers,
  passwords).

TONE
Direct, encouraging, and plain-spoken. Assume the user is capable but may
not have formal financial training — explain jargon the first time it's
used. When discussing volatile assets (crypto especially), name the
volatility clearly rather than softening it.`;

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Strips anything that looks like a sensitive identifier before text reaches
 * the advisor's context or any log.
 *
 * This runs on the way *in*, on the user's own typing, because the cheapest
 * place to not store an SSN is before it is ever written down. The patterns are
 * deliberately broad — a false positive costs a redacted number in a chat
 * transcript, a false negative costs a stored identifier.
 */
export function redactSensitive(text: string): string {
  return text
    // SSN: 123-45-6789 or 123456789 when labelled
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[redacted]')
    .replace(/\b(ssn|social security)\b\D{0,12}\d[\d\s-]{6,}/gi, '$1 [redacted]')
    // Card / account numbers: any run of 12+ digits, and spaced card formats
    .replace(/\b(?:\d[ -]?){12,19}\b/g, '[redacted]')
    .replace(/\b(account|acct|routing|card)\b\D{0,12}\d[\d\s-]{5,}/gi, '$1 [redacted]')
    // Anything self-declared as a credential
    .replace(/\b(password|passcode|pin|login)\b\s*[:=]\s*\S+/gi, '$1 [redacted]');
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * The advisor's entire view of the user: amounts, categories and trends.
 * Nothing here can identify an account — by construction, not by policy.
 */
export interface AdvisorContext {
  totalIncomeCents: number;
  totalSpentCents: number;
  remainingBalanceCents: number;
  safeToSpendCents: number;
  recurringTotalCents: number;
  oneTimeTotalCents: number;
  savingsRatePercent: number;
  topCategories: { name: string; percent: number; spentCents: number }[];
  monthsTracked: number;
  totalDebtCents: number;
  goalCount: number;
  periodLabel: string;
}

export function buildAdvisorContext(state: AppState, snapshot: Snapshot): AdvisorContext {
  const savingsRate =
    snapshot.totalIncomeCents > 0
      ? (snapshot.remainingBalanceCents / snapshot.totalIncomeCents) * 100
      : 0;

  return {
    totalIncomeCents: snapshot.totalIncomeCents,
    totalSpentCents: snapshot.totalSpentCents,
    remainingBalanceCents: snapshot.remainingBalanceCents,
    safeToSpendCents: snapshot.safeToSpendCents,
    recurringTotalCents: snapshot.recurringTotalCents,
    oneTimeTotalCents: snapshot.oneTimeTotalCents,
    savingsRatePercent: savingsRate,
    topCategories: snapshot.categories.slice(0, 5).map((c) => ({
      name: c.name,
      percent: c.percent,
      spentCents: c.spentCents,
    })),
    monthsTracked: new Set(state.expenses.map((e) => (e.date ?? e.createdAt).slice(0, 7))).size,
    totalDebtCents: totalDebtCents(state.debts),
    goalCount: state.goals.length,
    periodLabel: snapshot.period.label,
  };
}

// ---------------------------------------------------------------------------
// Proactive insights
// ---------------------------------------------------------------------------

export type InsightTone = 'positive' | 'neutral' | 'warning';

export interface Insight {
  id: string;
  tone: InsightTone;
  title: string;
  detail: string;
}

/**
 * Patterns worth surfacing without being asked. Ordered by how much they should
 * interrupt: overspending first, then drift, then encouragement.
 */
export function generateInsights(state: AppState, snapshot: Snapshot, reference: string): Insight[] {
  const insights: Insight[] = [];

  // 0. No income logged at all. This has to be checked before the overspend
  // rule, or a user who simply has not set up income yet gets told they are
  // living beyond their means — technically true of the data, useless as advice.
  if (snapshot.totalIncomeCents === 0 && snapshot.totalSpentCents > 0) {
    insights.push({
      id: 'no-income',
      tone: 'warning',
      title: 'No income logged for this period',
      detail: `You have ${formatMoney(
        snapshot.totalSpentCents,
      )} of expenses but no income entries, so every balance on the dashboard reads as negative. Add your income on the Income tab and the numbers will mean something.`,
    });
  }

  // 1. Spending more than you earn.
  if (snapshot.totalIncomeCents > 0 && snapshot.remainingBalanceCents < 0) {
    insights.push({
      id: 'overspend',
      tone: 'warning',
      title: 'Spending is ahead of income this period',
      detail: `You are ${formatMoney(Math.abs(snapshot.remainingBalanceCents))} over. Your fixed costs alone are ${formatMoney(
        snapshot.recurringTotalCents,
      )}, so the fastest lever is usually the one-time spend of ${formatMoney(
        snapshot.oneTimeTotalCents,
      )} rather than the recurring bills.`,
    });
  }

  // 2. Safe-to-spend has gone negative — money is committed that isn't there.
  if (snapshot.safeToSpendCents < 0) {
    insights.push({
      id: 'safe-negative',
      tone: 'warning',
      title: 'Safe-to-spend is negative',
      detail: `Cash on hand is ${formatMoney(snapshot.cashOnHandCents)} but ${formatMoney(
        snapshot.upcomingRecurringCents,
      )} of bills have not landed yet. Anything you spend before your next payday risks an overdraft.`,
    });
  }

  // 3. Category caps breached or close.
  for (const category of snapshot.categories) {
    if (category.capPercent === undefined) continue;
    if (category.capPercent >= 100) {
      insights.push({
        id: `cap-over-${category.categoryId}`,
        tone: 'warning',
        title: `${category.name} is over its cap`,
        detail: `${formatMoney(category.spentCents)} spent against a ${formatMoney(
          category.capCents ?? 0,
        )} cap — ${formatPercent(category.capPercent)} of the limit.`,
      });
    } else if (category.capPercent >= 80) {
      insights.push({
        id: `cap-near-${category.categoryId}`,
        tone: 'neutral',
        title: `${category.name} is near its cap`,
        detail: `${formatPercent(category.capPercent)} of your ${formatMoney(
          category.capCents ?? 0,
        )} cap used, with ${formatMoney((category.capCents ?? 0) - category.spentCents)} left.`,
      });
    }
  }

  // 4. A category climbing three months running.
  for (const rising of risingCategories(state, reference)) {
    insights.push({
      id: `rising-${rising.categoryId}`,
      tone: 'neutral',
      title: `${rising.name} has risen three months running`,
      detail: `${formatMoney(rising.firstCents)} → ${formatMoney(rising.lastCents)} since ${formatMonthShort(
        rising.fromCycle,
      )}. Worth a look at whether that is a deliberate change.`,
    });
  }

  // 5. Subscription load.
  const subs = state.expenses.filter(
    (e) => e.categoryId === 'subscriptions' && e.recurrence === 'recurring' && e.active,
  );
  if (subs.length >= 3) {
    const monthly = sumBy(subs, (s) => s.amountCents);
    insights.push({
      id: 'subs',
      tone: 'neutral',
      title: `${subs.length} active subscriptions`,
      detail: `${formatMoney(monthly)} a month, ${formatMoney(
        monthly * 12,
      )} a year. Subscriptions are the classic place money leaks quietly — worth checking which of these you used in the last 30 days.`,
    });
  }

  // 6. No emergency fund goal.
  if (state.goals.length === 0 && snapshot.remainingBalanceCents > 0) {
    insights.push({
      id: 'no-goal',
      tone: 'neutral',
      title: 'Nothing claimed on your leftover money',
      detail: `You have ${formatMoney(
        snapshot.remainingBalanceCents,
      )} projected left over and no savings goal set. Money without a job attached tends to get spent.`,
    });
  }

  // 7. Healthy savings rate — worth saying out loud.
  const savingsRate =
    snapshot.totalIncomeCents > 0
      ? (snapshot.remainingBalanceCents / snapshot.totalIncomeCents) * 100
      : 0;
  if (savingsRate >= 20) {
    insights.push({
      id: 'good-rate',
      tone: 'positive',
      title: `You are keeping ${formatPercent(savingsRate)} of your income`,
      detail:
        'A common guideline puts 20% toward saving and debt payoff. You are at or above it this period — the useful next question is where that money goes rather than whether it exists.',
    });
  }

  // 8. Fixed costs eating the budget.
  if (snapshot.totalIncomeCents > 0) {
    const fixedShare = (snapshot.recurringTotalCents / snapshot.totalIncomeCents) * 100;
    if (fixedShare > 65) {
      insights.push({
        id: 'fixed-heavy',
        tone: 'warning',
        title: `Fixed costs are ${formatPercent(fixedShare)} of your income`,
        detail:
          'When recurring bills take this much, small discretionary cuts cannot move the needle much — the lever is usually one of the big fixed lines (housing, auto, insurance) rather than day-to-day spending.',
      });
    }
  }

  const order: Record<InsightTone, number> = { warning: 0, neutral: 1, positive: 2 };
  return insights.sort((a, b) => order[a.tone] - order[b.tone]);
}

interface RisingCategory {
  categoryId: string;
  name: string;
  firstCents: number;
  lastCents: number;
  fromCycle: string;
}

/** Categories that increased in each of the last three complete months. */
function risingCategories(state: AppState, reference: string): RisingCategory[] {
  const points = trend(state, reference, 4);
  if (points.length < 4) return [];
  // Drop the current, incomplete month — a partial month always looks like a drop.
  const complete = points.slice(0, 3);
  const out: RisingCategory[] = [];

  for (const category of state.categories) {
    const series = complete.map((p) => p.byCategory[category.id] ?? 0);
    const [a, b, c] = series;
    if (a === undefined || b === undefined || c === undefined) continue;
    if (a > 0 && b > a && c > b) {
      out.push({
        categoryId: category.id,
        name: category.name,
        firstCents: a,
        lastCents: c,
        fromCycle: complete[0]!.cycleKey,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Monthly recap
// ---------------------------------------------------------------------------

export interface Recap {
  cycleKey: string;
  incomeCents: number;
  spentCents: number;
  netCents: number;
  biggestCategory: { name: string; spentCents: number } | null;
  biggestChange: { name: string; deltaCents: number } | null;
  tip: string;
}

/** The month-end summary: what came in, what went out, what changed, one thing to do. */
export function buildRecap(state: AppState, cycleKeyOfMonth: string, snapshot: Snapshot): Recap {
  const points = trend(state, `${cycleKeyOfMonth}-28`, 2);
  const thisMonth = points[points.length - 1];
  const lastMonth = points.length > 1 ? points[points.length - 2] : undefined;

  let biggestChange: Recap['biggestChange'] = null;
  if (thisMonth && lastMonth) {
    for (const category of state.categories) {
      const delta = (thisMonth.byCategory[category.id] ?? 0) - (lastMonth.byCategory[category.id] ?? 0);
      if (!biggestChange || Math.abs(delta) > Math.abs(biggestChange.deltaCents)) {
        biggestChange = { name: category.name, deltaCents: delta };
      }
    }
  }

  const top = snapshot.categories[0] ?? null;

  return {
    cycleKey: cycleKeyOfMonth,
    incomeCents: snapshot.totalIncomeCents,
    spentCents: snapshot.totalSpentCents,
    netCents: snapshot.remainingBalanceCents,
    biggestCategory: top ? { name: top.name, spentCents: top.spentCents } : null,
    biggestChange,
    tip: recapTip(state, snapshot),
  };
}

function recapTip(state: AppState, snapshot: Snapshot): string {
  if (snapshot.remainingBalanceCents < 0) {
    return 'You spent more than you brought in this month. Before cutting anything, look at the one-time list — that is usually where an unusual month hides, and it does not require changing your fixed costs.';
  }
  if (state.goals.length === 0) {
    return 'Set one savings goal — even a small emergency fund target. Leftover money with a name attached is much more likely to still be there next month.';
  }
  if (state.debts.length > 0) {
    const comparison = compareStrategies(state.debts, Math.max(0, snapshot.remainingBalanceCents));
    if (comparison.interestSavedCents > 0) {
      return `Putting your leftover ${formatMoney(
        Math.max(0, snapshot.remainingBalanceCents),
      )} toward the highest-rate debt first would clear everything in ${formatMonths(
        comparison.avalanche.months,
      )} and pay ${formatMoney(comparison.interestSavedCents)} less interest than paying smallest-balance-first.`;
    }
  }
  const top = snapshot.categories[0];
  if (top && top.percent > 30) {
    return `${top.name} took ${formatPercent(top.percent)} of your spending. That is not automatically wrong, but a single category above 30% is worth a deliberate yes rather than a default.`;
  }
  return 'Nothing alarming this month. The highest-value habit from here is logging expenses the day they happen — the numbers only guide you if they are current.';
}

// ---------------------------------------------------------------------------
// Conversational advisor
// ---------------------------------------------------------------------------

export interface AdvisorReply {
  text: string;
  /** Set when the reply declined something the guardrails forbid. */
  refused?: boolean;
}

const DISCLAIMER =
  'I am a financial literacy assistant, not a licensed advisor, CPA or attorney — for decisions specific to your situation, talk to a licensed professional.';

/**
 * Requests for a specific security recommendation. Matching on intent rather
 * than on a ticker list, since no list stays current and the rule is about the
 * kind of question, not the asset.
 */
const SPECIFIC_SECURITY = /\b(should i|shall i|worth|do you recommend|would you)\b.{0,40}\b(buy|sell|hold|invest in|get into|put money (in|into))\b/i;
const NAMED_ASSET = /\b(bitcoin|btc|ethereum|eth|dogecoin|tesla|tsla|apple|aapl|nvidia|nvda|gme|amc|spy|qqq|voo|vti|\$[a-z]{1,5}\b)/i;
const GUARANTEE = /\b(guarantee|guaranteed|risk[- ]free|sure thing|can't lose|cant lose)\b/i;
const INDIVIDUAL_TAX_LEGAL = /\b(my|our)\b.{0,30}\b(taxes|tax return|deduction|write[- ]?off|audit|will|trust|lawsuit|bankruptcy)\b/i;

export function askAdvisor(question: string, ctx: AdvisorContext, state: AppState): AdvisorReply {
  const clean = redactSensitive(question);
  const q = clean.toLowerCase();

  // --- Guardrails first, before any topic matching. ---

  if (SPECIFIC_SECURITY.test(q) && NAMED_ASSET.test(q)) {
    return {
      refused: true,
      text: `I will not tell you whether to buy, sell or hold a specific security or coin — that is individualized investment advice, and I am not licensed to give it.

What I can do is explain the category it belongs to. If it is an individual stock or a single cryptocurrency, the general point is concentration: your outcome depends on one company or one protocol rather than on a broad market. Crypto in particular is genuinely volatile — drawdowns of 50–80% have happened repeatedly, and there is no earnings stream underneath most of it. That is a description of the risk, not a prediction.

If you want, ask me how index funds, ETFs or retirement accounts work instead, and I will go into detail. ${DISCLAIMER}`,
    };
  }

  if (GUARANTEE.test(q)) {
    return {
      refused: true,
      text: `There is no guaranteed return on an investment, and I will not imply otherwise. The closest things to it are FDIC-insured deposits (savings accounts, CDs) and Treasury securities, which are backed by the issuer rather than by market performance — and even those are only "safe" in nominal terms, since inflation can still erode what the money buys.

Anything offering a guaranteed above-market return is either mispriced or misrepresented. ${DISCLAIMER}`,
    };
  }

  if (INDIVIDUAL_TAX_LEGAL.test(q)) {
    return {
      refused: true,
      text: `That is a question about your specific tax or legal situation, and getting it wrong is expensive — so I will not answer it directly. A CPA or an attorney can, and for anything involving a return you have already filed, a trust, or a dispute, it is worth the fee.

What I can do is explain the general principle behind it. Ask me how a category of account is generally taxed, or what a term means, and I will go into it. ${DISCLAIMER}`,
    };
  }

  // --- Topic matching. ---

  for (const topic of TOPICS) {
    if (topic.match.test(q)) return { text: topic.answer(ctx, state) };
  }

  return { text: fallbackAnswer(ctx) };
}

interface Topic {
  match: RegExp;
  answer: (ctx: AdvisorContext, state: AppState) => string;
}

/**
 * Builds a keyword matcher that tolerates the usual English endings.
 *
 * Matching `\bindex fund\b` against "index funds" fails — the trailing `\b`
 * needs a non-word character and finds an "s". Every keyword here would need
 * hand-written plurals otherwise, and the ones that got missed would silently
 * fall through to the generic answer, which is the worst kind of bug in an
 * assistant: it looks like it is working.
 */
function kw(...terms: string[]): RegExp {
  return new RegExp(`\\b(?:${terms.join('|')})(?:s|es|ing|ed)?\\b`, 'i');
}

const TOPICS: Topic[] = [
  {
    match: kw('safe.to.spend', 'safe to spend', 'how much can i spend'),
    answer: (ctx) =>
      `Your safe-to-spend is ${formatMoney(ctx.safeToSpendCents)}, against a remaining balance of ${formatMoney(
        ctx.remainingBalanceCents,
      )}.

The two differ on purpose. Remaining balance is the projection: all your income for ${ctx.periodLabel}, minus every expense in it, including bills that have not hit yet. Safe-to-spend is the realistic version — it counts only money you have actually received, subtracts what you have actually spent, then holds back the bills still to land and anything reserved for goals.

Spend against the safe-to-spend number. The remaining balance is what the month should look like if nothing changes; safe-to-spend is what you can act on today.`,
  },
  {
    match: kw('emergency fund', 'rainy day', 'safety net'),
    answer: (ctx) => {
      const monthlyFixed = ctx.recurringTotalCents;
      const three = monthlyFixed * 3;
      const six = monthlyFixed * 6;
      return `An emergency fund is cash set aside for the things that break the budget — a job loss, a medical bill, a car repair — held somewhere you can reach it in a day or two, not invested.

The common target is three to six months of *essential* expenses, not of income. Your recurring costs run ${formatMoney(
        monthlyFixed,
      )} a month, which puts the range at roughly ${formatMoney(three)} to ${formatMoney(six)}.

That number is intimidating on purpose-built spreadsheets and much less so in practice: the first ${formatMoney(
        100000,
      )} does most of the work, because it covers the ordinary emergencies that would otherwise go on a credit card. Start there, then build.

Where to keep it: a high-yield savings account or money market account. The point is that the balance does not move when the market does. ${DISCLAIMER}`;
    },
  },
  {
    match: kw('credit score', 'build credit', 'credit history', 'utilization', 'fico'),
    answer: () =>
      `Credit scores are built from five inputs, and only two of them move quickly:

**Payment history (~35%)** — the single biggest factor. One payment 30+ days late does real, lasting damage. Autopay the minimum on everything, then pay more manually; that way a forgetful month costs you interest instead of your score.

**Utilization (~30%)** — your balance divided by your limit, on each card and overall. Under 30% is the usual advice, under 10% is better. This one resets monthly, so it is the fastest lever you have: paying a card down before the statement closes (not the due date) is what the bureau sees.

**Age of accounts (~15%)** — why closing your oldest card usually hurts. Leave it open with a small recurring charge on it.

**Credit mix (~10%)** and **new inquiries (~10%)** — minor. Do not open accounts chasing these.

Legitimate ways to build from a thin file: become an **authorized user** on someone's established, well-managed card (their history can report on your file); use a **secured card**, where your deposit becomes the limit, and graduate to an unsecured one; and a **credit-builder loan** from a credit union.

If something on your report is wrong, you can dispute it free with each bureau directly — you are entitled to that, and the bureau has 30 days to investigate. Avoid anyone charging a fee to "repair" credit by disputing accurate entries; that does not work and the accurate items come back. ${DISCLAIMER}`,
  },
  {
    match: kw('index fund', 'etf', 'mutual fund', 's&p', 'diversif\\w*'),
    answer: () =>
      `An **index fund** holds every company in a defined list — say, the 500 largest US public companies — in proportion to their size, rather than trying to pick winners. An **ETF** is the same idea in a wrapper that trades on an exchange like a stock. For most purposes the difference between them is mechanical, not strategic.

Why they come up constantly in financial education:

- **Diversification.** One company failing is a rounding error rather than an event. You are betting on the market, not on management.
- **Cost.** Index funds commonly charge 0.03–0.20% a year; actively managed funds often charge 0.5–1%+. That gap compounds against you every year, and the long-run evidence is that most active managers do not beat their index after fees.
- **Boring by design.** There is nothing to do after you buy, which removes the main way people lose money — trading on how they feel about the news.

What they do not do: protect you from the market falling. A broad index fund dropped roughly 50% in 2008 and recovered over the following years. The diversification is across companies, not across time.

I will not name specific funds or tickers. Fund families publish their expense ratios and holdings, and that is the comparison that matters. ${DISCLAIMER}`,
  },
  {
    match: kw('401k', '401\\(k\\)', 'ira', 'roth', 'retirement', 'pension'),
    answer: () =>
      `Retirement accounts are ordinary investments inside a tax wrapper. The wrapper is the whole point.

**401(k)** — offered through an employer. Contributions come out of your paycheck pre-tax (traditional) so they lower this year's taxable income, and you pay ordinary income tax on withdrawals in retirement. Many employers **match** some percentage of what you put in. A match is the one thing in personal finance that behaves like free money — it is part of your compensation, and not contributing enough to get the full match leaves salary on the table.

**Traditional IRA** — same tax shape as a traditional 401(k), opened by you rather than your employer, with lower contribution limits and deductibility that phases out at higher incomes.

**Roth IRA / Roth 401(k)** — the mirror image. You contribute money you have already paid tax on, it grows untaxed, and qualified withdrawals in retirement are tax-free. Roth tends to favour people who expect to be in a higher tax bracket later; traditional favours the reverse.

The general rule of thumb you will see: contribute enough to get the full employer match, then build an emergency fund and clear high-interest debt, then come back and contribute more.

Early withdrawals before 59½ generally trigger income tax plus a 10% penalty, with specific exceptions. Contribution limits and income phase-outs change annually — check the current IRS figures rather than trusting a number you read once. For how any of this lands on *your* return, that is a CPA question. ${DISCLAIMER}`,
  },
  {
    match: kw('crypto\\w*', 'bitcoin', 'blockchain', 'coin', 'token', 'nft'),
    answer: () =>
      `Cryptocurrency is a genuinely volatile asset class, and I would rather name that plainly than soften it: major coins have lost 50–80% of their value more than once, and individual tokens have gone to zero. Those are not tail scenarios, they are the recent record.

What it is, structurally: a digital asset recorded on a distributed ledger, with no cash flows underneath it. A stock represents a claim on a company's earnings; a bond pays interest. Most crypto has neither, so its price is set entirely by what the next buyer will pay. That is not a moral judgement — it is why the price moves the way it does.

Things worth knowing before any of it matters:

- **Custody.** "Not your keys, not your coins" is about exchange failure, which has happened repeatedly and at scale. Self-custody moves the risk to you losing the keys.
- **Tax treatment.** In the US, crypto is generally treated as property, so selling or *trading one coin for another* is a taxable event. People are routinely surprised by this. The specifics are a CPA question.
- **Position sizing.** The standard educational framing is to hold no more than you could watch go to zero without it changing your plans.

I will not tell you whether to buy any particular coin. ${DISCLAIMER}`,
  },
  {
    match: kw('debt', 'pay ?off', 'snowball', 'avalanche', 'credit card debt', 'loan'),
    answer: (ctx, state) => {
      if (state.debts.length === 0) {
        return `You have no debts logged, so I will keep this general.

Two standard payoff orders, both of which pay every minimum and put every spare dollar toward one target:

**Avalanche** — highest interest rate first. This is mathematically optimal; it always pays the least total interest.

**Snowball** — smallest balance first. It costs more in interest, but it clears individual debts sooner, and the evidence on follow-through is that people stick with it more often. A plan you abandon is worse than a slightly costlier one you finish.

The gap between them is usually small when balances are similar and large when one debt carries a much higher rate. Add your debts on the Debt tab and I can show you the actual difference in your case.

One thing worth flagging: borrowing to invest, or pulling from retirement accounts to pay down debt, carries real risk — early-withdrawal penalties and lost compounding on one side, leverage on the other. Neither is a default move. ${DISCLAIMER}`;
      }
      const extra = Math.max(0, ctx.remainingBalanceCents);
      const comparison = compareStrategies(state.debts, extra);
      const total = formatMoney(ctx.totalDebtCents);
      if (comparison.avalanche.impossible) {
        return `You have ${total} in logged debt, and at your current leftover of ${formatMoney(
          extra,
        )} a month on top of the minimums, the projection does not reach zero — the interest is keeping pace with the payments.

That is the signal to change the inputs rather than the strategy: increasing the monthly payment, or reducing the rate through a balance transfer or consolidation loan, moves this far more than payment ordering does. A non-profit credit counselling agency (the NFCC is the usual starting point) can help without charging for it.

Be careful with balance-transfer offers — the promotional rate ends, and the deferred interest terms on some cards apply retroactively. ${DISCLAIMER}`;
      }
      return `You have ${total} in logged debt across ${state.debts.length} ${
        state.debts.length === 1 ? 'account' : 'accounts'
      }. Using your projected leftover of ${formatMoney(extra)} a month as the extra payment:

**Avalanche** (highest rate first): clear in ${formatMonths(
        comparison.avalanche.months,
      )}, paying ${formatMoney(comparison.avalanche.totalInterestCents)} in interest.
**Snowball** (smallest balance first): clear in ${formatMonths(
        comparison.snowball.months,
      )}, paying ${formatMoney(comparison.snowball.totalInterestCents)} in interest.

The avalanche saves you ${formatMoney(comparison.interestSavedCents)}. Whether that is worth it depends on you: the snowball's argument is that clearing a whole account early is motivating, and people finish it more often. If ${formatMoney(
        comparison.interestSavedCents,
      )} is not enough to override that, snowball is a defensible choice — the worst plan is the one you stop following.

Either way, the minimums go on autopay first. A missed payment costs more in score damage than the strategy difference does in interest. ${DISCLAIMER}`;
    },
  },
  {
    match: kw('budget', '50/30/20', '50 30 20', 'how much should i spend', 'guideline', 'rule of thumb'),
    answer: (ctx) => {
      const income = ctx.totalIncomeCents;
      if (income <= 0) {
        return `The most-cited starting framework is **50/30/20**: about 50% of take-home pay to needs (housing, utilities, groceries, insurance, minimum debt payments), 30% to wants, 20% to saving and extra debt payoff.

Add your income on the Income tab and I will run your actual numbers against it.

Treat it as a diagnostic rather than a rule. In an expensive housing market the 50% needs bucket is often unreachable, and that tells you something useful — that the pressure is structural, not a matter of discipline about coffee.`;
      }
      const fixed = ctx.recurringTotalCents;
      const fixedPct = (fixed / income) * 100;
      const savePct = (ctx.remainingBalanceCents / income) * 100;
      return `The usual starting framework is **50/30/20** — roughly 50% of take-home pay to needs, 30% to wants, 20% to saving and extra debt payoff.

Against your ${ctx.periodLabel}:

- Income: ${formatMoney(income)}
- Recurring/fixed: ${formatMoney(fixed)} — ${formatPercent(fixedPct)}
- One-time/discretionary: ${formatMoney(ctx.oneTimeTotalCents)} — ${formatPercent(
        (ctx.oneTimeTotalCents / income) * 100,
      )}
- Left over: ${formatMoney(ctx.remainingBalanceCents)} — ${formatPercent(savePct)}

${
  fixedPct > 50
    ? `Your fixed costs are above the 50% guideline. That is worth understanding rather than feeling bad about: when housing and transport are the cause, no amount of trimming discretionary spend closes the gap, and the real options are larger ones — housing costs, transport costs, or income.`
    : `Your fixed costs are inside the 50% guideline, which means you have genuine room to direct — the discretionary side is where your choices actually show up.`
}

${
  savePct >= 20
    ? 'Your leftover clears the 20% mark. The next question is where it goes, since money without a destination has a way of finding one.'
    : `You are keeping ${formatPercent(savePct)}, below the 20% guideline. The gap to close is ${formatMoney(
        Math.round(income * 0.2) - ctx.remainingBalanceCents,
      )} a month.`
}`;
    },
  },
  {
    match: kw('save', 'saving', 'savings rate', 'goal'),
    answer: (ctx) =>
      `You are keeping ${formatPercent(ctx.savingsRatePercent)} of your income this period — ${formatMoney(
        ctx.remainingBalanceCents,
      )} out of ${formatMoney(ctx.totalIncomeCents)}.

Three things that move a savings rate more than willpower does:

**Make it automatic and early.** A transfer on payday, before the money is available to spend, works because it removes the monthly decision. Saving whatever is left at month-end almost never works, since there is rarely anything left.

**Attack the fixed costs, not the small ones.** Your recurring bills are ${formatMoney(
        ctx.recurringTotalCents,
      )} a month. A single successful renegotiation — insurance, phone plan, a subscription you dropped — repeats every month for free. Skipping a coffee does not.

**Give the money a name.** A goal labelled "emergency fund" survives a tempting weekend in a way that "leftover" does not. That is not a trick, it is just that unlabelled money reads as available.

Set targets on the Goals tab, and turn on the reserve toggle to hold that money back from your safe-to-spend figure so it stops showing up as available.`,
  },
  {
    match: kw('subscription', 'recurring charge', 'streaming'),
    answer: (_ctx, state) => {
      const subs = state.expenses.filter(
        (e) => e.categoryId === 'subscriptions' && e.recurrence === 'recurring' && e.active,
      );
      if (subs.length === 0) {
        return 'You have no subscriptions logged under that category. If you are paying for any, adding them as recurring expenses is worthwhile — subscriptions are the most common place money leaks, precisely because each one is individually too small to notice.';
      }
      const monthly = sumBy(subs, (s) => s.amountCents);
      const list = subs
        .slice()
        .sort((a, b) => b.amountCents - a.amountCents)
        .map((s) => `- ${s.name} — ${formatMoney(s.amountCents)}/mo (${formatMoney(s.amountCents * 12)}/yr)`)
        .join('\n');
      return `You have ${subs.length} active subscriptions totalling ${formatMoney(
        monthly,
      )} a month — ${formatMoney(monthly * 12)} a year:

${list}

The question that actually decides these is not "is this worth $12" but "did I use it in the last 30 days, and would I re-subscribe today at this price". Anything that fails both is a cancellation.

Annual renewals are the ones to watch: they are easy to forget and often auto-renew at a higher rate than you first paid.`;
    },
  },
  {
    match: kw('net worth', 'asset', 'liabilit\\w*'),
    answer: () =>
      `Net worth is everything you own minus everything you owe. It is the one number that captures whether you are actually getting ahead, because cash flow can look fine while debt quietly grows.

Count as **assets**: cash and savings, investment and retirement balances, the market value of a home or car. Count as **liabilities**: mortgage, student loans, auto loans, credit card balances, anything financed.

Two things about it are worth internalising. First, a negative net worth is normal and not a verdict — a new graduate with student loans is usually there, and the trajectory matters far more than the level. Second, track it quarterly rather than monthly. Measured too often, it mostly reports market noise back to you, and reacting to that is how people sell at the wrong time.

The Net Worth tab takes manual snapshots so you can watch the direction.`,
  },
  {
    match: kw('tax', 'deduction', 'write ?off', '1099', 'w-?2'),
    answer: () =>
      `I will keep this to general principles — anything about your own return is a CPA question, and the cost of a wrong answer there is higher than the fee.

The broad shapes worth knowing:

- **Marginal rates.** Moving into a higher bracket taxes the dollars *above* the threshold at the higher rate, not your whole income. "A raise pushed me into a higher bracket so I take home less" is essentially always a misunderstanding.
- **Deductions vs. credits.** A deduction reduces the income you are taxed on; a credit reduces the tax itself. A $1,000 credit is worth far more than a $1,000 deduction.
- **Pre-tax vs. Roth.** Traditional retirement contributions lower this year's taxable income and are taxed on withdrawal; Roth is the reverse.
- **Self-employment.** 1099 income generally carries self-employment tax on top of income tax, and usually requires quarterly estimated payments. Setting aside a fixed percentage of every payment as it arrives is the habit that prevents an unpleasant April.

The Export tab produces an annual by-category summary, which is a reasonable starting point for a conversation with a preparer — not a substitute for one. ${DISCLAIMER}`,
  },
  {
    match: kw('stock', 'invest\\w*', 'market', 'compound\\w*', 'bond'),
    answer: () =>
      `A quick map of the categories, without recommending anything specific:

**Stocks** — partial ownership of a company. Highest long-run returns historically, and the largest swings. Individual stocks concentrate your outcome in one company's fate.

**Bonds** — lending money at interest, to a government or a company. Steadier than stocks, lower expected return. Bond prices fall when interest rates rise, which surprises people who expect "safe" to mean "flat".

**Funds (index funds, ETFs, mutual funds)** — a basket of many holdings in one purchase. The standard way to own a broad market without picking anything.

**Cash equivalents** — savings accounts, money market funds, CDs, Treasury bills. Principal is stable; inflation still erodes purchasing power.

The mechanism underneath all of it is **compounding**: returns earning returns. It is unremarkable over one year and decisive over thirty, which is why time in the market gets more attention than timing it.

Two framings that hold up: your **time horizon** should drive how much risk you carry, since money you need in two years should not be in stocks; and **risk and return are linked**, so anything promising high returns at low risk is misdescribing one of the two. ${DISCLAIMER}`,
  },
  {
    match: /\b(where.{0,15}money go|spending breakdown|what did i spend|biggest expense)/i,
    answer: (ctx) => {
      if (ctx.topCategories.length === 0) {
        return 'You have no expenses logged for this period yet. Add a few and I can break down where the money is going.';
      }
      const list = ctx.topCategories
        .map((c) => `- **${c.name}** — ${formatMoney(c.spentCents)} (${formatPercent(c.percent)})`)
        .join('\n');
      const top = ctx.topCategories[0]!;
      return `For ${ctx.periodLabel} you have spent ${formatMoney(ctx.totalSpentCents)}. The largest categories:

${list}

${top.name} leads at ${formatPercent(top.percent)}. Your split between fixed and discretionary is ${formatMoney(
        ctx.recurringTotalCents,
      )} recurring against ${formatMoney(ctx.oneTimeTotalCents)} one-time — the recurring figure is your real cost of living, and the one that determines how much income you need to break even.

Tap any slice on the dashboard to see the individual transactions behind it.`;
    },
  },
  {
    match: kw('what can you do', 'help', 'how do you work', 'who are you'),
    answer: () =>
      `I am the CashCompass Advisor — a financial literacy assistant built into the app. I can see your amounts and categories: income, expenses, balances, and trends over past months. I cannot see account numbers, your SSN, or any login details, and I will not ask for them.

Things I am useful for:

- Budgeting, savings rate, and emergency funds
- How credit scores actually work, and legitimate ways to build credit
- What index funds, ETFs, 401(k)s, IRAs and crypto *are*, and how they generally behave
- Reading your own numbers back to you — where the money went, what changed, what is trending
- Debt payoff strategies, with your real balances

Things I will not do: recommend a specific stock or coin, imply any return is guaranteed, or give advice about your particular tax or legal situation. Those need a licensed professional, and I am not one.`,
  },
];

function fallbackAnswer(ctx: AdvisorContext): string {
  return `I am not sure I have a good answer for that one specifically, so here is where you stand for ${ctx.periodLabel}:

- Income: ${formatMoney(ctx.totalIncomeCents)}
- Spent: ${formatMoney(ctx.totalSpentCents)}
- Remaining balance: ${formatMoney(ctx.remainingBalanceCents)}
- Safe-to-spend: ${formatMoney(ctx.safeToSpendCents)}

I can go into detail on budgeting and the 50/30/20 guideline, emergency funds, how credit scores are calculated and how to build credit, debt payoff strategies, subscriptions, net worth, or how index funds, ETFs, 401(k)s, IRAs and crypto work. Ask about any of those and I will use your actual numbers.`;
}

/** Question chips offered in the advisor UI. */
export const SUGGESTED_QUESTIONS = [
  'Where did my money go this month?',
  'How much should I have in an emergency fund?',
  'How do I build my credit score?',
  'Am I saving enough?',
  'Explain index funds and ETFs',
  'Should I use snowball or avalanche for my debt?',
  'How do 401(k)s and IRAs work?',
  'What is safe-to-spend?',
];
