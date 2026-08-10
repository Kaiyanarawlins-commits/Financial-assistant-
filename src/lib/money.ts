/** Money helpers. Cents in, strings out — see `types.ts` for why cents. */

export function toCents(dollars: number | string): number {
  const n = typeof dollars === 'string' ? Number(dollars.replace(/[^0-9.\-]/g, '')) : dollars;
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function toDollars(cents: number): number {
  return cents / 100;
}

const withCents = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const whole = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export function formatMoney(cents: number): string {
  return withCents.format(cents / 100);
}

/** Drops the cents when they are zero — the headline figure reads better. */
export function formatMoneyCompact(cents: number): string {
  return cents % 100 === 0 ? whole.format(cents / 100) : withCents.format(cents / 100);
}

export function formatSigned(cents: number): string {
  const sign = cents > 0 ? '+' : cents < 0 ? '-' : '';
  return `${sign}${formatMoney(Math.abs(cents))}`;
}

export function formatPercent(value: number, digits = 0): string {
  return `${value.toFixed(digits)}%`;
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function sumBy<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}
