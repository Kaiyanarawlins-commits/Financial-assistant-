import { useMemo, useState } from 'react';
import type { Debt, SavingsGoal } from '../types';
import { useStore } from '../state/store';
import { blendedAprPercent, compareStrategies, formatMonths, minimumsTotalCents, totalDebtCents } from '../lib/debt';
import { cycleKeyOf, monthPeriod, today } from '../lib/dates';
import { computeSnapshot, netWorthCents } from '../lib/finance';
import { formatMoney, formatPercent, toCents, toDollars } from '../lib/money';
import { NetWorthChart } from './charts';
import { goalColor, useAnimatedPercent } from './motion';
import { Card, EmptyState, Field, PlusIcon, Segmented, Sheet, Toggle } from './ui';

/** Goals, debt payoff and net worth — the "beyond this month" tab. */
export function PlanView({ reference }: { reference: string }) {
  const [tab, setTab] = useState<'goals' | 'debts' | 'networth'>('goals');

  return (
    <div className="stack">
      <Segmented
        ariaLabel="Plan view"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'goals', label: 'Goals' },
          { value: 'debts', label: 'Debt' },
          { value: 'networth', label: 'Net worth' },
        ]}
      />
      {tab === 'goals' && <GoalsPanel reference={reference} />}
      {tab === 'debts' && <DebtsPanel reference={reference} />}
      {tab === 'networth' && <NetWorthPanel />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

function GoalsPanel({ reference }: { reference: string }) {
  const { state, dispatch } = useStore();
  const [editing, setEditing] = useState<SavingsGoal | null>(null);
  const [adding, setAdding] = useState(false);

  const snapshot = useMemo(
    () => computeSnapshot(state, monthPeriod(cycleKeyOf(reference)), reference),
    [state, reference],
  );
  const leftover = Math.max(0, snapshot.remainingBalanceCents);

  return (
    <div className="stack">
      <div className="row row--between">
        <span className="small muted">
          {formatMoney(leftover)} projected leftover this month
        </span>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setAdding(true)}>
          <PlusIcon />
          New goal
        </button>
      </div>

      {state.goals.length === 0 ? (
        <Card>
          <EmptyState title="No goals yet">
            A target turns "money left over" into a plan. Money without a name attached tends to get spent.
          </EmptyState>
        </Card>
      ) : (
        state.goals.map((goal) => {
          const percent = goal.targetCents === 0 ? 0 : (goal.savedCents / goal.targetCents) * 100;
          const remaining = Math.max(0, goal.targetCents - goal.savedCents);
          const monthsToGo = leftover > 0 ? Math.ceil(remaining / leftover) : Infinity;

          return (
            <Card key={goal.id}>
              <div className="row row--between">
                <span className="grow">
                  <div style={{ fontWeight: 650 }}>{goal.name}</div>
                  <div className="tiny faint">
                    {formatMoney(goal.savedCents)} of {formatMoney(goal.targetCents)}
                    {goal.reserveFromSafeToSpend && ' · reserved from safe-to-spend'}
                  </div>
                </span>
                <GoalPercent percent={percent} />
              </div>

              <GoalBar percent={percent} />

              <div className="row row--between row--wrap" style={{ gap: 8 }}>
                <span className="tiny faint">
                  {remaining === 0
                    ? 'Funded'
                    : Number.isFinite(monthsToGo)
                      ? `${formatMoney(remaining)} to go — about ${monthsToGo} ${monthsToGo === 1 ? 'month' : 'months'} at your current leftover`
                      : `${formatMoney(remaining)} to go`}
                </span>
                <span className="row" style={{ gap: 6 }}>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() =>
                      dispatch({
                        type: 'goal/update',
                        id: goal.id,
                        patch: { savedCents: Math.min(goal.targetCents, goal.savedCents + 10_000) },
                      })
                    }
                  >
                    +$100
                  </button>
                  <button type="button" className="btn btn--sm" onClick={() => setEditing(goal)}>
                    Edit
                  </button>
                </span>
              </div>
            </Card>
          );
        })
      )}

      {(adding || editing) && (
        <GoalSheet
          initial={editing ?? undefined}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
          onSave={(draft) => {
            if (editing) dispatch({ type: 'goal/update', id: editing.id, patch: draft });
            else dispatch({ type: 'goal/add', goal: { ...draft, createdAt: today() } });
            setAdding(false);
            setEditing(null);
          }}
          onDelete={
            editing
              ? () => {
                  dispatch({ type: 'goal/remove', id: editing.id });
                  setEditing(null);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

/**
 * The goal bar fills from empty and travels amber → blue → green as the goal
 * completes, so progress is legible from the colour before you read the number.
 * A funded goal pulses once — the only celebratory moment in the app, and it is
 * the one place that earns it.
 */
function GoalBar({ percent }: { percent: number }) {
  const animated = useAnimatedPercent(Math.min(100, percent));
  const complete = percent >= 100;
  return (
    <div
      className="goal__bar"
      role="progressbar"
      aria-valuenow={Math.round(Math.min(100, percent))}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span
        className={`goal__fill${complete ? ' goal__fill--complete' : ''}`}
        style={{ width: `${animated}%`, background: goalColor(animated) }}
      />
    </div>
  );
}

function GoalPercent({ percent }: { percent: number }) {
  const animated = useAnimatedPercent(Math.min(100, percent));
  return (
    <span className="tnum" style={{ fontWeight: 700, color: goalColor(animated) }}>
      {formatPercent(animated)}
    </span>
  );
}

function GoalSheet({
  initial,
  onSave,
  onDelete,
  onClose,
}: {
  initial?: SavingsGoal;
  onSave: (draft: Omit<SavingsGoal, 'id' | 'createdAt'>) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [target, setTarget] = useState(initial ? String(toDollars(initial.targetCents)) : '');
  const [saved, setSaved] = useState(initial ? String(toDollars(initial.savedCents)) : '0');
  const [reserve, setReserve] = useState(initial?.reserveFromSafeToSpend ?? false);

  const valid = toCents(target) > 0 && name.trim().length > 0;

  return (
    <Sheet
      title={initial ? 'Edit goal' : 'New goal'}
      onClose={onClose}
      footer={
        <div className="row" style={{ gap: 8 }}>
          {onDelete && (
            <button type="button" className="btn btn--danger" onClick={onDelete}>
              Delete
            </button>
          )}
          <button
            type="button"
            className="btn btn--primary grow"
            disabled={!valid}
            onClick={() =>
              onSave({
                name: name.trim(),
                targetCents: toCents(target),
                savedCents: toCents(saved),
                reserveFromSafeToSpend: reserve,
              })
            }
          >
            Save
          </button>
        </div>
      }
    >
      <div className="stack">
        <Field label="What for">
          <input
            className="input"
            autoFocus
            value={name}
            placeholder="Emergency fund"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <div className="grid-2">
          <Field label="Target">
            <input className="input" inputMode="decimal" value={target} placeholder="2000" onChange={(e) => setTarget(e.target.value)} />
          </Field>
          <Field label="Saved so far">
            <input className="input" inputMode="decimal" value={saved} onChange={(e) => setSaved(e.target.value)} />
          </Field>
        </div>
        <Toggle
          label="Hold this back from safe-to-spend"
          hint="The unfunded remainder stops showing up as money you can spend."
          checked={reserve}
          onChange={setReserve}
        />
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Debt
// ---------------------------------------------------------------------------

function DebtsPanel({ reference }: { reference: string }) {
  const { state, dispatch } = useStore();
  const [editing, setEditing] = useState<Debt | null>(null);
  const [adding, setAdding] = useState(false);

  const snapshot = useMemo(
    () => computeSnapshot(state, monthPeriod(cycleKeyOf(reference)), reference),
    [state, reference],
  );
  const [extra, setExtra] = useState(String(Math.max(0, Math.round(toDollars(snapshot.remainingBalanceCents)))));
  const extraCents = toCents(extra);

  const comparison = useMemo(() => compareStrategies(state.debts, extraCents), [state.debts, extraCents]);
  const total = totalDebtCents(state.debts);

  if (state.debts.length === 0) {
    return (
      <div className="stack">
        <div className="row row--between">
          <span className="small muted">No debts logged</span>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setAdding(true)}>
            <PlusIcon />
            Add debt
          </button>
        </div>
        <Card>
          <EmptyState title="Nothing to pay off">
            Add a card, loan or car note with its balance and rate to see snowball and avalanche timelines.
          </EmptyState>
        </Card>
        {adding && (
          <DebtSheet
            onClose={() => setAdding(false)}
            onSave={(draft) => {
              dispatch({ type: 'debt/add', debt: draft });
              setAdding(false);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row row--between">
        <span className="small muted">{state.debts.length} accounts</span>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setAdding(true)}>
          <PlusIcon />
          Add debt
        </button>
      </div>

      <Card>
        <div className="card__title">Total debt</div>
        <div style={{ fontSize: 32, fontWeight: 750, letterSpacing: '-0.025em' }} className="tnum">
          {formatMoney(total)}
        </div>
        <div className="small faint">
          {formatPercent(blendedAprPercent(state.debts), 1)} blended rate ·{' '}
          {formatMoney(minimumsTotalCents(state.debts))} a month in minimums
        </div>
      </Card>

      <Card title="Extra payment">
        <Field label="On top of the minimums, each month">
          <input className="input" inputMode="decimal" value={extra} onChange={(event) => setExtra(event.target.value)} />
        </Field>
        <p className="tiny faint" style={{ marginTop: 8 }}>
          Defaults to your projected leftover this month. As each debt clears, its minimum rolls into this figure —
          that rollover is what makes either strategy speed up.
        </p>
      </Card>

      <div className="grid-2">
        <StrategyCard
          title="Avalanche"
          subtitle="Highest rate first"
          plan={comparison.avalanche}
          best={comparison.interestSavedCents > 0}
        />
        <StrategyCard
          title="Snowball"
          subtitle="Smallest balance first"
          plan={comparison.snowball}
          best={comparison.interestSavedCents < 0}
        />
      </div>

      {!comparison.avalanche.impossible && comparison.interestSavedCents > 0 && (
        <Card>
          <p className="small">
            Paying the highest rate first saves <strong>{formatMoney(comparison.interestSavedCents)}</strong> in
            interest
            {comparison.monthsSaved > 0 && <> and finishes {comparison.monthsSaved} months sooner</>}. The snowball's
            argument is that clearing a whole account early keeps you going — if that difference is not enough to
            change your mind, it is a defensible choice. The worst plan is the one you stop following.
          </p>
        </Card>
      )}

      {comparison.avalanche.impossible && (
        <div className="alert alert--danger">
          <span className="grow small">
            At {formatMoney(extraCents)} extra per month, the balances never reach zero — interest is keeping pace with
            the payments. Raising the payment or lowering the rate matters far more than payment order here.
          </span>
        </div>
      )}

      <Card flush>
        {[...state.debts]
          .sort((a, b) => b.aprPercent - a.aprPercent)
          .map((debt) => (
            <button key={debt.id} type="button" className="ledger" onClick={() => setEditing(debt)}>
              <span className="grow">
                <span className="ledger__name">{debt.name}</span>
                <span className="ledger__meta">
                  <span>{formatPercent(debt.aprPercent, 2)} APR</span>
                  <span>·</span>
                  <span>{formatMoney(debt.minimumPaymentCents)} minimum</span>
                </span>
              </span>
              <span className="ledger__amount">{formatMoney(debt.balanceCents)}</span>
            </button>
          ))}
      </Card>

      {(adding || editing) && (
        <DebtSheet
          initial={editing ?? undefined}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
          onSave={(draft) => {
            if (editing) dispatch({ type: 'debt/update', id: editing.id, patch: draft });
            else dispatch({ type: 'debt/add', debt: draft });
            setAdding(false);
            setEditing(null);
          }}
          onDelete={
            editing
              ? () => {
                  dispatch({ type: 'debt/remove', id: editing.id });
                  setEditing(null);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

function StrategyCard({
  title,
  subtitle,
  plan,
  best,
}: {
  title: string;
  subtitle: string;
  plan: ReturnType<typeof compareStrategies>['avalanche'];
  best: boolean;
}) {
  return (
    <div className="card" style={best ? { borderColor: 'var(--accent)' } : undefined}>
      <div className="row row--between">
        <span style={{ fontWeight: 700 }}>{title}</span>
        {best && <span className="pill pill--good">Less interest</span>}
      </div>
      <div className="tiny faint">{subtitle}</div>
      <div style={{ fontSize: 21, fontWeight: 750, marginTop: 8 }} className="tnum">
        {formatMonths(plan.months)}
      </div>
      <div className="tiny faint">{formatMoney(plan.totalInterestCents)} interest</div>
    </div>
  );
}

function DebtSheet({
  initial,
  onSave,
  onDelete,
  onClose,
}: {
  initial?: Debt;
  onSave: (draft: Omit<Debt, 'id'>) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [balance, setBalance] = useState(initial ? String(toDollars(initial.balanceCents)) : '');
  const [apr, setApr] = useState(initial ? String(initial.aprPercent) : '');
  const [minimum, setMinimum] = useState(initial ? String(toDollars(initial.minimumPaymentCents)) : '');
  const [creditLimit, setCreditLimit] = useState(
    initial?.creditLimitCents ? String(toDollars(initial.creditLimitCents)) : '',
  );

  const valid = name.trim().length > 0 && toCents(balance) > 0;

  return (
    <Sheet
      title={initial ? 'Edit debt' : 'Add debt'}
      onClose={onClose}
      footer={
        <div className="row" style={{ gap: 8 }}>
          {onDelete && (
            <button type="button" className="btn btn--danger" onClick={onDelete}>
              Delete
            </button>
          )}
          <button
            type="button"
            className="btn btn--primary grow"
            disabled={!valid}
            onClick={() =>
              onSave({
                name: name.trim(),
                balanceCents: toCents(balance),
                aprPercent: Number(apr) || 0,
                minimumPaymentCents: toCents(minimum),
                creditLimitCents: toCents(creditLimit) > 0 ? toCents(creditLimit) : undefined,
              })
            }
          >
            Save
          </button>
        </div>
      }
    >
      <div className="stack">
        <Field label="Account">
          <input className="input" autoFocus value={name} placeholder="Visa" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Balance">
          <input className="input" inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} />
        </Field>
        <div className="grid-2">
          <Field label="APR %">
            <input className="input" inputMode="decimal" value={apr} placeholder="22.99" onChange={(e) => setApr(e.target.value)} />
          </Field>
          <Field label="Minimum payment">
            <input className="input" inputMode="decimal" value={minimum} onChange={(e) => setMinimum(e.target.value)} />
          </Field>
        </div>
        <Field
          label="Credit limit"
          hint="Credit cards only. Lets the Credit Coach compute your real utilization — about 30% of your score, and the fastest thing you can move."
        >
          <input
            className="input"
            inputMode="decimal"
            placeholder="Not a revolving account"
            value={creditLimit}
            onChange={(e) => setCreditLimit(e.target.value)}
          />
        </Field>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Net worth
// ---------------------------------------------------------------------------

function NetWorthPanel() {
  const { state, dispatch } = useStore();
  const [adding, setAdding] = useState(false);
  const [assets, setAssets] = useState('');
  const [liabilities, setLiabilities] = useState('');
  const [date, setDate] = useState(today());

  const points = state.netWorth.map((snapshot) => ({
    date: snapshot.date,
    valueCents: netWorthCents(snapshot.assetsCents, snapshot.liabilitiesCents),
  }));
  const latest = points.at(-1);
  const first = points[0];
  const change = latest && first ? latest.valueCents - first.valueCents : 0;

  return (
    <div className="stack">
      <div className="row row--between">
        <span className="small muted">{state.netWorth.length} snapshots</span>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setAdding(true)}>
          <PlusIcon />
          Add snapshot
        </button>
      </div>

      {latest ? (
        <Card>
          <div className="card__title">Net worth</div>
          <div
            style={{ fontSize: 32, fontWeight: 750, letterSpacing: '-0.025em' }}
            className={`tnum ${latest.valueCents < 0 ? 'neg' : ''}`}
          >
            {formatMoney(latest.valueCents)}
          </div>
          {points.length > 1 && (
            <div className={`small ${change >= 0 ? 'pos' : 'neg'}`}>
              {change >= 0 ? '▲' : '▼'} {formatMoney(Math.abs(change))} since {first!.date}
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            <NetWorthChart points={points} />
          </div>
          <p className="tiny faint" style={{ marginTop: 10 }}>
            Quarterly is often enough. Measured monthly, this number mostly reports market noise back to you — and
            reacting to noise is how people sell at the wrong time.
          </p>
        </Card>
      ) : (
        <Card>
          <EmptyState title="No snapshots yet">
            Add what you own and what you owe. The direction over time matters far more than the level.
          </EmptyState>
        </Card>
      )}

      <Card flush>
        {[...state.netWorth].reverse().map((snapshot) => (
          <div key={snapshot.id} className="ledger" style={{ cursor: 'default' }}>
            <span className="grow">
              <span className="ledger__name">{snapshot.date}</span>
              <span className="ledger__meta">
                <span className="pos">{formatMoney(snapshot.assetsCents)} assets</span>
                <span>·</span>
                <span className="neg">{formatMoney(snapshot.liabilitiesCents)} owed</span>
              </span>
            </span>
            <span className="ledger__amount">
              {formatMoney(netWorthCents(snapshot.assetsCents, snapshot.liabilitiesCents))}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => dispatch({ type: 'networth/remove', id: snapshot.id })}
              aria-label={`Remove snapshot from ${snapshot.date}`}
            >
              ×
            </button>
          </div>
        ))}
      </Card>

      {adding && (
        <Sheet
          title="Net worth snapshot"
          onClose={() => setAdding(false)}
          footer={
            <button
              type="button"
              className="btn btn--primary btn--block"
              onClick={() => {
                dispatch({
                  type: 'networth/add',
                  snapshot: { date, assetsCents: toCents(assets), liabilitiesCents: toCents(liabilities) },
                });
                setAssets('');
                setLiabilities('');
                setAdding(false);
              }}
            >
              Save snapshot
            </button>
          }
        >
          <div className="stack">
            <Field label="Date">
              <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Assets" hint="Cash, savings, investments, market value of a home or car.">
              <input className="input" inputMode="decimal" autoFocus value={assets} onChange={(e) => setAssets(e.target.value)} />
            </Field>
            <Field label="Liabilities" hint="Mortgage, student loans, car loans, card balances.">
              <input className="input" inputMode="decimal" value={liabilities} onChange={(e) => setLiabilities(e.target.value)} />
            </Field>
            {(toCents(assets) > 0 || toCents(liabilities) > 0) && (
              <div className="alert">
                <span className="grow small">
                  Net worth: <strong>{formatMoney(toCents(assets) - toCents(liabilities))}</strong>
                </span>
              </div>
            )}
          </div>
        </Sheet>
      )}
    </div>
  );
}
