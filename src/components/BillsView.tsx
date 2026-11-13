import { useMemo, useState } from 'react';
import { useStore } from '../state/store';
import { billsOverview, type BillGroup, type BillLine } from '../lib/bills';
import { formatMoney, formatMoneyCompact, formatPercent, toCents } from '../lib/money';
import { cycleKeyOf, formatShort } from '../lib/dates';
import {
  availability,
  describeAvailability,
  disableReminders,
  loadPushConfig,
  requestPermission,
  syncReminders,
} from '../lib/push/client';
import { Card, ChevronIcon, EmptyState, Field, Toggle } from './ui';

/**
 * Bills.
 *
 * Everything here already existed somewhere: the next few days were on the
 * dashboard, the list was on the Money tab, and the reminder switch was six
 * cards into Settings. Three true views of one subject and nowhere that
 * answered the question people actually have, which is what do I pay every
 * month, when does it land, and what is about to.
 *
 * So this is one screen with the whole picture, and the reminder controls sit
 * next to the bills they are about rather than in a settings page nobody
 * scrolls to.
 */
export function BillsView({ reference, onEditExpense }: { reference: string; onEditExpense: (id: string) => void }) {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState<string | null>(null);

  const overview = useMemo(
    () => billsOverview(state, reference),
    [state, reference],
  );

  if (overview.count === 0) {
    return (
      <Card>
        <EmptyState title="No recurring bills yet">
          Add an expense and mark it as recurring, and it will appear here with the date it lands,
          what it costs you a month, and a reminder before it does.
        </EmptyState>
      </Card>
    );
  }

  return (
    <div className="stack">
      <Card>
        <div className="row row--between" style={{ alignItems: 'flex-start' }}>
          <span>
            <div className="card__title" style={{ marginBottom: 2 }}>Bills every month</div>
            <div className="tnum" style={{ fontSize: 32, fontWeight: 750, letterSpacing: '-0.03em' }}>
              {formatMoney(overview.monthlyTotalCents)}
            </div>
            <div className="tiny faint">
              {overview.count} recurring {overview.count === 1 ? 'bill' : 'bills'} across{' '}
              {overview.groups.length} {overview.groups.length === 1 ? 'group' : 'groups'}
            </div>
          </span>
          {overview.next && (
            <span className="right">
              <div className="tiny faint">Next up</div>
              <div style={{ fontWeight: 650 }}>{overview.next.name}</div>
              <div className="tiny faint">{overview.next.whenLabel}</div>
            </span>
          )}
        </div>

        {overview.dueSoon.length > 0 && (
          <div className="alert alert--warning" style={{ marginTop: 14 }}>
            <span className="grow small">
              <strong>
                {formatMoney(overview.dueSoonTotalCents)} due in the next{' '}
                {state.settings.reminderLeadDays}{' '}
                {state.settings.reminderLeadDays === 1 ? 'day' : 'days'}
              </strong>
              <span style={{ display: 'block', marginTop: 2 }} className="tiny">
                {overview.dueSoon.map((bill) => `${bill.name} ${bill.whenLabel}`).join(' · ')}
              </span>
            </span>
          </div>
        )}

        {overview.needsConfirmation.length > 0 && (
          <div className="tiny warn" style={{ marginTop: 10 }}>
            {overview.needsConfirmation.length}{' '}
            {overview.needsConfirmation.length === 1 ? 'bill varies' : 'bills vary'} month to month
            and still {overview.needsConfirmation.length === 1 ? 'needs' : 'need'} confirming — the
            dashboard will ask.
          </div>
        )}
      </Card>

      <ReminderStrip reference={reference} />

      {overview.groups.map((group) => (
        <GroupCard
          key={group.name}
          group={group}
          open={open === group.name}
          onToggle={() => setOpen(open === group.name ? null : group.name)}
          onEdit={onEditExpense}
          onConfirm={(bill, amountCents) =>
            dispatch({
              type: 'posting/confirm',
              expenseId: bill.expenseId,
              cycleKey: cycleKeyOf(bill.nextDueDate),
              amountCents,
            })
          }
        />
      ))}
    </div>
  );
}

function GroupCard({
  group,
  open,
  onToggle,
  onEdit,
  onConfirm,
}: {
  group: BillGroup;
  open: boolean;
  onToggle: () => void;
  onEdit: (id: string) => void;
  onConfirm: (bill: BillLine, amountCents: number) => void;
}) {
  return (
    <Card flush>
      <button
        type="button"
        className="catrow"
        aria-expanded={open}
        onClick={onToggle}
        style={{ borderBottom: open ? '1px solid var(--border)' : 0 }}
      >
        <span className="grow">
          <div style={{ fontWeight: 650 }}>{group.name}</div>
          <div className="tiny faint">
            {/* A group of one has nothing to summarise, so show the bill's own
                date instead of making the user expand it to find out. */}
            {group.bills.length === 1 && group.bills[0] ? (
              <>
                {formatShort(group.bills[0].nextDueDate)} ·{' '}
                <span className={group.bills[0].daysAway <= 3 ? 'warn' : undefined}>
                  {group.bills[0].whenLabel}
                </span>
              </>
            ) : (
              <>
                {group.bills.length} bills
                {group.dueSoonCount > 0 && ` · ${group.dueSoonCount} due soon`}
              </>
            )}
          </div>
          <div className="catrow__bar" style={{ marginTop: 7 }}>
            <div
              className="catrow__bar-fill"
              style={{ width: `${Math.max(2, group.percentOfBills)}%`, background: 'var(--accent)' }}
            />
          </div>
        </span>
        <span className="right">
          <div className="catrow__amount">{formatMoneyCompact(group.monthlyTotalCents)}</div>
          <div className="catrow__pct">{formatPercent(group.percentOfBills, 0)}</div>
        </span>
        <ChevronIcon />
      </button>

      {open &&
        group.bills.map((bill) => (
          <BillRow key={bill.expenseId} bill={bill} onEdit={onEdit} onConfirm={onConfirm} />
        ))}
    </Card>
  );
}

function BillRow({
  bill,
  onEdit,
  onConfirm,
}: {
  bill: BillLine;
  onEdit: (id: string) => void;
  onConfirm: (bill: BillLine, amountCents: number) => void;
}) {
  const [draft, setDraft] = useState('');

  return (
    <div className="ledger" style={{ display: 'block' }}>
      <div className="row row--between">
        <button
          type="button"
          className="grow"
          style={{ background: 'none', border: 0, textAlign: 'left', padding: 0 }}
          onClick={() => onEdit(bill.expenseId)}
        >
          <div className="ledger__name">{bill.name}</div>
          <div className="ledger__meta">
            <span>{formatShort(bill.nextDueDate)}</span>
            <span>·</span>
            <span className={bill.daysAway <= 3 ? 'warn' : undefined}>{bill.whenLabel}</span>
            {bill.variable && <span className="pill pill--warn">varies</span>}
          </div>
        </button>
        <span className="ledger__amount">{formatMoney(bill.amountCents)}</span>
      </div>

      {bill.needsConfirmation && (
        <div className="row" style={{ gap: 8, marginTop: 9 }}>
          <input
            className="input grow"
            inputMode="decimal"
            placeholder={String(bill.amountCents / 100)}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label={`Actual amount for ${bill.name}`}
          />
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={toCents(draft) <= 0}
            onClick={() => onConfirm(bill, toCents(draft))}
          >
            Confirm
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The reminder controls, next to the bills rather than in Settings.
 *
 * Deliberately a strip and not a full panel: the server fields stay in
 * Settings, because they are configured once and this is the screen someone
 * opens when they want to know what is due.
 */
function ReminderStrip({ reference }: { reference: string }) {
  const { state, dispatch } = useStore();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const config = loadPushConfig();

  const enabled = state.settings.billRemindersEnabled;

  const toggle = async (next: boolean) => {
    setBusy(true);
    setStatus(null);
    try {
      dispatch({ type: 'settings/update', patch: { billRemindersEnabled: next } });
      if (!next) {
        await disableReminders(config);
        return;
      }
      const after = await requestPermission(config);
      if (after !== 'ready') {
        setStatus(describeAvailability(after));
        return;
      }
      const result = await syncReminders(
        { ...state, settings: { ...state.settings, billRemindersEnabled: true } },
        reference,
        config,
      );
      setStatus(
        result.ok
          ? `Scheduled ${result.scheduled} ${result.scheduled === 1 ? 'reminder' : 'reminders'}.`
          : (result.error ?? null),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Toggle
        label="Remind me before bills land"
        hint="Always shown here and on the dashboard. Turn on to be notified when the app is closed."
        checked={enabled}
        onChange={(next) => void toggle(next)}
      />
      <div style={{ paddingTop: 12 }}>
        <Field label="How much warning">
          <select
            className="select"
            value={state.settings.reminderLeadDays}
            onChange={(event) =>
              dispatch({
                type: 'settings/update',
                patch: { reminderLeadDays: Number(event.target.value) },
              })
            }
          >
            {[1, 2, 3, 5, 7, 14].map((days) => (
              <option key={days} value={days}>
                {days} {days === 1 ? 'day' : 'days'} before
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="tiny faint" style={{ marginTop: 8 }}>
        {busy ? 'Working…' : (status ?? describeAvailability(availability(config)))}
      </div>
    </Card>
  );
}
