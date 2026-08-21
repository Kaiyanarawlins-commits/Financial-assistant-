/**
 * CashCompass domain model.
 *
 * Money is stored in **whole cents** as integers everywhere below. Floating
 * point dollars accumulate rounding error once you sum a few dozen entries,
 * and this app's headline number is a sum. Convert at the UI edge only.
 */

/** Calendar date, `YYYY-MM-DD`, always interpreted in the user's local zone. */
export type ISODate = string;

/** Identifies a monthly cycle, `YYYY-MM`. */
export type CycleKey = string;

export type Recurrence = 'recurring' | 'one-time';

// ---------------------------------------------------------------------------
// Income
// ---------------------------------------------------------------------------

/**
 * When money actually lands. The schedule matters as much as the amount:
 * safe-to-spend and buffer mode both need to know what is coming and when,
 * not just the monthly total.
 */
export type IncomeSchedule =
  /** Paid on fixed days of the month, e.g. the 1st and 15th. Day 31 clamps to month end. */
  | { kind: 'monthly-days'; days: number[] }
  /** Every 14 days counting from `anchor`. */
  | { kind: 'biweekly'; anchor: ISODate }
  /** Every 7 days counting from `anchor`. */
  | { kind: 'weekly'; anchor: ISODate }
  /** Lands once, on `date`. */
  | { kind: 'one-time'; date: ISODate };

export interface IncomeEntry {
  id: string;
  /** e.g. "Paycheck", "Freelance — Acme" */
  source: string;
  /** Amount of a *single* payment, in cents. Monthly total = amount x paydays. */
  amountCents: number;
  recurrence: Recurrence;
  schedule: IncomeSchedule;
  /** Inactive entries are kept for history but excluded from current totals. */
  active: boolean;
  createdAt: ISODate;
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

export interface ExpenseEntry {
  id: string;
  /** e.g. "Rent", "Plane ticket to Denver" */
  name: string;
  /** Cents. For a variable recurring bill this is the *last confirmed* amount. */
  amountCents: number;
  categoryId: string;
  recurrence: Recurrence;
  /** Recurring only: day of month the bill hits, 1–31 (clamped to month length). */
  dueDay?: number;
  /** One-time only: the date it was spent. */
  date?: ISODate;
  /**
   * Recurring only. A variable bill (utilities, usage-based) must be confirmed
   * by the user each cycle before it posts — the app never silently rewrites a
   * recurring figure.
   */
  variable?: boolean;
  active: boolean;
  createdAt: ISODate;
}

/**
 * One occurrence of a recurring expense in one cycle.
 *
 * Postings are keyed by `expenseId + cycleKey`, which is what makes recurring
 * deduction idempotent: re-opening the app, or re-running the cycle roll,
 * cannot double-charge a bill.
 */
export interface Posting {
  id: string;
  expenseId: string;
  cycleKey: CycleKey;
  /** Cents actually posted for this cycle (may differ from the template amount). */
  amountCents: number;
  /** The date within the cycle that this bill hits. */
  dueDate: ISODate;
  status: 'posted' | 'needs-confirmation' | 'skipped';
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export interface Category {
  id: string;
  name: string;
  /** Hex colour used by the donut, legend and trend chart. */
  color: string;
  /** Built-in categories cannot be deleted, only renamed or recoloured. */
  builtIn: boolean;
  /** Optional soft cap in cents; drives the spending-alert banner. */
  monthlyCapCents?: number;
}

// ---------------------------------------------------------------------------
// Goals, debts, net worth
// ---------------------------------------------------------------------------

export interface SavingsGoal {
  id: string;
  name: string;
  targetCents: number;
  savedCents: number;
  /**
   * When true this goal's *unfunded* remainder is held back from safe-to-spend,
   * so the money reads as spoken for rather than available.
   */
  reserveFromSafeToSpend: boolean;
  createdAt: ISODate;
}

export interface Debt {
  id: string;
  name: string;
  balanceCents: number;
  /** Annual percentage rate, e.g. 22.99 */
  aprPercent: number;
  minimumPaymentCents: number;
  /**
   * Credit limit, for revolving accounts only.
   *
   * Without it the advisor can talk about utilization but cannot compute the
   * user's actual figure — and utilization is ~30% of a credit score and the
   * fastest thing they can move. A generic explanation is exactly the vague
   * answer worth avoiding.
   */
  creditLimitCents?: number;
}

export interface NetWorthSnapshot {
  id: string;
  date: ISODate;
  assetsCents: number;
  liabilitiesCents: number;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface Settings {
  /**
   * Paycheck-to-paycheck buffer mode. Safe-to-spend is measured against cash
   * actually in hand and the bills landing before the next payday, rather than
   * against the full month's projected income.
   */
  bufferMode: boolean;
  /**
   * Irregular-income mode: replaces scheduled income with a trailing average
   * for users on freelance/commission income.
   */
  irregularIncomeMode: boolean;
  /** Months averaged when `irregularIncomeMode` is on (3–6 per spec). */
  irregularLookbackMonths: number;
  /** Days of warning before a bill is due. */
  reminderLeadDays: number;
  /** Household mode simply relabels the UI for a shared budget. */
  householdMode: boolean;
  /**
   * Colour scheme. 'system' follows the device setting via prefers-color-scheme;
   * the explicit values stamp data-theme on the root element and win over it.
   */
  theme: 'system' | 'light' | 'dark';
  /**
   * The user's actual account balance, and the date it was true.
   *
   * Without this, safe-to-spend has to assume every month opens at zero, which
   * makes anyone who pays rent on the 1st look overdrawn until their next
   * payday. Anchoring to a real balance is what makes the figure trustworthy;
   * it stays optional, and the calculation falls back to the within-period
   * cash basis when it is unset.
   */
  accountBalanceCents?: number;
  accountBalanceAsOf?: ISODate;
}

// ---------------------------------------------------------------------------
// Root state
// ---------------------------------------------------------------------------

export interface AppState {
  schemaVersion: number;
  income: IncomeEntry[];
  expenses: ExpenseEntry[];
  postings: Posting[];
  categories: Category[];
  goals: SavingsGoal[];
  debts: Debt[];
  netWorth: NetWorthSnapshot[];
  settings: Settings;
}

// ---------------------------------------------------------------------------
// View models produced by the calculation engine
// ---------------------------------------------------------------------------

/** An inclusive date window the dashboard reports over. */
export interface Period {
  start: ISODate;
  end: ISODate;
  label: string;
}

export type PeriodMode = 'month' | 'ytd' | 'custom';

export interface CategoryBreakdown {
  categoryId: string;
  name: string;
  color: string;
  spentCents: number;
  /** Share of total spend, 0–100. */
  percent: number;
  capCents?: number;
  /** Set when a cap exists: share of the cap consumed, 0–100+. */
  capPercent?: number;
}

/** A single line item behind a category's percentage. */
export interface LedgerLine {
  id: string;
  name: string;
  categoryId: string;
  amountCents: number;
  date: ISODate;
  recurrence: Recurrence;
  /** True when this is a recurring bill that has not yet hit its due date. */
  upcoming: boolean;
  needsConfirmation: boolean;
}

export interface Snapshot {
  period: Period;
  totalIncomeCents: number;
  /** Income whose payday has already passed as of the reference date. */
  incomeReceivedCents: number;
  recurringTotalCents: number;
  oneTimeTotalCents: number;
  totalSpentCents: number;
  /** Recurring bills in this cycle whose due date has not yet arrived. */
  upcomingRecurringCents: number;
  /** Spend that has actually left the account as of the reference date. */
  spentToDateCents: number;
  /** Unfunded remainder of goals flagged `reserveFromSafeToSpend`. */
  goalReserveCents: number;
  remainingBalanceCents: number;
  safeToSpendCents: number;
  /**
   * Cash actually available right now. Derived from the user's anchored account
   * balance when they have set one, otherwise from income received minus spend
   * to date within the period.
   */
  cashOnHandCents: number;
  /** True when `cashOnHandCents` came from a real balance rather than the fallback. */
  cashOnHandAnchored: boolean;
  /** Next payday at or after the reference date, if one is scheduled. */
  nextPayday: ISODate | null;
  categories: CategoryBreakdown[];
  lines: LedgerLine[];
}
