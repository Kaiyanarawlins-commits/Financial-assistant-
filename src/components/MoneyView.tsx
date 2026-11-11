import { useMemo, useState } from 'react';
import { useStore } from '../state/store';
import { findCategory } from '../lib/categories';
import { cycleKeyOf, formatShort, monthPeriod, paydaysInPeriod } from '../lib/dates';
import { computeSnapshot } from '../lib/finance';
import { formatMoney } from '../lib/money';
import { IncomeSheet, type IncomeDraft } from './forms';
import { BillsView } from './BillsView';
import { Card, EmptyState, PlusIcon, Segmented } from './ui';
import { LedgerRow } from './Dashboard';

/**
 * The money tab: income entries and the expense ledger, both editable.
 *
 * Editing is deliberately two taps from here — tap the row, edit or delete —
 * because entry friction is what makes people stop logging, and the spec calls
 * that out as the thing that kills these apps.
 */
export function MoneyView({
  reference,
  onEditExpense,
  onAddExpense,
}: {
  reference: string;
  onEditExpense: (id: string) => void;
  onAddExpense: () => void;
}) {
  const { state, dispatch } = useStore();
  const [tab, setTab] = useState<'income' | 'bills' | 'expenses'>('income');
  const [editingIncome, setEditingIncome] = useState<string | null>(null);
  const [addingIncome, setAddingIncome] = useState(false);

  const period = monthPeriod(cycleKeyOf(reference));
  const snapshot = useMemo(() => computeSnapshot(state, period, reference), [state, period, reference]);

  const editing = state.income.find((entry) => entry.id === editingIncome);

  const saveIncome = (draft: IncomeDraft) => {
    if (editing) {
      dispatch({ type: 'income/update', id: editing.id, patch: draft });
      setEditingIncome(null);
    } else {
      dispatch({ type: 'income/add', entry: { ...draft, active: true, createdAt: reference } });
      setAddingIncome(false);
    }
  };

  return (
    <div className="stack">
      <div className="row row--between">
        <Segmented
          ariaLabel="Money view"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'income', label: 'Income' },
            { value: 'bills', label: 'Bills' },
            { value: 'expenses', label: 'Expenses' },
          ]}
        />
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={() => (tab === 'income' ? setAddingIncome(true) : onAddExpense())}
        >
          <PlusIcon />
          Add
        </button>
      </div>

      {tab === 'bills' ? (
        <BillsView reference={reference} onEditExpense={onEditExpense} />
      ) : tab === 'income' ? (
        <>
          <Card title={`${period.label} income`}>
            <div style={{ fontSize: 30, fontWeight: 750, letterSpacing: '-0.025em' }} className="tnum pos">
              {formatMoney(snapshot.totalIncomeCents)}
            </div>
            <div className="small faint">
              {formatMoney(snapshot.incomeReceivedCents)} received · {formatMoney(snapshot.totalIncomeCents - snapshot.incomeReceivedCents)} still to come
              {snapshot.nextPayday && <> · next payday {formatShort(snapshot.nextPayday)}</>}
            </div>
            {state.settings.irregularIncomeMode && (
              <p className="tiny faint" style={{ marginTop: 8 }}>
                Irregular-income mode is on, so this is a {state.settings.irregularLookbackMonths}-month trailing
                average rather than your scheduled income.
              </p>
            )}
          </Card>

          <Card flush>
            {state.income.length === 0 ? (
              <EmptyState title="No income yet">
                Add a paycheck or side income and every balance on the dashboard starts working.
              </EmptyState>
            ) : (
              state.income.map((entry) => {
                const paydays = paydaysInPeriod(entry.schedule, period);
                return (
                  <button
                    key={entry.id}
                    type="button"
                    className="ledger"
                    onClick={() => setEditingIncome(entry.id)}
                    style={entry.active ? undefined : { opacity: 0.5 }}
                  >
                    <span className="dot" style={{ background: 'var(--positive)' }} aria-hidden="true" />
                    <span className="grow">
                      <span className="ledger__name truncate">{entry.source}</span>
                      <span className="ledger__meta">
                        <span>{describeSchedule(entry.schedule)}</span>
                        {paydays.length > 1 && <span className="pill">{paydays.length}× this month</span>}
                        {!entry.active && <span className="pill">Paused</span>}
                      </span>
                    </span>
                    <span className="ledger__amount pos">
                      {formatMoney(entry.amountCents * Math.max(1, paydays.length))}
                    </span>
                  </button>
                );
              })
            )}
          </Card>
        </>
      ) : (
        <>
          <Card title={`${period.label} spending`}>
            <div style={{ fontSize: 30, fontWeight: 750, letterSpacing: '-0.025em' }} className="tnum">
              {formatMoney(snapshot.totalSpentCents)}
            </div>
            <div className="small faint">
              {formatMoney(snapshot.recurringTotalCents)} recurring · {formatMoney(snapshot.oneTimeTotalCents)} one-time
            </div>
          </Card>

          <Card flush>
            {snapshot.lines.length === 0 ? (
              <EmptyState title="No expenses this month">Tap Add to log your first one.</EmptyState>
            ) : (
              snapshot.lines.map((line) => {
                const category = findCategory(state.categories, line.categoryId);
                return (
                  <LedgerRow
                    key={line.id}
                    line={line}
                    color={category.color}
                    categoryName={category.name}
                    onClick={() => onEditExpense(line.id.split('@')[0] as string)}
                  />
                );
              })
            )}
          </Card>

          <p className="tiny faint" style={{ textAlign: 'center' }}>
            Recurring bills show once per month on their due date. Tap any row to edit or delete it.
          </p>
        </>
      )}

      {(addingIncome || editing) && (
        <IncomeSheet
          initial={editing}
          onSave={saveIncome}
          onClose={() => {
            setAddingIncome(false);
            setEditingIncome(null);
          }}
          onDelete={
            editing
              ? () => {
                  dispatch({ type: 'income/remove', id: editing.id });
                  setEditingIncome(null);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

function describeSchedule(schedule: import('../types').IncomeSchedule): string {
  switch (schedule.kind) {
    case 'monthly-days':
      return `Monthly on the ${schedule.days.map(ordinalShort).join(' & ')}`;
    case 'biweekly':
      return 'Every two weeks';
    case 'weekly':
      return 'Weekly';
    case 'one-time':
      return `One-time · ${formatShort(schedule.date)}`;
  }
}

function ordinalShort(day: number): string {
  const suffix =
    day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  return `${day}${suffix}`;
}
