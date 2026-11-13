import type { AppState, ISODate, Period } from '../types';
import { findCategory } from './categories';
import { monthPeriod, shiftCycle, cycleKeyOf } from './dates';
import { allLines, computeSnapshot } from './finance';
import { toDollars } from './money';
import { depreciate } from './business/accounting';

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

/**
 * The depreciation register for one year.
 *
 * A preparer asks for exactly these columns, so they are what the file carries:
 * what the asset cost, when it went into service, the method, this year's
 * charge, accumulated depreciation and the closing book value. The figures are
 * book depreciation — tax depreciation follows its own schedules — and the file
 * says so in a trailing note rather than leaving that to be assumed.
 */
export function depreciationCsv(state: AppState, year: number): string {
  const rows: (string | number)[][] = [
    [
      'Asset',
      'Placed in service',
      'Method',
      'Cost',
      'Salvage',
      'Life (years)',
      'Year of life',
      `${year} depreciation`,
      'Accumulated',
      'Book value',
    ],
  ];

  let charge = 0;
  let book = 0;

  for (const asset of state.assets) {
    const schedule = depreciate({
      method: asset.method,
      costCents: asset.costCents,
      salvageCents: asset.salvageCents,
      lifeYears: asset.lifeYears,
      factor: asset.factor,
      totalUnits: asset.totalUnits,
      unitsPerPeriod: asset.unitsPerPeriod,
    });
    const index = year - Number(asset.placedInService.slice(0, 4));
    const row = schedule.rows[index] ?? null;
    const thisYear = row?.expenseCents ?? 0;
    const closing = row?.closingBookValueCents ?? schedule.endingBookValueCents;
    charge += thisYear;
    book += closing;

    rows.push([
      asset.name,
      asset.placedInService,
      asset.method,
      toDollars(asset.costCents).toFixed(2),
      toDollars(asset.salvageCents).toFixed(2),
      asset.lifeYears,
      row ? index + 1 : 'fully depreciated',
      toDollars(thisYear).toFixed(2),
      toDollars(row?.accumulatedCents ?? schedule.totalExpenseCents).toFixed(2),
      toDollars(closing).toFixed(2),
    ]);
  }

  rows.push([]);
  rows.push(['Total', '', '', '', '', '', '', toDollars(charge).toFixed(2), '', toDollars(book).toFixed(2)]);
  rows.push([]);
  rows.push([
    'Note',
    'Book depreciation for management accounts. Tax depreciation follows separate schedules (in the US, MACRS class lives and conventions) — take this to a preparer rather than onto a return.',
  ]);

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
