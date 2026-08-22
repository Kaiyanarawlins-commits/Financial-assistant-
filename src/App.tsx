import { useCallback, useEffect, useState } from 'react';
import { StoreProvider, useStore } from './state/store';
import { AuthScreen } from './components/AuthScreen';
import {
  getAuthProvider,
  readSessionToken,
  rememberSessionToken,
  type Session,
} from './lib/auth';
import { setStorageNamespace } from './lib/storage';
import { setChatNamespace } from './lib/chatHistory';
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

/**
 * Auth gate.
 *
 * The store mounts only once a session exists, and it is keyed on the account
 * id — that forces a full remount on sign-in, so the reducer initialises from
 * the right namespace instead of carrying the previous user's ledger into a new
 * session.
 */
export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);

  const adopt = useCallback((next: Session | null) => {
    setStorageNamespace(next?.account.id ?? '');
    setChatNamespace(next?.account.id ?? '');
    rememberSessionToken(next?.token ?? null);
    setSession(next);
  }, []);

  // Restore a saved session before the first paint decision, so a returning
  // user does not see the sign-in screen flash before their dashboard.
  useEffect(() => {
    const token = readSessionToken();
    if (!token) {
      setChecking(false);
      return;
    }
    let cancelled = false;
    void getAuthProvider()
      .restore(token)
      .then((restored) => {
        if (cancelled) return;
        adopt(restored);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [adopt]);

  if (checking) {
    return (
      <div className="auth">
        <div className="auth__panel auth__panel--quiet">
          <CompassIcon size={34} />
          <span className="small faint">Signing you in…</span>
        </div>
      </div>
    );
  }

  if (!session) return <AuthScreen onAuthenticated={adopt} />;

  return (
    <StoreProvider key={session.account.id}>
      <Shell session={session} onSignOut={() => void signOutOf(session, adopt)} />
    </StoreProvider>
  );
}

async function signOutOf(session: Session, adopt: (next: Session | null) => void): Promise<void> {
  await getAuthProvider().signOut(session.token).catch(() => undefined);
  adopt(null);
}

function Shell({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
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

  // Stamp the theme choice on the root element. 'system' removes the stamp so
  // the CSS falls through to prefers-color-scheme; the explicit values win over
  // it in both directions. The meta theme-color is updated to match, or the
  // phone's status bar keeps painting the opposite ground behind the app.
  useEffect(() => {
    const root = document.documentElement;
    const choice = state.settings.theme ?? 'system';
    if (choice === 'system') delete root.dataset.theme;
    else root.dataset.theme = choice;

    const dark =
      choice === 'dark' ||
      (choice === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    for (const tag of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      tag.content = dark ? '#0b0e14' : '#f6f7f9';
    }
  }, [state.settings.theme]);

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
          <AccountMenu session={session} onSignOut={onSignOut} />
        </div>
      </header>

      <main className="app__main">
        {tab === 'dashboard' && <Greeting name={session.account.name} reference={reference} />}
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
        {tab === 'settings' && <SettingsView reference={reference} session={session} onSignOut={onSignOut} />}
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

/**
 * The personalised header.
 *
 * Time-of-day greeting plus the user's name — the cheapest thing that makes an
 * app feel like it belongs to someone rather than being a spreadsheet with a
 * logo on it.
 */
function Greeting({ name, reference }: { name: string; reference: string }) {
  const hour = new Date().getHours();
  const partOfDay = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const date = new Date(`${reference}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <div className="greeting">
      <h1 className="greeting__title">
        {partOfDay}, {name.split(' ')[0]}
      </h1>
      <p className="greeting__date">{date}</p>
    </div>
  );
}

/** Initials button that opens a small account menu. */
function AccountMenu({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    // Deferred so the click that opened the menu does not immediately close it.
    const timer = window.setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('click', close);
    };
  }, [open]);

  const initials = session.account.name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <div className="account">
      <button
        type="button"
        className="account__avatar"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        {initials || '?'}
      </button>
      {open && (
        <div className="account__menu" role="menu">
          <div className="account__who">
            <strong>{session.account.name}</strong>
            <span className="tiny faint">{session.account.email}</span>
          </div>
          <button type="button" className="account__item" role="menuitem" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
