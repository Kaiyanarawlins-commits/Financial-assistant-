import { useMemo, useState } from 'react';
import type { LedgerLine, Period, PeriodMode, Snapshot } from '../types';
import { useStore } from '../state/store';
import { findCategory } from '../lib/categories';
import { customPeriod, cycleKeyOf, formatShort, monthPeriod, relativeDays, shiftCycle, ytdPeriod } from '../lib/dates';
import { computeSnapshot, linesForCategory, pendingConfirmations, trend, upcomingBills } from '../lib/finance';
import { generateInsights } from '../lib/advisor';
import { formatMoney, formatMoneyCompact, formatPercent, toCents, toDollars } from '../lib/money';
import { CategoryTrendChart, DonutChart, TrendChart } from './charts';
import { AlertIcon, Card, CheckIcon, ChevronIcon, EmptyState, Field, InfoIcon, Segmented, Sheet } from './ui';
import { useAnimatedNumber } from './motion';

/**
 * The dashboard.
 *
 * Ordered by the question it answers: how much is left (headline), how much is
 * really spendable (safe-to-spend), what needs attention (alerts), where it went
 * (donut + list), and how that compares to before (trend).
 */
export function Dashboard({ reference, onEditExpense }: { reference: string; onEditExpense: (id: string) => void }) {
  const { state, dispatch } = useStore();
  const [mode, setMode] = useState<PeriodMode>('month');
  const [cycleOffset, setCycleOffset] = useState(0);
  const [customStart, setCustomStart] = useState(`${cycleKeyOf(reference)}-01`);
  const [customEnd, setCustomEnd] = useState(reference);
  const [drilldown, setDrilldown] = useState<string | null>(null);

  const period: Period = useMemo(() => {
    if (mode === 'ytd') return ytdPeriod(reference);
    if (mode === 'custom') return customPeriod(customStart, customEnd);
    return monthPeriod(shiftCycle(cycleKeyOf(reference), cycleOffset));
  }, [mode, reference, cycleOffset, customStart, customEnd]);

  // Past months are evaluated at their own end date so their bills read as paid
  // rather than upcoming; the current month is evaluated as of today.
  const asOf = period.end < reference ? period.end : reference;

  const snapshot = useMemo(() => computeSnapshot(state, period, asOf), [state, period, asOf]);
  const trendPoints = useMemo(() => trend(state, reference, 6), [state, reference]);
  const insights = useMemo(() => generateInsights(state, snapshot, reference), [state, snapshot, reference]);
  const bills = useMemo(
    () => upcomingBills(state, reference, state.settings.reminderLeadDays),
    [state, reference],
  );
  const confirmations = useMemo(() => pendingConfirmations(state, reference), [state, reference]);

  return (
    <div className="stack">
      <PeriodControls
        mode={mode}
        onMode={setMode}
        period={period}
        cycleOffset={cycleOffset}
        onCycleOffset={setCycleOffset}
        customStart={customStart}
        customEnd={customEnd}
        onCustomStart={setCustomStart}
        onCustomEnd={setCustomEnd}
      />

      <BalanceHeader snapshot={snapshot} bufferMode={state.settings.bufferMode} />

      {confirmations.length > 0 && (
        <ConfirmationPrompts
          items={confirmations}
          cycleKey={cycleKeyOf(reference)}
          onConfirm={(expenseId, cycleKey, amountCents) =>
            dispatch({ type: 'posting/confirm', expenseId, cycleKey, amountCents })
          }
          onSkip={(expenseId, cycleKey) => dispatch({ type: 'posting/skip', expenseId, cycleKey })}
        />
      )}

      {bills.length > 0 && <UpcomingBills bills={bills} reference={reference} />}

      <IncomeVsSpent snapshot={snapshot} />

      <Card title="Where it went" flush>
        {snapshot.categories.length === 0 ? (
          <EmptyState title="Nothing logged for this period">
            Add an expense and the breakdown appears here.
          </EmptyState>
        ) : (
          <>
            <div style={{ padding: '4px 16px 16px' }}>
              <div className="donut-wrap">
                <DonutChart
                  data={snapshot.categories}
                  totalCents={snapshot.totalSpentCents}
                  onSelect={setDrilldown}
                />
                <div className="legend">
                  {snapshot.categories.slice(0, 7).map((category) => (
                    <button
                      key={category.categoryId}
                      type="button"
                      className="legend__item"
                      onClick={() => setDrilldown(category.categoryId)}
                    >
                      <span className="dot" style={{ background: category.color }} aria-hidden="true" />
                      <span className="grow truncate">{category.name}</span>
                      <span className="tnum faint">{formatPercent(category.percent)}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div>
              {snapshot.categories.map((category) => (
                <button
                  key={category.categoryId}
                  type="button"
                  className="catrow"
                  onClick={() => setDrilldown(category.categoryId)}
                >
                  <span className="dot" style={{ background: category.color }} aria-hidden="true" />
                  <span className="grow">
                    <span className="row row--between">
                      <span className="truncate" style={{ fontWeight: 600 }}>{category.name}</span>
                      <span className="catrow__amount">{formatMoney(category.spentCents)}</span>
                    </span>
                    <span className="catrow__bar">
                      <span
                        className="catrow__bar-fill"
                        style={{ width: `${Math.min(100, category.percent)}%`, background: category.color }}
                      />
                    </span>
                    <span className="row row--between" style={{ marginTop: 3 }}>
                      <span className="catrow__pct">{formatPercent(category.percent, 1)} of spend</span>
                      {category.capPercent !== undefined && (
                        <span
                          className={`tiny ${category.capPercent >= 100 ? 'neg' : category.capPercent >= 80 ? 'warn' : 'faint'}`}
                        >
                          {formatPercent(category.capPercent)} of {formatMoneyCompact(category.capCents ?? 0)} cap
                        </span>
                      )}
                    </span>
                  </span>
                  <ChevronIcon />
                </button>
              ))}
            </div>
          </>
        )}
      </Card>

      <Card title="Fixed vs. discretionary">
        <div className="meter" role="img" aria-label="Recurring versus one-time spending">
          <span
            className="meter__fill"
            style={{
              width: `${percentOf(snapshot.recurringTotalCents, snapshot.totalSpentCents)}%`,
              background: 'var(--accent)',
            }}
          />
          <span
            className="meter__fill"
            style={{
              width: `${percentOf(snapshot.oneTimeTotalCents, snapshot.totalSpentCents)}%`,
              background: 'var(--border-strong)',
            }}
          />
        </div>
        <div className="split">
          <div className="split__cell">
            <div className="split__label">Recurring baseline</div>
            <div className="split__value">{formatMoney(snapshot.recurringTotalCents)}</div>
            <div className="tiny faint">{formatPercent(percentOf(snapshot.recurringTotalCents, snapshot.totalSpentCents))} of spend</div>
          </div>
          <div className="split__cell">
            <div className="split__label">One-time</div>
            <div className="split__value">{formatMoney(snapshot.oneTimeTotalCents)}</div>
            <div className="tiny faint">{formatPercent(percentOf(snapshot.oneTimeTotalCents, snapshot.totalSpentCents))} of spend</div>
          </div>
        </div>
        <p className="tiny faint" style={{ marginTop: 10 }}>
          Your recurring total is what it costs to exist for a month — the number your income has to clear before
          anything else is a choice.
        </p>
      </Card>

      <Card title="Spend by month">
        <TrendChart points={trendPoints} />
      </Card>

      {insights.length > 0 && (
        <Card title="Worth a look">
          <div className="stack" style={{ gap: 9 }}>
            {insights.slice(0, 4).map((insight) => (
              <div
                key={insight.id}
                className={`alert ${
                  insight.tone === 'warning' ? 'alert--danger' : insight.tone === 'positive' ? 'alert--good' : ''
                }`}
              >
                <span className="alert__icon">
                  {insight.tone === 'warning' ? <AlertIcon /> : insight.tone === 'positive' ? <CheckIcon /> : <InfoIcon />}
                </span>
                <span className="grow">
                  <span className="alert__title">{insight.title}</span>
                  <span className="alert__detail" style={{ display: 'block' }}>{insight.detail}</span>
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title="All transactions" flush>
        {snapshot.lines.length === 0 ? (
          <EmptyState title="No transactions in this period" />
        ) : (
          snapshot.lines.map((line) => (
            <LedgerRow
              key={line.id}
              line={line}
              color={findCategory(state.categories, line.categoryId).color}
              categoryName={findCategory(state.categories, line.categoryId).name}
              onClick={() => onEditExpense(line.id.split('@')[0] as string)}
            />
          ))
        )}
      </Card>

      {drilldown && (
        <CategoryDrilldown
          categoryId={drilldown}
          snapshot={snapshot}
          trendPoints={trendPoints}
          onClose={() => setDrilldown(null)}
          onEditExpense={onEditExpense}
        />
      )}
    </div>
  );
}

function percentOf(part: number, whole: number): number {
  return whole === 0 ? 0 : (part / whole) * 100;
}

// ---------------------------------------------------------------------------

function PeriodControls({
  mode,
  onMode,
  period,
  cycleOffset,
  onCycleOffset,
  customStart,
  customEnd,
  onCustomStart,
  onCustomEnd,
}: {
  mode: PeriodMode;
  onMode: (mode: PeriodMode) => void;
  period: Period;
  cycleOffset: number;
  onCycleOffset: (offset: number) => void;
  customStart: string;
  customEnd: string;
  onCustomStart: (value: string) => void;
  onCustomEnd: (value: string) => void;
}) {
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row row--between row--wrap">
        <Segmented
          ariaLabel="Reporting period"
          value={mode}
          onChange={(next) => {
            onMode(next);
            if (next === 'month') onCycleOffset(0);
          }}
          options={[
            { value: 'month', label: 'Monthly' },
            { value: 'ytd', label: 'Year to date' },
            { value: 'custom', label: 'Custom' },
          ]}
        />
        {mode === 'month' && (
          <div className="row" style={{ gap: 4 }}>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => onCycleOffset(cycleOffset - 1)}
              aria-label="Previous month"
            >
              ‹
            </button>
            <span className="small" style={{ minWidth: 108, textAlign: 'center', fontWeight: 600 }}>
              {period.label}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => onCycleOffset(Math.min(0, cycleOffset + 1))}
              disabled={cycleOffset >= 0}
              aria-label="Next month"
            >
              ›
            </button>
          </div>
        )}
      </div>

      {mode === 'custom' && (
        <div className="grid-2">
          <Field label="From">
            <input className="input" type="date" value={customStart} onChange={(e) => onCustomStart(e.target.value)} />
          </Field>
          <Field label="To">
            <input className="input" type="date" value={customEnd} onChange={(e) => onCustomEnd(e.target.value)} />
          </Field>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function BalanceHeader({ snapshot, bufferMode }: { snapshot: Snapshot; bufferMode: boolean }) {
  const negative = snapshot.remainingBalanceCents < 0;
  const safeNegative = snapshot.safeToSpendCents < 0;
  // Counting the figure to its new value makes an edit visibly land on the
  // headline number, which is the whole feedback loop of logging an expense.
  const animatedRemaining = useAnimatedNumber(snapshot.remainingBalanceCents);
  const animatedSafe = useAnimatedNumber(snapshot.safeToSpendCents);

  return (
    <div className="card">
      <div className="balance">
        <div className="balance__label">Remaining balance</div>
        <div className={`balance__value ${negative ? 'neg' : ''}`}>
          {formatMoneyCompact(animatedRemaining)}
        </div>

        <div className="balance__safe">
          <span className="balance__safe-label">Safe to spend</span>
          <span className={`balance__safe-value ${safeNegative ? 'neg' : 'pos'}`}>
            {formatMoneyCompact(animatedSafe)}
          </span>
        </div>

        <div className="balance__note">
          {bufferMode && snapshot.nextPayday ? (
            <>
              Buffer mode — holding back only what is due before your next payday on{' '}
              {formatShort(snapshot.nextPayday)}.
            </>
          ) : snapshot.upcomingRecurringCents > 0 ? (
            <>
              {formatMoney(snapshot.upcomingRecurringCents)} of bills still to land this period, already held back.
            </>
          ) : (
            <>Every recurring bill for this period has been paid.</>
          )}
          {snapshot.goalReserveCents > 0 && <> {formatMoney(snapshot.goalReserveCents)} reserved for goals.</>}
          {!snapshot.cashOnHandAnchored && (
            <>
              {' '}
              Set your account balance in Settings to make this exact — without it, safe-to-spend assumes the month
              opened at zero.
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function IncomeVsSpent({ snapshot }: { snapshot: Snapshot }) {
  const pct = snapshot.totalIncomeCents === 0 ? 0 : (snapshot.totalSpentCents / snapshot.totalIncomeCents) * 100;
  const over = pct > 100;

  return (
    <Card title="Income vs. spent">
      <div className="row row--between" style={{ marginBottom: 8 }}>
        <span className="small muted">{formatPercent(Math.min(pct, 999))} of income spent</span>
        <span className={`small ${over ? 'neg' : 'muted'}`}>
          {over ? `${formatMoney(-snapshot.remainingBalanceCents)} over` : `${formatMoney(snapshot.remainingBalanceCents)} left`}
        </span>
      </div>
      <div className="meter">
        <span
          className="meter__fill"
          style={{
            width: `${Math.min(100, pct)}%`,
            background: over ? 'var(--negative)' : pct > 85 ? 'var(--warning)' : 'var(--positive)',
          }}
        />
      </div>
      <div className="split">
        <div className="split__cell">
          <div className="split__label">Total income</div>
          <div className="split__value pos">{formatMoney(snapshot.totalIncomeCents)}</div>
          <div className="tiny faint">{formatMoney(snapshot.incomeReceivedCents)} received so far</div>
        </div>
        <div className="split__cell">
          <div className="split__label">Total spent</div>
          <div className="split__value">{formatMoney(snapshot.totalSpentCents)}</div>
          <div className="tiny faint">{formatMoney(snapshot.spentToDateCents)} actually paid</div>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function UpcomingBills({ bills, reference }: { bills: ReturnType<typeof upcomingBills>; reference: string }) {
  const total = bills.reduce((sum, bill) => sum + bill.amountCents, 0);
  return (
    <Card title={`Due soon — ${formatMoney(total)}`}>
      <div className="stack" style={{ gap: 8 }}>
        {bills.map((bill) => (
          <div key={`${bill.expenseId}-${bill.dueDate}`} className="row">
            <span className="grow">
              <span style={{ fontWeight: 600 }}>{bill.name}</span>
              <span className="tiny faint" style={{ display: 'block' }}>
                {formatShort(bill.dueDate)} · {relativeDays(reference, bill.dueDate)}
              </span>
            </span>
            <span className="tnum" style={{ fontWeight: 650 }}>{formatMoney(bill.amountCents)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

/**
 * Variable bills waiting on the user. The spec is explicit that a recurring
 * figure is never silently updated, so this asks rather than assumes.
 */
function ConfirmationPrompts({
  items,
  cycleKey,
  onConfirm,
  onSkip,
}: {
  items: ReturnType<typeof pendingConfirmations>;
  cycleKey: string;
  onConfirm: (expenseId: string, cycleKey: string, amountCents: number) => void;
  onSkip: (expenseId: string, cycleKey: string) => void;
}) {
  const [edits, setEdits] = useState<Record<string, string>>({});

  return (
    <Card title="Confirm this month's amounts">
      <p className="small muted" style={{ marginBottom: 12 }}>
        These bills change month to month. Confirm the real amount and it will post — nothing updates on its own.
      </p>
      <div className="stack" style={{ gap: 12 }}>
        {items.map((item) => {
          const value = edits[item.expenseId] ?? String(toDollars(item.amountCents));
          return (
            <div key={item.expenseId} className="row row--wrap" style={{ gap: 8 }}>
              <span className="grow" style={{ minWidth: 120 }}>
                <span style={{ fontWeight: 600 }}>{item.name}</span>
                <span className="tiny faint" style={{ display: 'block' }}>
                  Last month {formatMoney(item.amountCents)} · due {formatShort(item.dueDate)}
                </span>
              </span>
              <input
                className="input"
                style={{ width: 108 }}
                inputMode="decimal"
                value={value}
                aria-label={`${item.name} amount`}
                onChange={(event) => setEdits((current) => ({ ...current, [item.expenseId]: event.target.value }))}
              />
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => onConfirm(item.expenseId, cycleKey, toCents(value))}
              >
                Confirm
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => onSkip(item.expenseId, cycleKey)}>
                Skip
              </button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

export function LedgerRow({
  line,
  color,
  categoryName,
  onClick,
}: {
  line: LedgerLine;
  color: string;
  categoryName: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={`ledger${line.upcoming ? ' ledger--upcoming' : ''}`}
      onClick={onClick}
      disabled={!onClick}
    >
      <span className="dot" style={{ background: color }} aria-hidden="true" />
      <span className="grow">
        <span className="ledger__name truncate">{line.name}</span>
        <span className="ledger__meta">
          <span>{formatShort(line.date)}</span>
          <span>·</span>
          <span>{categoryName}</span>
          {line.recurrence === 'recurring' && <span className="pill pill--recurring">Recurring</span>}
          {line.upcoming && <span className="pill">Upcoming</span>}
          {line.needsConfirmation && <span className="pill pill--warn">Confirm</span>}
        </span>
      </span>
      <span className="ledger__amount">{formatMoney(line.amountCents)}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------

/** Two taps from the dashboard to the exact transactions behind a percentage. */
function CategoryDrilldown({
  categoryId,
  snapshot,
  trendPoints,
  onClose,
  onEditExpense,
}: {
  categoryId: string;
  snapshot: Snapshot;
  trendPoints: ReturnType<typeof trend>;
  onClose: () => void;
  onEditExpense: (id: string) => void;
}) {
  const { state } = useStore();
  const category = findCategory(state.categories, categoryId);
  const lines = linesForCategory(snapshot.lines, categoryId);
  const total = lines.reduce((sum, line) => sum + line.amountCents, 0);
  const breakdown = snapshot.categories.find((c) => c.categoryId === categoryId);

  return (
    <Sheet title={category.name} onClose={onClose}>
      <div className="stack">
        <div className="row" style={{ gap: 12 }}>
          <span className="dot" style={{ background: category.color, width: 14, height: 14 }} aria-hidden="true" />
          <span className="grow">
            <div style={{ fontSize: 26, fontWeight: 750, letterSpacing: '-0.02em' }} className="tnum">
              {formatMoney(total)}
            </div>
            <div className="small faint">
              {formatPercent(breakdown?.percent ?? 0, 1)} of {formatMoney(snapshot.totalSpentCents)} spent in{' '}
              {snapshot.period.label}
            </div>
          </span>
        </div>

        {breakdown?.capCents !== undefined && (
          <div className={`alert ${(breakdown.capPercent ?? 0) >= 100 ? 'alert--danger' : 'alert--warning'}`}>
            <span className="alert__icon"><AlertIcon /></span>
            <span className="grow small">
              {formatPercent(breakdown.capPercent ?? 0)} of your {formatMoney(breakdown.capCents)} monthly cap.
            </span>
          </div>
        )}

        <div>
          <div className="card__title">Last 6 months</div>
          <CategoryTrendChart points={trendPoints} categoryId={categoryId} color={category.color} />
        </div>

        <div>
          <div className="card__title">{lines.length} transactions</div>
          <div style={{ margin: '0 -18px' }}>
            {lines.map((line) => (
              <LedgerRow
                key={line.id}
                line={line}
                color={category.color}
                categoryName={category.name}
                onClick={() => {
                  onClose();
                  onEditExpense(line.id.split('@')[0] as string);
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </Sheet>
  );
}
