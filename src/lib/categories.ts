import type { Category } from '../types';

/**
 * The default category list from the spec. Users can rename, recolour, add and
 * remove their own; the built-ins are protected from deletion so existing
 * expenses can never end up pointing at a category that no longer exists.
 *
 * Colours are the categorical ramp — chosen to stay distinguishable against
 * both the light and dark surfaces, and ordered so adjacent slices of the donut
 * do not read as the same hue.
 */
export const DEFAULT_CATEGORIES: Category[] = [
  { id: 'housing', name: 'Housing', color: '#4f7cff', builtIn: true },
  { id: 'insurance', name: 'Insurance', color: '#8b5cf6', builtIn: true },
  { id: 'auto', name: 'Auto/Transportation', color: '#06b6d4', builtIn: true },
  { id: 'groceries', name: 'Groceries', color: '#10b981', builtIn: true },
  { id: 'utilities', name: 'Utilities', color: '#f59e0b', builtIn: true },
  { id: 'subscriptions', name: 'Subscriptions', color: '#ec4899', builtIn: true },
  { id: 'entertainment', name: 'Entertainment', color: '#f43f5e', builtIn: true },
  { id: 'travel', name: 'Travel', color: '#0ea5e9', builtIn: true },
  { id: 'dining', name: 'Dining Out', color: '#fb923c', builtIn: true },
  { id: 'health', name: 'Health/Medical', color: '#22c55e', builtIn: true },
  { id: 'debt', name: 'Debt Payments', color: '#a855f7', builtIn: true },
  { id: 'savings', name: 'Savings/Investing', color: '#14b8a6', builtIn: true },
  { id: 'misc', name: 'Miscellaneous', color: '#94a3b8', builtIn: true },
];

/** Colours offered when the user creates a custom category. */
export const CATEGORY_COLORS = [
  '#4f7cff', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ec4899',
  '#f43f5e', '#0ea5e9', '#fb923c', '#22c55e', '#a855f7', '#14b8a6',
  '#eab308', '#64748b', '#d946ef', '#84cc16',
];

export const FALLBACK_CATEGORY: Category = {
  id: 'misc',
  name: 'Uncategorised',
  color: '#94a3b8',
  builtIn: true,
};

export function findCategory(categories: Category[], id: string): Category {
  return categories.find((c) => c.id === id) ?? FALLBACK_CATEGORY;
}

/** A stable id derived from a user-supplied name, de-duplicated against existing ids. */
export function categoryIdFromName(name: string, existing: Category[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'category';
  if (!existing.some((c) => c.id === base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.some((c) => c.id === candidate)) return candidate;
  }
}
