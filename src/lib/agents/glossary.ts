/**
 * The vocabulary an accountant uses with a client.
 *
 * Two jobs. First, it lets the advisor name things properly instead of talking
 * around them — "your debt-to-income ratio is 31%" is a different quality of
 * answer from "you owe a fair amount relative to what you earn". Second, it
 * makes terminology *stateful*: a term is defined the first time it appears in
 * a conversation and then used as shorthand, which is how a professional
 * actually talks. Re-explaining "utilization" in every reply is as wrong as
 * never explaining it.
 */

export interface Term {
  id: string;
  /** The canonical form the advisor should use. */
  label: string;
  /** Other spellings that count as the same term when scanning a transcript. */
  aliases: string[];
  /** One clause, suitable for an inline parenthetical on first use. */
  short: string;
}

export const GLOSSARY: Term[] = [
  {
    id: 'utilization',
    label: 'credit utilization',
    aliases: ['utilization', 'utilisation', 'credit utilisation'],
    short: 'the share of a credit limit you are using',
  },
  {
    id: 'dti',
    label: 'debt-to-income ratio',
    aliases: ['dti', 'debt to income', 'debt-to-income'],
    short: 'monthly debt payments as a share of gross monthly income',
  },
  {
    id: 'apr',
    label: 'APR',
    aliases: ['apr', 'annual percentage rate'],
    short: 'the yearly cost of borrowing, including fees',
  },
  {
    id: 'apy',
    label: 'APY',
    aliases: ['apy', 'annual percentage yield'],
    short: 'the yearly return on savings once compounding is counted',
  },
  {
    id: 'amortization',
    label: 'amortisation',
    aliases: ['amortization', 'amortisation', 'amortize', 'amortise'],
    short: 'paying a loan down on a fixed schedule, interest first',
  },
  {
    id: 'principal',
    label: 'principal',
    aliases: ['principal'],
    short: 'the amount borrowed, separate from the interest on it',
  },
  {
    id: 'marginal-rate',
    label: 'marginal tax rate',
    aliases: ['marginal rate', 'marginal tax', 'tax bracket', 'bracket'],
    short: 'the rate on your next dollar, not on all of them',
  },
  {
    id: 'effective-rate',
    label: 'effective tax rate',
    aliases: ['effective rate', 'effective tax'],
    short: 'total tax divided by total income',
  },
  {
    id: 'accrual-vs-cash',
    label: 'accrual vs. cash basis',
    aliases: ['accrual', 'cash basis', 'accrual basis'],
    short: 'counting money when it is committed versus when it actually moves',
  },
  {
    id: 'fixed-cost',
    label: 'fixed costs',
    aliases: ['fixed cost', 'fixed costs', 'recurring baseline'],
    short: 'the bills that arrive whether or not you do anything',
  },
  {
    id: 'discretionary',
    label: 'discretionary spending',
    aliases: ['discretionary', 'variable spending'],
    short: 'the spending you actually decide on each month',
  },
  {
    id: 'liquidity',
    label: 'liquidity',
    aliases: ['liquidity', 'liquid'],
    short: 'how fast money can be reached without a loss',
  },
  {
    id: 'runway',
    label: 'runway',
    aliases: ['runway', 'burn rate'],
    short: 'how long your cash covers essentials with no income',
  },
  {
    id: 'sinking-fund',
    label: 'sinking fund',
    aliases: ['sinking fund'],
    short: 'money set aside monthly for a known future cost',
  },
  {
    id: 'opportunity-cost',
    label: 'opportunity cost',
    aliases: ['opportunity cost'],
    short: 'the best thing the same money could have done instead',
  },
  {
    id: 'compounding',
    label: 'compounding',
    aliases: ['compound', 'compounding', 'compound interest'],
    short: 'returns earning returns on themselves',
  },
  {
    id: 'expense-ratio',
    label: 'expense ratio',
    aliases: ['expense ratio', 'management fee'],
    short: "the annual percentage a fund charges you",
  },
  {
    id: 'revolving',
    label: 'revolving credit',
    aliases: ['revolving', 'revolving credit', 'revolving debt'],
    short: 'a balance you can carry and re-borrow, like a card',
  },
  {
    id: 'installment',
    label: 'instalment debt',
    aliases: ['installment', 'instalment', 'term loan'],
    short: 'a fixed balance on a fixed payoff schedule, like a car note',
  },
  {
    id: 'deferred-interest',
    label: 'deferred interest',
    aliases: ['deferred interest'],
    short: 'promotional interest that is charged retroactively if you miss the deadline',
  },
  {
    id: 'savings-rate',
    label: 'savings rate',
    aliases: ['savings rate', 'saving rate'],
    short: 'the share of income you keep',
  },
  {
    id: 'safe-to-spend',
    label: 'safe-to-spend',
    aliases: ['safe to spend', 'safe-to-spend'],
    short: 'cash on hand once the bills still to land are held back',
  },
  {
    id: 'avalanche',
    label: 'the avalanche method',
    aliases: ['avalanche'],
    short: 'paying the highest interest rate first',
  },
  {
    id: 'snowball',
    label: 'the snowball method',
    aliases: ['snowball'],
    short: 'paying the smallest balance first',
  },
];

const BY_ID = new Map(GLOSSARY.map((term) => [term.id, term]));

export function getTerm(id: string): Term | undefined {
  return BY_ID.get(id);
}

/**
 * Which glossary terms appear in a piece of text.
 *
 * Used on both sides of a turn: on the answer, to record what has now been
 * introduced; on the question, to tell whether the user is picking up a term
 * the advisor used earlier.
 */
export function termsIn(text: string): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (const term of GLOSSARY) {
    const hit = [term.label, ...term.aliases].some((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'i').test(lower);
    });
    if (hit) found.push(term.id);
  }
  return found;
}
