import { useEffect, useState } from 'react';
import { StoreProvider, useStore } from './state/store';
import { today } from './lib/dates';
import { pendingConfirmations, upcomingBills } from './lib/finance';
import { Dashboard } from './components/Dashboard';
import { MoneyView } from './components/MoneyView';
import { PlanView } from './components/PlanView';
import { AdvisorView } from './components/AdvisorView';
import { SettingsView } from './components/SettingsView';
import { ExpenseSheet, type ExpenseDraft } from './components/forms';
import {
  CompassIcon,
  GearIcon,
  HomeIcon,
  ListIcon,
  PlusIcon,
  SparkIcon,
  TargetIcon,
} from './components/ui';

type Tab = 'dashboard' | 'money' | 'plan' | 'advisor' | 'settings';

const TABS: { id: Tab; label: string; icon: () => JSX.Element }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: HomeIcon },
  { id: 'money', label: 'Money', icon: ListIcon },
  { id: 'plan', label: 'Plan', icon: TargetIcon },
  { id: 'advisor', label: 'Advisor', icon: SparkIcon },
  { id: 'settings', label: 'Settings', icon: GearIcon },
];

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}

function Shell() {
  const { state, dispatch } = useStore();
  const [tab, setTab] = useState<Tab>('dashboard');
  const [expenseSheet, setExpenseSheet] = useState<{ id?: string } | null>(null);

  // The reference date is held in state and refreshed on focus so a session
  // left open overnight does not keep reporting yesterday's "due soon".
  const [reference, setReference] = useState(today);
  useEffect(() => {
    const refresh = () => setReference(today());
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  const editing = expenseSheet?.id ? state.expenses.find((e) => e.id === expenseSheet.id) : undefined;

  const alertCount =
    upcomingBills(state, reference, state.settings.reminderLeadDays).length +
    pendingConfirmations(state, reference).length;

  const saveExpense = (draft: ExpenseDraft) => {
    if (editing) {
      // Clear the fields that no longer apply, so a one-time expense converted
      // to recurring does not keep a stale `date` that would double-count it.
      dispatch({
        type: 'expense/update',
        id: editing.id,
        patch: {
          ...draft,
          dueDay: draft.recurrence === 'recurring' ? draft.dueDay : undefined,
          date: draft.recurrence === 'one-time' ? draft.date : undefined,
          variable: draft.recurrence === 'recurring' ? draft.variable : undefined,
        },
      });
    } else {
      dispatch({ type: 'expense/add', entry: { ...draft, active: true, createdAt: reference } });
    }
    setExpenseSheet(null);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <CompassIcon />
          <span>CashCompass</span>
        </div>
        <div className="topbar__actions">
          {state.settings.householdMode && <span className="pill">Household</span>}
          {state.settings.bufferMode && <span className="pill pill--recurring">Buffer mode</span>}
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setExpenseSheet({})}>
            <PlusIcon />
            Expense
          </button>
        </div>
      </header>

      <main className="app__main">
        {tab === 'dashboard' && (
          <Dashboard reference={reference} onEditExpense={(id) => setExpenseSheet({ id })} />
        )}
        {tab === 'money' && (
          <MoneyView
            reference={reference}
            onEditExpense={(id) => setExpenseSheet({ id })}
            onAddExpense={() => setExpenseSheet({})}
          />
        )}
        {tab === 'plan' && <PlanView reference={reference} />}
        {tab === 'advisor' && <AdvisorView reference={reference} />}
        {tab === 'settings' && <SettingsView reference={reference} />}
      </main>

      <nav className="nav" aria-label="Sections">
        <div className="nav__inner">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className="nav__item"
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => setTab(id)}
            >
              <Icon />
              <span>{label}</span>
              {id === 'dashboard' && alertCount > 0 && (
                <span className="nav__badge" aria-label={`${alertCount} items need attention`}>
                  {alertCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </nav>

      {expenseSheet && (
        <ExpenseSheet
          categories={state.categories}
          initial={editing}
          onSave={saveExpense}
          onClose={() => setExpenseSheet(null)}
          onDelete={
            editing
              ? () => {
                  dispatch({ type: 'expense/remove', id: editing.id });
                  setExpenseSheet(null);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
