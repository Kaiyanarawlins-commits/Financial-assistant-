import { useRef, useState } from 'react';
import { useStore } from '../state/store';
import { CATEGORY_COLORS, categoryIdFromName } from '../lib/categories';
import { today } from '../lib/dates';
import {
  categorySummaryCsv,
  depreciationCsv,
  downloadFile,
  monthlySummaryCsv,
  transactionsCsv,
  yearPeriod,
} from '../lib/exporter';
import { formatMoney, toCents, toDollars } from '../lib/money';
import { deserializeState, serializeState } from '../lib/storage';
import { getAuthProvider, getAuthServerUrl, setAuthServerUrl, type Session } from '../lib/auth';
import {
  MODEL_OPTIONS,
  defaultAdvisorConfig,
  loadAdvisorConfig,
  saveAdvisorConfig,
  type AdvisorConfig,
} from '../lib/advisorConfig';
import {
  availability,
  describeAvailability,
  disableReminders,
  loadPushConfig,
  requestPermission,
  savePushConfig,
  syncReminders,
  type PushConfig,
} from '../lib/push/client';
import { buildReminders } from '../lib/push/schedule';
import { AlertIcon, Card, Field, InfoIcon, PlusIcon, Segmented, Sheet, Toggle } from './ui';

/** Settings: account, modes, categories and caps, data export and reset. */
export function SettingsView({
  reference,
  session,
  onSignOut,
}: {
  reference: string;
  session: Session;
  onSignOut: () => void;
}) {
  const { state, dispatch } = useStore();
  const [editingCategory, setEditingCategory] = useState<string | null>(null);
  const [addingCategory, setAddingCategory] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [balanceDraft, setBalanceDraft] = useState(
    state.settings.accountBalanceCents !== undefined
      ? String(toDollars(state.settings.accountBalanceCents))
      : '',
  );
  const year = Number(reference.slice(0, 4));

  const category = state.categories.find((c) => c.id === editingCategory);

  return (
    <div className="stack">
      <AccountCard session={session} onSignOut={onSignOut} />

      <Card title="Appearance">
        <div className="row row--between row--wrap" style={{ gap: 10 }}>
          <span className="grow small muted" style={{ minWidth: 160 }}>
            System follows your device's light/dark setting and changes with it.
          </span>
          <Segmented
            ariaLabel="Colour scheme"
            value={state.settings.theme ?? 'system'}
            onChange={(theme) => dispatch({ type: 'settings/update', patch: { theme } })}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </div>
      </Card>

      <AdvisorSettings />

      <Card title="Account balance">
        <p className="small muted" style={{ marginBottom: 12 }}>
          Safe-to-spend is only exact if it knows what you actually have. Enter your balance and the date it was
          true — the app rolls it forward with your paydays and spending from there. Leave it blank and safe-to-spend
          falls back to assuming each month opens at zero, which understates your cash mid-month.
        </p>
        <div className="grid-2">
          <Field label="Balance">
            <input
              className="input"
              inputMode="decimal"
              placeholder="Not set"
              value={balanceDraft}
              onChange={(event) => setBalanceDraft(event.target.value)}
              onBlur={() => {
                const trimmed = balanceDraft.trim();
                dispatch({
                  type: 'settings/update',
                  patch: trimmed
                    ? {
                        accountBalanceCents: toCents(trimmed),
                        accountBalanceAsOf: state.settings.accountBalanceAsOf ?? reference,
                      }
                    : { accountBalanceCents: undefined, accountBalanceAsOf: undefined },
                });
              }}
            />
          </Field>
          <Field label="As of">
            <input
              className="input"
              type="date"
              value={state.settings.accountBalanceAsOf ?? reference}
              onChange={(event) =>
                dispatch({ type: 'settings/update', patch: { accountBalanceAsOf: event.target.value } })
              }
            />
          </Field>
        </div>
      </Card>

      <Card title="How the numbers behave">
        <Toggle
          label="Paycheck-to-paycheck buffer"
          hint="Safe-to-spend holds back only the bills due before your next payday, instead of every bill left this month."
          checked={state.settings.bufferMode}
          onChange={(bufferMode) => dispatch({ type: 'settings/update', patch: { bufferMode } })}
        />
        <Toggle
          label="Irregular income"
          hint={`For freelance or commission pay — uses a ${state.settings.irregularLookbackMonths}-month trailing average instead of a schedule.`}
          checked={state.settings.irregularIncomeMode}
          onChange={(irregularIncomeMode) => dispatch({ type: 'settings/update', patch: { irregularIncomeMode } })}
        />
        {state.settings.irregularIncomeMode && (
          <div style={{ padding: '12px 0' }}>
            <Field label="Months to average">
              <select
                className="select"
                value={state.settings.irregularLookbackMonths}
                onChange={(event) =>
                  dispatch({
                    type: 'settings/update',
                    patch: { irregularLookbackMonths: Number(event.target.value) },
                  })
                }
              >
                {[3, 4, 5, 6].map((months) => (
                  <option key={months} value={months}>
                    {months} months
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}
        <Toggle
          label="Household mode"
          hint="Labels the budget as shared, for couples or roommates splitting bills."
          checked={state.settings.householdMode}
          onChange={(householdMode) => dispatch({ type: 'settings/update', patch: { householdMode } })}
        />
        <Toggle
          label="Business mode"
          hint="Adds the Business tab: depreciation schedules, inflation and appreciation, break-even and margins, and a market watchlist."
          checked={state.settings.businessMode}
          onChange={(businessMode) => dispatch({ type: 'settings/update', patch: { businessMode } })}
        />
      </Card>

      <ReminderSettings reference={reference} />

      <Card
        title="Categories & spending caps"
        action={
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAddingCategory(true)}>
            <PlusIcon />
            New
          </button>
        }
      >
        <div className="stack" style={{ gap: 0 }}>
          {state.categories.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="ledger"
              style={{ paddingLeft: 0, paddingRight: 0 }}
              onClick={() => setEditingCategory(entry.id)}
            >
              <span className="dot" style={{ background: entry.color, width: 12, height: 12 }} aria-hidden="true" />
              <span className="grow">
                <span className="ledger__name">{entry.name}</span>
                {entry.monthlyCapCents ? (
                  <span className="ledger__meta">
                    <span>{formatMoney(entry.monthlyCapCents)} monthly cap</span>
                  </span>
                ) : (
                  <span className="ledger__meta"><span>No cap set</span></span>
                )}
              </span>
              {!entry.builtIn && <span className="pill">Custom</span>}
            </button>
          ))}
        </div>
      </Card>

      <Card title="Export">
        <p className="small muted" style={{ marginBottom: 12 }}>
          A by-category annual summary is a reasonable starting point for tax prep — a starting point for a
          conversation with a preparer, not a substitute for one.
        </p>
        <div className="row row--wrap" style={{ gap: 8 }}>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() =>
              downloadFile(`cashcompass-${year}-categories.csv`, categorySummaryCsv(state, yearPeriod(year), reference))
            }
          >
            {year} by category
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() =>
              downloadFile(`cashcompass-${year}-transactions.csv`, transactionsCsv(state, yearPeriod(year), reference))
            }
          >
            {year} transactions
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => downloadFile(`cashcompass-${year}-monthly.csv`, monthlySummaryCsv(state, year, reference))}
          >
            {year} by month
          </button>
          {state.settings.businessMode && state.assets.length > 0 && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() =>
                downloadFile(`cashcompass-${year}-depreciation.csv`, depreciationCsv(state, year))
              }
            >
              {year} depreciation
            </button>
          )}
        </div>
      </Card>

      <Card title="Your data">
        <p className="small muted" style={{ marginBottom: 12 }}>
          Everything stays in this browser. Nothing is uploaded, and the advisor never sees account numbers or
          credentials — only amounts and categories.
        </p>
        <div className="row row--wrap" style={{ gap: 8 }}>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => downloadFile(`cashcompass-backup-${today()}.json`, serializeState(state), 'application/json')}
          >
            Download backup
          </button>
          <button type="button" className="btn btn--sm" onClick={() => fileRef.current?.click()}>
            Restore backup
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              const restored = deserializeState(await file.text());
              if (restored) {
                dispatch({ type: 'state/replace', state: restored });
                setImportError(null);
              } else {
                setImportError('That file was not a CashCompass backup.');
              }
              event.target.value = '';
            }}
          />
          <button
            type="button"
            className="btn btn--danger btn--sm"
            onClick={() => {
              if (confirm('Replace everything with fresh demo data? Your current entries will be lost.')) {
                dispatch({ type: 'state/reset' });
              }
            }}
          >
            Reset to demo data
          </button>
        </div>
        {importError && (
          <div className="alert alert--danger" style={{ marginTop: 10 }}>
            <span className="small grow">{importError}</span>
          </div>
        )}
      </Card>

      <Card title="How the two headline figures differ">
        <div className="small muted stack" style={{ gap: 8 }}>
          <p>
            <strong>Remaining balance</strong> is the projection: all income for the period minus every expense in it,
            including bills that have not been paid yet. It answers "how should this month end up?"
          </p>
          <p>
            <strong>Safe-to-spend</strong> is the realistic figure: money actually received, minus money actually
            spent, minus the bills still to land and anything reserved for goals. It answers "what can I spend right
            now without missing something?"
          </p>
          <p>
            Spend against safe-to-spend. The remaining balance is where the month is heading if nothing changes.
          </p>
        </div>
      </Card>

      {(addingCategory || category) && (
        <CategorySheet
          initial={category}
          onClose={() => {
            setAddingCategory(false);
            setEditingCategory(null);
          }}
          onSave={(draft) => {
            if (category) {
              dispatch({ type: 'category/update', id: category.id, patch: draft });
            } else {
              dispatch({
                type: 'category/add',
                category: {
                  id: categoryIdFromName(draft.name, state.categories),
                  name: draft.name,
                  color: draft.color,
                  builtIn: false,
                  monthlyCapCents: draft.monthlyCapCents,
                },
              });
            }
            setAddingCategory(false);
            setEditingCategory(null);
          }}
          onDelete={
            category && !category.builtIn
              ? () => {
                  dispatch({ type: 'category/remove', id: category.id });
                  setEditingCategory(null);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

/**
 * AI advisor configuration.
 *
 * The built-in specialists are the default and need nothing. Connecting Claude
 * swaps the deterministic answers for open-ended reasoning over the same facts
 * and the same tools — the guardrails and the redaction apply either way.
 */
/**
 * Bill reminders.
 *
 * Three things have to be true before a notification can arrive, and the panel
 * says which one is missing rather than offering a switch that silently does
 * nothing. The server fields are here and not hidden because self-hosting the
 * reminder server is the expected path: there is no CashCompass service to
 * sign up to.
 */
function ReminderSettings({ reference }: { reference: string }) {
  const { state, dispatch } = useStore();
  const [config, setConfig] = useState<PushConfig>(loadPushConfig);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const enabled = state.settings.billRemindersEnabled;
  const state0 = availability(config);
  const upcoming = buildReminders(
    { ...state, settings: { ...state.settings, billRemindersEnabled: true } },
    reference,
  );

  const persist = (next: PushConfig) => {
    savePushConfig(next);
    setConfig(next);
  };

  const turnOn = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const after = await requestPermission(config);
      dispatch({ type: 'settings/update', patch: { billRemindersEnabled: true } });
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
          : (result.error ?? 'Could not schedule reminders.'),
      );
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    dispatch({ type: 'settings/update', patch: { billRemindersEnabled: false } });
    await disableReminders(config);
    setStatus(null);
    setBusy(false);
  };

  return (
    <Card title="Bill reminders">
      <Toggle
        label="Notify me when bills are due"
        hint="Reminders always show on the dashboard. This also sends them to your device when the app is closed."
        checked={enabled}
        onChange={(next) => void (next ? turnOn() : turnOff())}
      />

      <div className="tiny faint" style={{ padding: '10px 0 2px' }}>
        {busy ? 'Working…' : (status ?? describeAvailability(state0))}
      </div>

      <div style={{ padding: '12px 0 0' }}>
        <Field label="Warn me this many days before a bill is due">
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
                {days} {days === 1 ? 'day' : 'days'}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {upcoming.length > 0 && (
        <div className="tiny faint" style={{ marginTop: 10 }}>
          Next up: <strong>{upcoming[0]!.title}</strong> — {upcoming[0]!.body}
          {upcoming.length > 1 && `, and ${upcoming.length - 1} more scheduled.`}
        </div>
      )}

      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
        <div className="grid-2">
          <Field label="Reminder server">
            <input
              className="input"
              placeholder="https://push.example.com"
              value={config.serverUrl}
              onChange={(event) => persist({ ...config, serverUrl: event.target.value.trim() })}
            />
          </Field>
          <Field label="Server public key">
            <input
              className="input"
              placeholder="B…"
              value={config.publicKey}
              onChange={(event) => persist({ ...config, publicKey: event.target.value.trim() })}
            />
          </Field>
        </div>
        <p className="tiny faint" style={{ marginTop: 8 }}>
          Run <code className="code">server/push.mjs</code> and paste what it prints at startup. It
          is told when to wake your phone and nothing else: no bill names, no amounts, no account.
          The wording is stored on this device and read by the app when the notification fires.
        </p>
      </div>
    </Card>
  );
}

function AdvisorSettings() {
  const [config, setConfig] = useState<AdvisorConfig>(() => loadAdvisorConfig());

  const update = (patch: Partial<AdvisorConfig>) => {
    const next = { ...config, ...patch };
    setConfig(next);
    saveAdvisorConfig(next);
  };

  const usingKeyInBrowser = config.backend === 'claude' && !config.proxyUrl && config.apiKey.length > 0;

  return (
    <Card title="AI advisor">
      <div className="row row--between row--wrap" style={{ gap: 10, marginBottom: 12 }}>
        <span className="grow small muted" style={{ minWidth: 170 }}>
          Eight specialists answer either way. This chooses what powers them.
        </span>
        <Segmented
          ariaLabel="Advisor engine"
          value={config.backend}
          onChange={(backend) => update({ backend })}
          options={[
            { value: 'local', label: 'Built-in' },
            { value: 'claude', label: 'Claude' },
          ]}
        />
      </div>

      {config.backend === 'local' ? (
        <div className="alert">
          <span className="alert__icon"><InfoIcon /></span>
          <span className="grow small">
            The built-in advisor runs entirely on your device — no key, no network, works offline. It answers from
            the same computed figures, but follows fixed reasoning rather than responding to open-ended questions.
          </span>
        </div>
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          <Field
            label="Proxy URL"
            hint="Recommended. A small server that holds your key and forwards requests — see server/ in the repo. Leave blank to call the API directly from this browser."
          >
            <input
              className="input"
              placeholder="https://your-proxy.example.com"
              value={config.proxyUrl}
              onChange={(event) => update({ proxyUrl: event.target.value.trim() })}
            />
          </Field>

          {!config.proxyUrl && (
            <Field label="Anthropic API key" hint="Stored only in this browser, and never included in a backup export.">
              <input
                className="input"
                type="password"
                autoComplete="off"
                placeholder="sk-ant-…"
                value={config.apiKey}
                onChange={(event) => update({ apiKey: event.target.value.trim() })}
              />
            </Field>
          )}

          {usingKeyInBrowser && (
            <div className="alert alert--danger">
              <span className="alert__icon"><AlertIcon /></span>
              <span className="grow small">
                <strong>A key in a browser is readable by any script on the page.</strong> That is acceptable for a
                personal build on your own device, and not acceptable for anything you share or deploy publicly — the
                key would be extractable by anyone who opens it. Use the proxy for that.
              </span>
            </div>
          )}

          <Field label="Model">
            <select
              className="select"
              value={config.model}
              onChange={(event) => update({ model: event.target.value as AdvisorConfig['model'] })}
            >
              {MODEL_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label} — {option.note}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Reasoning effort" hint="Higher thinks longer and costs more. Medium suits most questions.">
            <select
              className="select"
              value={config.effort}
              onChange={(event) => update({ effort: event.target.value as AdvisorConfig['effort'] })}
            >
              <option value="low">Low — quick answers</option>
              <option value="medium">Medium — balanced</option>
              <option value="high">High — hardest questions</option>
            </select>
          </Field>

          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                const cleared = { ...defaultAdvisorConfig(), backend: 'claude' as const };
                setConfig(cleared);
                saveAdvisorConfig(cleared);
              }}
            >
              Clear key
            </button>
          </div>

          <p className="tiny faint">
            Your amounts and categories are sent to Anthropic to answer each question. Account numbers, SSNs and
            credentials are stripped before anything leaves the device, and the app never stores them in the first
            place.
          </p>
        </div>
      )}
    </Card>
  );
}

function CategorySheet({
  initial,
  onSave,
  onDelete,
  onClose,
}: {
  initial?: { name: string; color: string; monthlyCapCents?: number; builtIn: boolean };
  onSave: (draft: { name: string; color: string; monthlyCapCents?: number }) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [color, setColor] = useState(initial?.color ?? CATEGORY_COLORS[0]!);
  const [cap, setCap] = useState(initial?.monthlyCapCents ? String(toDollars(initial.monthlyCapCents)) : '');

  return (
    <Sheet
      title={initial ? 'Edit category' : 'New category'}
      onClose={onClose}
      footer={
        <div className="row" style={{ gap: 8 }}>
          {onDelete && (
            <button type="button" className="btn btn--danger" onClick={onDelete}>
              Delete
            </button>
          )}
          <button
            type="button"
            className="btn btn--primary grow"
            disabled={!name.trim()}
            onClick={() => {
              const capCents = toCents(cap);
              onSave({
                name: name.trim(),
                color,
                ...(capCents > 0 ? { monthlyCapCents: capCents } : { monthlyCapCents: undefined }),
              });
            }}
          >
            Save
          </button>
        </div>
      }
    >
      <div className="stack">
        <Field label="Name">
          <input className="input" autoFocus value={name} onChange={(event) => setName(event.target.value)} />
        </Field>

        <div className="field">
          <span className="field__label">Colour</span>
          <div className="row row--wrap" style={{ gap: 8 }}>
            {CATEGORY_COLORS.map((option) => (
              <button
                key={option}
                type="button"
                aria-label={`Colour ${option}`}
                aria-pressed={color === option}
                onClick={() => setColor(option)}
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 9,
                  background: option,
                  border: color === option ? '2.5px solid var(--text)' : '1px solid var(--border)',
                }}
              />
            ))}
          </div>
        </div>

        <Field label="Monthly cap" hint="Optional. You get a warning as you approach it and when you pass it.">
          <input
            className="input"
            inputMode="decimal"
            value={cap}
            placeholder="No cap"
            onChange={(event) => setCap(event.target.value)}
          />
        </Field>

        {initial?.builtIn && (
          <p className="tiny faint">
            Built-in categories can be renamed and recoloured but not deleted, so existing expenses always have a
            category to point at.
          </p>
        )}
      </div>
    </Sheet>
  );
}

/** Who is signed in, how to change the display name, and where auth runs. */
function AccountCard({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const provider = getAuthProvider();
  const [name, setName] = useState(session.account.name);
  const [serverUrl, setServerUrl] = useState(getAuthServerUrl());
  const [saved, setSaved] = useState(false);

  return (
    <Card title="Account">
      <div className="row" style={{ gap: 12, marginBottom: 14 }}>
        <span className="account__avatar account__avatar--lg" aria-hidden="true">
          {session.account.name
            .split(/\s+/)
            .slice(0, 2)
            .map((part) => part[0]?.toUpperCase() ?? '')
            .join('') || '?'}
        </span>
        <span className="grow">
          <div style={{ fontWeight: 700 }}>{session.account.name}</div>
          <div className="tiny faint">{session.account.email}</div>
          <div className="tiny" style={{ marginTop: 3 }}>
            {session.account.emailVerified ? (
              <span className="pill pill--good">Email verified</span>
            ) : (
              <span className="pill pill--warn">Email not verified</span>
            )}
          </div>
        </span>
      </div>

      <Field label="Display name" hint="Shown on your dashboard.">
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input grow"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setSaved(false);
            }}
          />
          <button
            type="button"
            className="btn btn--sm"
            disabled={!name.trim() || name === session.account.name}
            onClick={() => {
              void provider
                .updateName(session.token, name)
                .then(() => setSaved(true))
                .catch(() => setSaved(false));
            }}
          >
            {saved ? 'Saved' : 'Save'}
          </button>
        </div>
      </Field>

      <div style={{ marginTop: 12 }}>
        <Field
          label="Auth server"
          hint="Leave blank to keep accounts in this browser. Point it at server/auth.mjs for real accounts and emailed verification codes."
        >
          <input
            className="input"
            placeholder="https://your-server.example.com"
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
            onBlur={() => setAuthServerUrl(serverUrl)}
          />
        </Field>
      </div>

      <p className="tiny faint" style={{ marginTop: 10 }}>
        {provider.mode === 'local'
          ? 'Accounts are stored in this browser. Passwords are hashed with PBKDF2, but client-side auth is not a security boundary — it separates your data and personalises the app.'
          : 'Signing in against your server. Passwords are verified server-side and verification codes are emailed.'}
      </p>

      <button type="button" className="btn btn--danger btn--sm" style={{ marginTop: 12 }} onClick={onSignOut}>
        Sign out
      </button>
    </Card>
  );
}
