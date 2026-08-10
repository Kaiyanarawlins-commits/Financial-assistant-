import type { AppState, ISODate, Period } from '../types';
import { findCategory } from './categories';
import { monthPeriod, shiftCycle, cycleKeyOf } from './dates';
import { allLines, computeSnapshot } from './finance';
import { toDollars } from './money';

/**
 * CSV export for tax prep and record keeping.
 *
 * Two shapes, because they answer different questions: a transaction list for
 * anyone reconstructing a year, and a category summary for the one-page view a
 * preparer actually wants.
 */

function escapeCsv(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows: (string | number)[][]): string {
  return rows.map((row) => row.map(escapeCsv).join(',')).join('\n');
}

export function yearPeriod(year: number): Period {
  return { start: `${year}-01-01`, end: `${year}-12-31`, label: String(year) };
}

/** Every transaction in the period, one row each. */
export function transactionsCsv(state: AppState, period: Period, reference: ISODate): string {
  const lines = allLines(state, period, reference);
  const rows: (string | number)[][] = [
    ['Date', 'Name', 'Category', 'Type', 'Amount'],
    ...lines.map((line) => [
      line.date,
      line.name,
      findCategory(state.categories, line.categoryId).name,
      line.recurrence === 'recurring' ? 'Recurring' : 'One-time',
      toDollars(line.amountCents).toFixed(2),
    ]),
  ];
  return toCsv(rows);
}

/** Annual totals by category, with each category's share of the year's spend. */
export function categorySummaryCsv(state: AppState, period: Period, reference: ISODate): string {
  const snapshot = computeSnapshot(state, period, reference);
  const rows: (string | number)[][] = [
    ['Category', 'Total', 'Percent of spend'],
    ...snapshot.categories.map((c) => [
      c.name,
      toDollars(c.spentCents).toFixed(2),
      c.percent.toFixed(1),
    ]),
    [],
    ['Total income', toDollars(snapshot.totalIncomeCents).toFixed(2), ''],
    ['Total spent', toDollars(snapshot.totalSpentCents).toFixed(2), ''],
    ['Net', toDollars(snapshot.remainingBalanceCents).toFixed(2), ''],
  ];
  return toCsv(rows);
}

/** Month-by-month income, spend and net across the period's year. */
export function monthlySummaryCsv(state: AppState, year: number, reference: ISODate): string {
  const rows: (string | number)[][] = [['Month', 'Income', 'Spent', 'Net']];
  for (let month = 1; month <= 12; month++) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    if (key > cycleKeyOf(reference)) break;
    const period = monthPeriod(key);
    const asOf = key === cycleKeyOf(reference) ? reference : period.end;
    const snapshot = computeSnapshot(state, period, asOf);
    rows.push([
      key,
      toDollars(snapshot.totalIncomeCents).toFixed(2),
      toDollars(snapshot.totalSpentCents).toFixed(2),
      toDollars(snapshot.remainingBalanceCents).toFixed(2),
    ]);
  }
  return toCsv(rows);
}

/** Triggers a browser download without needing a server round-trip. */
export function downloadFile(filename: string, contents: string, mime = 'text/csv'): void {
  const blob = new Blob([contents], { type: `${mime};charset=utf-8;` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export { shiftCycle };
