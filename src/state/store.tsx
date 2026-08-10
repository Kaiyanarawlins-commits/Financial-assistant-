import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react';
import type {
  AppState,
  Category,
  CycleKey,
  Debt,
  ExpenseEntry,
  IncomeEntry,
  NetWorthSnapshot,
  Posting,
  SavingsGoal,
  Settings,
} from '../types';
import { clampDayToMonth, parseCycleKey } from '../lib/dates';
import { newId } from '../lib/id';
import { loadState, saveState } from '../lib/storage';
import { seedState } from '../lib/seed';

export type Action =
  | { type: 'income/add'; entry: Omit<IncomeEntry, 'id'> }
  | { type: 'income/update'; id: string; patch: Partial<IncomeEntry> }
  | { type: 'income/remove'; id: string }
  | { type: 'expense/add'; entry: Omit<ExpenseEntry, 'id'> }
  | { type: 'expense/update'; id: string; patch: Partial<ExpenseEntry> }
  | { type: 'expense/remove'; id: string }
  | { type: 'posting/confirm'; expenseId: string; cycleKey: CycleKey; amountCents: number }
  | { type: 'posting/skip'; expenseId: string; cycleKey: CycleKey }
  | { type: 'posting/reset'; expenseId: string; cycleKey: CycleKey }
  | { type: 'category/add'; category: Category }
  | { type: 'category/update'; id: string; patch: Partial<Category> }
  | { type: 'category/remove'; id: string }
  | { type: 'goal/add'; goal: Omit<SavingsGoal, 'id'> }
  | { type: 'goal/update'; id: string; patch: Partial<SavingsGoal> }
  | { type: 'goal/remove'; id: string }
  | { type: 'debt/add'; debt: Omit<Debt, 'id'> }
  | { type: 'debt/update'; id: string; patch: Partial<Debt> }
  | { type: 'debt/remove'; id: string }
  | { type: 'networth/add'; snapshot: Omit<NetWorthSnapshot, 'id'> }
  | { type: 'networth/remove'; id: string }
  | { type: 'settings/update'; patch: Partial<Settings> }
  | { type: 'state/replace'; state: AppState }
  | { type: 'state/reset' }
  | { type: 'state/seed' };

/** Derives the due date a posting override should carry for a given cycle. */
function dueDateFor(state: AppState, expenseId: string, cycleKey: CycleKey): string {
  const expense = state.expenses.find((e) => e.id === expenseId);
  const { year, month1 } = parseCycleKey(cycleKey);
  const day = clampDayToMonth(expense?.dueDay ?? 1, year, month1);
  return `${cycleKey}-${String(day).padStart(2, '0')}`;
}

/**
 * Writes a posting override, replacing any existing one for the same
 * expense+cycle. Replacing rather than appending is what keeps a bill from
 * posting twice when the user confirms an amount more than once.
 */
function upsertPosting(state: AppState, posting: Posting): Posting[] {
  const rest = state.postings.filter(
    (p) => !(p.expenseId === posting.expenseId && p.cycleKey === posting.cycleKey),
  );
  return [...rest, posting];
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'income/add':
      return { ...state, income: [...state.income, { ...action.entry, id: newId('inc') }] };

    case 'income/update':
      return {
        ...state,
        income: state.income.map((e) => (e.id === action.id ? { ...e, ...action.patch } : e)),
      };

    case 'income/remove':
      return { ...state, income: state.income.filter((e) => e.id !== action.id) };

    case 'expense/add':
      return { ...state, expenses: [...state.expenses, { ...action.entry, id: newId('exp') }] };

    case 'expense/update':
      return {
        ...state,
        expenses: state.expenses.map((e) => (e.id === action.id ? { ...e, ...action.patch } : e)),
      };

    case 'expense/remove':
      return {
        ...state,
        expenses: state.expenses.filter((e) => e.id !== action.id),
        // Drop the expense's posting overrides too, or they would linger as
        // orphans and quietly resurrect if an id were ever reused.
        postings: state.postings.filter((p) => p.expenseId !== action.id),
      };

    case 'posting/confirm':
      return {
        ...state,
        postings: upsertPosting(state, {
          id: newId('post'),
          expenseId: action.expenseId,
          cycleKey: action.cycleKey,
          amountCents: action.amountCents,
          dueDate: dueDateFor(state, action.expenseId, action.cycleKey),
          status: 'posted',
        }),
        // A confirmed amount becomes the template's new default, so next cycle
        // starts from the most recent real figure rather than the original one.
        expenses: state.expenses.map((e) =>
          e.id === action.expenseId ? { ...e, amountCents: action.amountCents } : e,
        ),
      };

    case 'posting/skip':
      return {
        ...state,
        postings: upsertPosting(state, {
          id: newId('post'),
          expenseId: action.expenseId,
          cycleKey: action.cycleKey,
          amountCents: 0,
          dueDate: dueDateFor(state, action.expenseId, action.cycleKey),
          status: 'skipped',
        }),
      };

    case 'posting/reset':
      return {
        ...state,
        postings: state.postings.filter(
          (p) => !(p.expenseId === action.expenseId && p.cycleKey === action.cycleKey),
        ),
      };

    case 'category/add':
      return { ...state, categories: [...state.categories, action.category] };

    case 'category/update':
      return {
        ...state,
        categories: state.categories.map((c) => (c.id === action.id ? { ...c, ...action.patch } : c)),
      };

    case 'category/remove': {
      const target = state.categories.find((c) => c.id === action.id);
      if (!target || target.builtIn) return state;
      return {
        ...state,
        categories: state.categories.filter((c) => c.id !== action.id),
        // Reassign rather than orphan: an expense pointing at a deleted category
        // would vanish from every breakdown while still counting in the totals.
        expenses: state.expenses.map((e) =>
          e.categoryId === action.id ? { ...e, categoryId: 'misc' } : e,
        ),
      };
    }

    case 'goal/add':
      return { ...state, goals: [...state.goals, { ...action.goal, id: newId('goal') }] };

    case 'goal/update':
      return {
        ...state,
        goals: state.goals.map((g) => (g.id === action.id ? { ...g, ...action.patch } : g)),
      };

    case 'goal/remove':
      return { ...state, goals: state.goals.filter((g) => g.id !== action.id) };

    case 'debt/add':
      return { ...state, debts: [...state.debts, { ...action.debt, id: newId('debt') }] };

    case 'debt/update':
      return {
        ...state,
        debts: state.debts.map((d) => (d.id === action.id ? { ...d, ...action.patch } : d)),
      };

    case 'debt/remove':
      return { ...state, debts: state.debts.filter((d) => d.id !== action.id) };

    case 'networth/add':
      return {
        ...state,
        netWorth: [...state.netWorth, { ...action.snapshot, id: newId('nw') }].sort((a, b) =>
          a.date < b.date ? -1 : 1,
        ),
      };

    case 'networth/remove':
      return { ...state, netWorth: state.netWorth.filter((n) => n.id !== action.id) };

    case 'settings/update':
      return { ...state, settings: { ...state.settings, ...action.patch } };

    case 'state/replace':
      return action.state;

    case 'state/reset':
      return seedState();

    case 'state/seed':
      return seedState();

    default:
      return state;
  }
}

interface StoreValue {
  state: AppState;
  dispatch: Dispatch<Action>;
}

const StoreContext = createContext<StoreValue | null>(null);

/** First run gets the demo data — an empty dashboard teaches nothing. */
function initialState(): AppState {
  return loadState() ?? seedState();
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);

  useEffect(() => {
    saveState(state);
  }, [state]);

  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error('useStore must be used inside a StoreProvider');
  return value;
}
