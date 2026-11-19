import { useState } from 'react';
import type { Category, ExpenseEntry, IncomeEntry, IncomeSchedule, Recurrence } from '../types';
import { today } from '../lib/dates';
import { formatMoney, toCents, toDollars } from '../lib/money';
import { Field, Sheet } from './ui';

/**
 * Entry forms.
 *
 * Optimised for speed of entry, which the spec puts above everything else: the
 * amount field is autofocused and numeric, categories are one tap each rather
 * than a dropdown, and every field except amount has a working default. Adding
 * "Coffee, $6, Dining, one-time" is three taps and a number.
 */

function CategoryPicker({
  categories,
  value,
  onChange,
}: {
  categories: Category[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="field">
      <span className="field__label">Category</span>
      <div className="row row--wrap" style={{ gap: 7 }}>
        {categories.map((category) => {
          const selected = category.id === value;
          return (
            <button
              key={category.id}
              type="button"
              className="chip"
              onClick={() => onChange(category.id)}
              aria-pressed={selected}
              style={
                selected
                  ? {
                      borderColor: category.color,
                      background: `color-mix(in srgb, ${category.color} 16%, transparent)`,
                      color: 'var(--text)',
                    }
                  : undefined
              }
            >
              <span
                className="dot"
                style={{ background: category.color, display: 'inline-block', marginRight: 6 }}
                aria-hidden="true"
              />
              {category.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expense
// ---------------------------------------------------------------------------

export interface ExpenseDraft {
  name: string;
  amountCents: number;
  categoryId: string;
  recurrence: Recurrence;
  dueDay?: number;
  date?: string;
  variable?: boolean;
  billGroup?: string;
}

export function ExpenseSheet({
  categories,
  groups = [],
  initial,
  onSave,
  onDelete,
  onClose,
}: {
  categories: Category[];
  /** Bill group names already in use, offered as suggestions. */
  groups?: string[];
  initial?: ExpenseEntry;
  onSave: (draft: ExpenseDraft) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState(initial ? String(toDollars(initial.amountCents)) : '');
  const [name, setName] = useState(initial?.name ?? '');
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? categories[0]?.id ?? 'misc');
  const [recurrence, setRecurrence] = useState<Recurrence>(initial?.recurrence ?? 'one-time');
  const [dueDay, setDueDay] = useState(String(initial?.dueDay ?? 1));
  const [date, setDate] = useState(initial?.date ?? today());
  const [variable, setVariable] = useState(Boolean(initial?.variable));
  const [billGroup, setBillGroup] = useState(initial?.billGroup ?? '');

  const amountCents = toCents(amount);
  const valid = amountCents > 0;

  const submit = () => {
    if (!valid) return;
    onSave({
      name: name.trim() || defaultName(categories, categoryId),
      amountCents,
      categoryId,
      recurrence,
      ...(recurrence === 'recurring'
        ? { dueDay: clampDay(dueDay), variable, billGroup: billGroup.trim() || undefined }
        : { date }),
    });
  };

  return (
    <Sheet
      title={initial ? 'Edit expense' : 'Add expense'}
      onClose={onClose}
      footer={
        <div className="row" style={{ gap: 8 }}>
          {onDelete && (
            <button type="button" className="btn btn--danger" onClick={onDelete}>
              Delete
            </button>
          )}
          <button type="button" className="btn btn--primary grow" onClick={submit} disabled={!valid}>
            {initial ? 'Save changes' : 'Add expense'}
          </button>
        </div>
      }
    >
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field label="Amount">
          <input
            className="input input--amount"
            inputMode="decimal"
            autoFocus
            placeholder="$0.00"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            aria-label="Amount"
          />
        </Field>

        <CategoryPicker categories={categories} value={categoryId} onChange={setCategoryId} />

        <div className="field">
          <span className="field__label">Type</span>
          <div className="seg" role="group" aria-label="Expense type" style={{ width: '100%' }}>
            {(
              [
                { value: 'one-time', label: 'One-time' },
                { value: 'recurring', label: 'Recurring monthly' },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                className="seg__btn grow"
                aria-pressed={recurrence === option.value}
                onClick={() => setRecurrence(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <Field label="Name" hint="Optional — defaults to the category name.">
          <input
            className="input"
            value={name}
            placeholder={defaultName(categories, categoryId)}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        {recurrence === 'recurring' ? (
          <>
            <Field label="Bills on day of month" hint="Months that are too short bill on their last day.">
              <input
                className="input"
                type="number"
                min={1}
                max={31}
                value={dueDay}
                onChange={(event) => setDueDay(event.target.value)}
              />
            </Field>
            <label className="row" style={{ gap: 9, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={variable}
                onChange={(event) => setVariable(event.target.checked)}
              />
              <span className="small">
                Amount changes each month
                <span className="faint"> — ask me to confirm before it posts</span>
              </span>
            </label>
            <Field
              label="Bill group (optional)"
              hint="Groups this bill on the Bills view. Leave blank to group it by category."
            >
              <input
                className="input"
                list="bill-groups"
                placeholder={defaultName(categories, categoryId)}
                value={billGroup}
                onChange={(event) => setBillGroup(event.target.value)}
              />
              <datalist id="bill-groups">
                {groups.map((group) => (
                  <option key={group} value={group} />
                ))}
              </datalist>
            </Field>
          </>
        ) : (
          <Field label="Date">
            <input className="input" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </Field>
        )}
      </form>
    </Sheet>
  );
}

function defaultName(categories: Category[], categoryId: string): string {
  return categories.find((c) => c.id === categoryId)?.name ?? 'Expense';
}

function clampDay(value: string): number {
  const day = Number(value);
  if (!Number.isFinite(day)) return 1;
  return Math.min(31, Math.max(1, Math.round(day)));
}

// ---------------------------------------------------------------------------
// Income
// ---------------------------------------------------------------------------

export interface IncomeDraft {
  source: string;
  amountCents: number;
  recurrence: Recurrence;
  schedule: IncomeSchedule;
}

type ScheduleKind = 'monthly-days' | 'biweekly' | 'weekly' | 'one-time';

export function IncomeSheet({
  initial,
  onSave,
  onDelete,
  onClose,
}: {
  initial?: IncomeEntry;
  onSave: (draft: IncomeDraft) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState(initial ? String(toDollars(initial.amountCents)) : '');
  const [source, setSource] = useState(initial?.source ?? '');
  const [kind, setKind] = useState<ScheduleKind>(initial?.schedule.kind ?? 'monthly-days');
  const [days, setDays] = useState<number[]>(
    initial?.schedule.kind === 'monthly-days' ? initial.schedule.days : [1, 15],
  );
  const [anchor, setAnchor] = useState(
    initial?.schedule.kind === 'biweekly' || initial?.schedule.kind === 'weekly'
      ? initial.schedule.anchor
      : today(),
  );
  const [onceDate, setOnceDate] = useState(
    initial?.schedule.kind === 'one-time' ? initial.schedule.date : today(),
  );

  const amountCents = toCents(amount);
  const valid = amountCents > 0 && (kind !== 'monthly-days' || days.length > 0);

  const buildSchedule = (): IncomeSchedule => {
    switch (kind) {
      case 'monthly-days':
        return { kind: 'monthly-days', days: [...days].sort((a, b) => a - b) };
      case 'biweekly':
        return { kind: 'biweekly', anchor };
      case 'weekly':
        return { kind: 'weekly', anchor };
      case 'one-time':
        return { kind: 'one-time', date: onceDate };
    }
  };

  const submit = () => {
    if (!valid) return;
    onSave({
      source: source.trim() || 'Income',
      amountCents,
      recurrence: kind === 'one-time' ? 'one-time' : 'recurring',
      schedule: buildSchedule(),
    });
  };

  const monthlyEstimate =
    kind === 'monthly-days'
      ? amountCents * days.length
      : kind === 'biweekly'
        ? Math.round(amountCents * 2.167)
        : kind === 'weekly'
          ? Math.round(amountCents * 4.33)
          : amountCents;

  return (
    <Sheet
      title={initial ? 'Edit income' : 'Add income'}
      onClose={onClose}
      footer={
        <div className="row" style={{ gap: 8 }}>
          {onDelete && (
            <button type="button" className="btn btn--danger" onClick={onDelete}>
              Delete
            </button>
          )}
          <button type="button" className="btn btn--primary grow" onClick={submit} disabled={!valid}>
            {initial ? 'Save changes' : 'Add income'}
          </button>
        </div>
      }
    >
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field label="Amount per payment">
          <input
            className="input input--amount"
            inputMode="decimal"
            autoFocus
            placeholder="$0.00"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            aria-label="Amount per payment"
          />
        </Field>

        <Field label="Source">
          <input
            className="input"
            value={source}
            placeholder="Paycheck, freelance, side gig…"
            onChange={(event) => setSource(event.target.value)}
          />
        </Field>

        <Field label="How often">
          <select
            className="select"
            value={kind}
            onChange={(event) => setKind(event.target.value as ScheduleKind)}
          >
            <option value="monthly-days">Monthly, on set days</option>
            <option value="biweekly">Every two weeks</option>
            <option value="weekly">Weekly</option>
            <option value="one-time">One-time</option>
          </select>
        </Field>

        {kind === 'monthly-days' && (
          <div className="field">
            <span className="field__label">Paid on</span>
            <div className="row row--wrap" style={{ gap: 6 }}>
              {[1, 5, 10, 15, 20, 25, 28, 31].map((day) => {
                const selected = days.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    className="chip"
                    aria-pressed={selected}
                    onClick={() =>
                      setDays((current) =>
                        current.includes(day) ? current.filter((d) => d !== day) : [...current, day],
                      )
                    }
                    style={
                      selected
                        ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)', color: 'var(--text)' }
                        : undefined
                    }
                  >
                    {ordinal(day)}
                  </button>
                );
              })}
            </div>
            <span className="tiny faint">Pick every day you get paid — twice-monthly pay is two days.</span>
          </div>
        )}

        {(kind === 'biweekly' || kind === 'weekly') && (
          <Field label="Most recent payday" hint="Future paydays are counted forward from this date.">
            <input className="input" type="date" value={anchor} onChange={(event) => setAnchor(event.target.value)} />
          </Field>
        )}

        {kind === 'one-time' && (
          <Field label="Date received">
            <input className="input" type="date" value={onceDate} onChange={(event) => setOnceDate(event.target.value)} />
          </Field>
        )}

        {amountCents > 0 && (
          <div className="alert">
            <span className="grow small">
              {kind === 'one-time' ? 'One payment of ' : 'Roughly '}
              <strong>{formatMoney(monthlyEstimate)}</strong>
              {kind === 'one-time' ? '' : ' per month'}
            </span>
          </div>
        )}
      </form>
    </Sheet>
  );
}

function ordinal(day: number): string {
  if (day === 31) return 'Last';
  const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  return `${day}${suffix}`;
}
