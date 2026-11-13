import { useEffect, useMemo, useRef, useState } from 'react';
import type { BusinessAsset } from '../types';
import { useStore } from '../state/store';
import { formatMoney, formatMoneyCompact, formatPercent, toCents, toDollars } from '../lib/money';
import {
  appreciate,
  breakEven,
  DEPRECIATION_METHODS,
  depreciate,
  inflationImpact,
  margins,
  realRatePercent,
  type DepreciationMethod,
} from '../lib/business/accounting';
import {
  cachedHistory,
  cachedQuote,
  describeMarketError,
  fetchHistory,
  fetchQuote,
  isMarketConfigured,
  loadMarketConfig,
  normaliseSymbol,
  PROVIDER_OPTIONS,
  providerSupportsHistory,
  quoteAge,
  saveMarketConfig,
  type MarketConfig,
  type Quote,
} from '../lib/business/market';
import { simpleMovingAverage, study, type Candle, type StudyMetrics } from '../lib/business/study';
import { PriceChart } from './charts';
import { Card, EmptyState, Field, InfoIcon, PlusIcon, Segmented, Sheet } from './ui';

/**
 * Business mode.
 *
 * Four panels, each answering a question a small business actually asks: what
 * my equipment is worth on the books, what money will be worth later, what I
 * have to sell to break even, and what a share I follow has been doing.
 *
 * Every figure is computed by the pure functions in lib/business — this file
 * only collects inputs and lays out results. That separation is what lets the
 * schedules be unit-tested to the cent, which matters more here than anywhere
 * else in the app: these numbers go into management accounts.
 */
export function BusinessView({ reference }: { reference: string }) {
  const [tab, setTab] = useState<'assets' | 'money' | 'pricing' | 'stocks'>('assets');

  return (
    <div className="stack">
      <Segmented
        ariaLabel="Business view"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'assets', label: 'Assets' },
          { value: 'money', label: 'Money value' },
          { value: 'pricing', label: 'Pricing' },
          { value: 'stocks', label: 'Stocks' },
        ]}
      />
      {tab === 'assets' && <AssetsPanel reference={reference} />}
      {tab === 'money' && <MoneyValuePanel />}
      {tab === 'pricing' && <PricingPanel />}
      {tab === 'stocks' && <StocksPanel />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

function Amount({
  label,
  value,
  onChange,
  placeholder,
  prefix = '$',
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  prefix?: string;
}) {
  return (
    <Field label={label}>
      <div className="row" style={{ gap: 6 }}>
        {prefix && <span className="faint small">{prefix}</span>}
        <input
          className="input grow"
          inputMode="decimal"
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </Field>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'pos' | 'neg' }) {
  return (
    <div className="split__cell">
      <div className="split__label">{label}</div>
      <div className={`split__value${tone ? ` ${tone}` : ''}`}>{value}</div>
    </div>
  );
}

function Explain({ children }: { children: React.ReactNode }) {
  return (
    <div className="alert">
      <span className="alert__icon">
        <InfoIcon />
      </span>
      <span className="grow small">{children}</span>
    </div>
  );
}

const num = (value: string, fallback = 0): number => {
  const parsed = Number(value.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
};

// ---------------------------------------------------------------------------
// Assets and depreciation
// ---------------------------------------------------------------------------

function AssetsPanel({ reference }: { reference: string }) {
  const { state, dispatch } = useStore();
  const [editing, setEditing] = useState<BusinessAsset | null>(null);
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const currentYear = Number(reference.slice(0, 4));

  const rows = useMemo(
    () =>
      state.assets.map((asset) => {
        const schedule = depreciate({
          method: asset.method,
          costCents: asset.costCents,
          salvageCents: asset.salvageCents,
          lifeYears: asset.lifeYears,
          factor: asset.factor,
          totalUnits: asset.totalUnits,
          unitsPerPeriod: asset.unitsPerPeriod,
        });
        // Depreciation runs from the year the asset was placed in service, so
        // the schedule index is elapsed years rather than a calendar year.
        const index = currentYear - Number(asset.placedInService.slice(0, 4));
        const row = schedule.rows[index] ?? null;
        return {
          asset,
          schedule,
          yearOfLife: row ? index + 1 : null,
          thisYearCents: row?.expenseCents ?? 0,
          bookValueCents: row?.closingBookValueCents ?? schedule.endingBookValueCents,
        };
      }),
    [state.assets, currentYear],
  );

  const totalCost = rows.reduce((sum, row) => sum + row.asset.costCents, 0);
  const totalBook = rows.reduce((sum, row) => sum + row.bookValueCents, 0);
  const totalCharge = rows.reduce((sum, row) => sum + row.thisYearCents, 0);

  return (
    <div className="stack">
      <div className="row row--between">
        <span className="small muted">
          {rows.length} {rows.length === 1 ? 'asset' : 'assets'} on the register
        </span>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setAdding(true)}>
          <PlusIcon />
          New asset
        </button>
      </div>

      {rows.length === 0 ? (
        <Card>
          <EmptyState title="Nothing on the register">
            Add a vehicle, a machine or a fit-out and this produces the depreciation schedule — the
            annual charge, accumulated depreciation and the book value at every year end.
          </EmptyState>
        </Card>
      ) : (
        <>
          <Card>
            <div className="split split--auto">
              <Stat label="Cost" value={formatMoneyCompact(totalCost)} />
              <Stat label="Book value" value={formatMoneyCompact(totalBook)} />
              <Stat label={`${currentYear} charge`} value={formatMoneyCompact(totalCharge)} />
            </div>
            <div className="balance__note">
              The {formatMoney(totalCharge)} charge is an expense that never leaves your bank
              account. That gap is why a profitable business can still run out of cash, and why the
              two figures are reported separately.
            </div>
          </Card>

          {rows.map(({ asset, schedule, yearOfLife, thisYearCents, bookValueCents }) => {
            const open = expanded === asset.id;
            const written = asset.costCents - bookValueCents;
            const progress =
              schedule.depreciableBaseCents > 0
                ? Math.min(100, (written / schedule.depreciableBaseCents) * 100)
                : 100;

            return (
              <Card key={asset.id}>
                <div className="row row--between">
                  <span className="grow">
                    <div style={{ fontWeight: 650 }}>{asset.name}</div>
                    <div className="tiny faint">
                      {formatMoney(asset.costCents)} cost ·{' '}
                      {DEPRECIATION_METHODS.find((m) => m.id === asset.method)?.label.toLowerCase()}
                      {yearOfLife !== null
                        ? ` · year ${yearOfLife} of ${asset.lifeYears}`
                        : ' · fully depreciated'}
                    </div>
                  </span>
                  <span className="right">
                    <div className="tnum" style={{ fontWeight: 700 }}>
                      {formatMoney(bookValueCents)}
                    </div>
                    <div className="tiny faint">book value</div>
                  </span>
                </div>

                <div className="meter" style={{ marginTop: 10 }}>
                  <div
                    className="meter__fill"
                    style={{
                      width: `${progress}%`,
                      background: 'var(--accent)',
                    }}
                  />
                </div>

                <div className="row row--between row--wrap" style={{ gap: 8, marginTop: 10 }}>
                  <span className="tiny faint">
                    {formatMoney(written)} written off of{' '}
                    {formatMoney(schedule.depreciableBaseCents)}
                    {thisYearCents > 0 && ` · ${formatMoney(thisYearCents)} this year`}
                  </span>
                  <span className="row" style={{ gap: 6 }}>
                    <button
                      type="button"
                      className="btn btn--sm"
                      aria-expanded={open}
                      onClick={() => setExpanded(open ? null : asset.id)}
                    >
                      {open ? 'Hide schedule' : 'Schedule'}
                    </button>
                    <button type="button" className="btn btn--sm" onClick={() => setEditing(asset)}>
                      Edit
                    </button>
                  </span>
                </div>

                {open && (
                  <div style={{ marginTop: 12 }}>
                    <ScheduleTable schedule={schedule} />
                    {schedule.notes.map((note) => (
                      <div key={note} className="tiny faint" style={{ marginTop: 6 }}>
                        {note}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            );
          })}
        </>
      )}

      {(adding || editing) && (
        <AssetSheet
          initial={editing ?? undefined}
          reference={reference}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
          onSave={(draft) => {
            if (editing) dispatch({ type: 'asset/update', id: editing.id, patch: draft });
            else dispatch({ type: 'asset/add', asset: draft });
            setAdding(false);
            setEditing(null);
          }}
          onDelete={
            editing
              ? () => {
                  dispatch({ type: 'asset/remove', id: editing.id });
                  setEditing(null);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

function ScheduleTable({ schedule }: { schedule: ReturnType<typeof depreciate> }) {
  return (
    <div className="chart-scroll">
      <table className="table">
        <thead>
          <tr>
            <th>Year</th>
            {schedule.method === 'units-of-production' && <th className="num">Units</th>}
            <th className="num">Opening</th>
            <th className="num">Charge</th>
            <th className="num">Accumulated</th>
            <th className="num">Closing</th>
          </tr>
        </thead>
        <tbody>
          {schedule.rows.map((row) => (
            <tr key={row.period}>
              <td>{row.period}</td>
              {schedule.method === 'units-of-production' && (
                <td className="num">{(row.units ?? 0).toLocaleString()}</td>
              )}
              <td className="num">{formatMoney(row.openingBookValueCents)}</td>
              <td className="num">{formatMoney(row.expenseCents)}</td>
              <td className="num">{formatMoney(row.accumulatedCents)}</td>
              <td className="num">{formatMoney(row.closingBookValueCents)}</td>
            </tr>
          ))}
          <tr>
            <td style={{ fontWeight: 700 }}>Total</td>
            {schedule.method === 'units-of-production' && <td />}
            <td />
            <td className="num" style={{ fontWeight: 700 }}>
              {formatMoney(schedule.totalExpenseCents)}
            </td>
            <td />
            <td className="num" style={{ fontWeight: 700 }}>
              {formatMoney(schedule.endingBookValueCents)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function AssetSheet({
  initial,
  reference,
  onSave,
  onDelete,
  onClose,
}: {
  initial?: BusinessAsset;
  reference: string;
  onSave: (draft: Omit<BusinessAsset, 'id'>) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [cost, setCost] = useState(initial ? String(toDollars(initial.costCents)) : '');
  const [salvage, setSalvage] = useState(initial ? String(toDollars(initial.salvageCents)) : '0');
  const [life, setLife] = useState(String(initial?.lifeYears ?? 5));
  const [method, setMethod] = useState<DepreciationMethod>(initial?.method ?? 'straight-line');
  const [factor, setFactor] = useState(String(initial?.factor ?? 2));
  const [totalUnits, setTotalUnits] = useState(String(initial?.totalUnits ?? ''));
  const [units, setUnits] = useState((initial?.unitsPerPeriod ?? []).join(', '));
  const [placed, setPlaced] = useState(initial?.placedInService ?? reference);

  const valid = name.trim().length > 0 && toCents(cost) > 0 && num(life) >= 1;

  const preview = valid
    ? depreciate({
        method,
        costCents: toCents(cost),
        salvageCents: toCents(salvage),
        lifeYears: Math.round(num(life, 5)),
        factor: num(factor, 2),
        totalUnits: Math.round(num(totalUnits, 0)),
        unitsPerPeriod: units
          .split(/[,\s]+/)
          .filter(Boolean)
          .map((value) => num(value, 0)),
      })
    : null;

  return (
    <Sheet
      title={initial ? 'Edit asset' : 'New asset'}
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
            disabled={!valid}
            onClick={() =>
              onSave({
                name: name.trim(),
                costCents: toCents(cost),
                salvageCents: toCents(salvage),
                lifeYears: Math.round(num(life, 5)),
                method,
                factor: method === 'declining-balance' ? num(factor, 2) : undefined,
                totalUnits:
                  method === 'units-of-production' ? Math.round(num(totalUnits, 0)) : undefined,
                unitsPerPeriod:
                  method === 'units-of-production'
                    ? units
                        .split(/[,\s]+/)
                        .filter(Boolean)
                        .map((value) => num(value, 0))
                    : undefined,
                placedInService: placed,
              })
            }
          >
            Save
          </button>
        </div>
      }
    >
      <div className="stack">
        <Field label="What is it">
          <input
            className="input"
            autoFocus
            value={name}
            placeholder="Delivery van"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <div className="grid-2">
          <Amount label="Cost" value={cost} onChange={setCost} placeholder="32000" />
          <Amount label="Salvage value" value={salvage} onChange={setSalvage} placeholder="0" />
        </div>
        <span className="tiny faint" style={{ marginTop: -8 }}>
          Cost includes anything capitalised into it — delivery, installation, signage. Salvage is
          what you expect it to be worth at the end, and is often zero.
        </span>

        <div className="grid-2">
          <Field label="Useful life (years)">
            <input
              className="input"
              inputMode="numeric"
              value={life}
              onChange={(event) => setLife(event.target.value)}
            />
          </Field>
          <Field label="Placed in service">
            <input
              className="input"
              type="date"
              value={placed}
              onChange={(event) => setPlaced(event.target.value)}
            />
          </Field>
        </div>

        <Field label="Method">
          <select
            className="select"
            value={method}
            onChange={(event) => setMethod(event.target.value as DepreciationMethod)}
          >
            {DEPRECIATION_METHODS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="tiny faint">
            {DEPRECIATION_METHODS.find((option) => option.id === method)?.note}
          </span>
        </Field>

        {method === 'declining-balance' && (
          <Field
            label="Rate multiplier"
            hint="2 is double-declining, 1.5 is 150% declining balance."
          >
            <input
              className="input"
              inputMode="decimal"
              value={factor}
              onChange={(event) => setFactor(event.target.value)}
            />
          </Field>
        )}

        {method === 'units-of-production' && (
          <>
            <Field
              label="Lifetime rated output"
              hint="Total units the asset is expected to produce."
            >
              <input
                className="input"
                inputMode="numeric"
                value={totalUnits}
                placeholder="20000"
                onChange={(event) => setTotalUnits(event.target.value)}
              />
            </Field>
            <Field
              label="Units per year"
              hint="Comma separated, oldest first. E.g. 3200, 4100, 3800"
            >
              <input
                className="input"
                value={units}
                placeholder="3200, 4100, 3800"
                onChange={(event) => setUnits(event.target.value)}
              />
            </Field>
          </>
        )}

        {preview && (
          <Card title="First three years">
            <div className="split split--auto">
              {preview.rows.slice(0, 3).map((row) => (
                <Stat
                  key={row.period}
                  label={`Year ${row.period}`}
                  value={formatMoneyCompact(row.expenseCents)}
                />
              ))}
            </div>
          </Card>
        )}
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Inflation, deflation and appreciation
// ---------------------------------------------------------------------------

function MoneyValuePanel() {
  const [amount, setAmount] = useState('10000');
  const [rate, setRate] = useState('3');
  const [years, setYears] = useState('10');
  const [nominal, setNominal] = useState('7');

  const cents = toCents(amount);
  const ratePercent = num(rate, 0);
  const horizon = Math.max(0, Math.round(num(years, 0)));

  const inflation = inflationImpact(cents, ratePercent, horizon);
  const growth = appreciate(cents, num(nominal, 0), horizon);
  const real = realRatePercent(num(nominal, 0), ratePercent);

  return (
    <div className="stack">
      <Card title="Price level">
        <div className="grid-2">
          <Amount label="Amount today" value={amount} onChange={setAmount} />
          <Field label="Annual rate" hint="Negative for deflation.">
            <div className="row" style={{ gap: 6 }}>
              <input
                className="input grow"
                inputMode="decimal"
                value={rate}
                onChange={(event) => setRate(event.target.value)}
              />
              <span className="faint small">%</span>
            </div>
          </Field>
        </div>
        <Field label="Over how many years">
          <input
            className="input"
            inputMode="numeric"
            value={years}
            onChange={(event) => setYears(event.target.value)}
          />
        </Field>

        <div className="split split--auto" style={{ marginTop: 14 }}>
          <Stat
            label="Same purchase will cost"
            value={formatMoneyCompact(inflation.futureCostCents)}
          />
          <Stat
            label="That cash will buy"
            value={formatMoneyCompact(inflation.purchasingPowerCents)}
          />
        </div>

        <div className="balance__note">
          These are two different numbers and they are constantly confused. Over {horizon}{' '}
          {horizon === 1 ? 'year' : 'years'} at {formatPercent(ratePercent, 1)}, the price moves{' '}
          <strong>{formatPercent(inflation.cumulativePriceChangePercent, 1)}</strong> while
          purchasing power moves{' '}
          <strong>{formatPercent(-inflation.purchasingPowerLostPercent, 1)}</strong>. The second is
          always the smaller of the two, because it is a fraction of a larger base.
        </div>

        {inflation.deflation && (
          <Explain>
            <strong>Deflation.</strong> Prices fall and cash gains purchasing power, which sounds
            like good news. It is not, in aggregate: if next month is cheaper, spending waits, which
            makes the month after cheaper still. Debt also gets heavier in real terms — the balance
            is fixed while the money used to repay it is worth more.
          </Explain>
        )}

        {inflation.rows.length > 0 && (
          <div className="chart-scroll" style={{ marginTop: 12 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Year</th>
                  <th className="num">Cost then</th>
                  <th className="num">Cash then worth</th>
                </tr>
              </thead>
              <tbody>
                {inflation.rows.map((row) => (
                  <tr key={row.year}>
                    <td>{row.year}</td>
                    <td className="num">{formatMoney(row.costCents)}</td>
                    <td className="num">{formatMoney(row.realValueCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Appreciation">
        <Field
          label="If it grows at"
          hint="The same figures, compounded as an asset value instead."
        >
          <div className="row" style={{ gap: 6 }}>
            <input
              className="input grow"
              inputMode="decimal"
              value={nominal}
              onChange={(event) => setNominal(event.target.value)}
            />
            <span className="faint small">% a year</span>
          </div>
        </Field>

        <div className="split split--auto" style={{ marginTop: 12 }}>
          <Stat
            label={`Worth in ${horizon} ${horizon === 1 ? 'year' : 'years'}`}
            value={formatMoneyCompact(growth.endingValueCents)}
            tone={growth.declining ? 'neg' : 'pos'}
          />
          <Stat
            label="Total change"
            value={formatMoneyCompact(growth.totalGainCents)}
            tone={growth.totalGainCents < 0 ? 'neg' : 'pos'}
          />
          <Stat label="Real rate" value={formatPercent(real, 2)} tone={real < 0 ? 'neg' : 'pos'} />
        </div>

        <div className="balance__note">
          <strong>{formatPercent(real, 2)}</strong> is the return after inflation — the exact Fisher
          figure, not {formatPercent(num(nominal, 0) - ratePercent, 2)} from subtracting the rates.
          The shortcut is close at small numbers and drifts as they rise.
          {real < 0 &&
            ' A negative real rate means the value is growing more slowly than prices, so it buys less each year even as the number goes up.'}
        </div>

        <Explain>
          <strong>Appreciation is not the opposite of depreciation.</strong> Depreciation allocates
          a cost you have already paid across the years that use it up; appreciation is a change in
          what something would sell for. A building can appreciate every year while being written
          down to zero on the books, and both figures are correct — they answer different questions.
        </Explain>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Break-even and margins
// ---------------------------------------------------------------------------

function PricingPanel() {
  const [fixed, setFixed] = useState('5000');
  const [price, setPrice] = useState('25');
  const [variable, setVariable] = useState('10');
  const [target, setTarget] = useState('');

  const [revenue, setRevenue] = useState('100000');
  const [cogs, setCogs] = useState('40000');
  const [opex, setOpex] = useState('35000');

  const be = breakEven(toCents(fixed), toCents(price), toCents(variable), toCents(target));
  const mg = margins(toCents(revenue), toCents(cogs), toCents(opex));

  return (
    <div className="stack">
      <Card title="Break-even">
        <div className="grid-2">
          <Amount label="Fixed costs per month" value={fixed} onChange={setFixed} />
          <Amount label="Price per unit" value={price} onChange={setPrice} />
        </div>
        <div className="grid-2">
          <Amount label="Variable cost per unit" value={variable} onChange={setVariable} />
          <Amount
            label="Target profit (optional)"
            value={target}
            onChange={setTarget}
            placeholder="0"
          />
        </div>

        {be.neverBreaksEven ? (
          <div className="alert alert--danger" style={{ marginTop: 12 }}>
            <span className="grow small">
              <strong>This never breaks even.</strong> At {formatMoney(be.pricePerUnitCents)}{' '}
              against {formatMoney(be.variableCostPerUnitCents)} of variable cost, every additional
              sale increases the loss. Volume cannot fix a negative contribution margin — the price
              or the unit cost has to change.
            </span>
          </div>
        ) : (
          <>
            <div className="split split--auto" style={{ marginTop: 14 }}>
              <Stat
                label="Units to break even"
                value={(be.unitsToBreakEven ?? 0).toLocaleString()}
              />
              <Stat
                label="Revenue there"
                value={formatMoneyCompact(be.revenueAtBreakEvenCents ?? 0)}
              />
              <Stat
                label="Contribution"
                value={`${formatMoney(be.contributionMarginCents)} (${formatPercent(be.contributionMarginRatioPercent, 0)})`}
              />
            </div>
            <div className="balance__note">
              Each sale contributes {formatMoney(be.contributionMarginCents)} towards the{' '}
              {formatMoney(be.fixedCostsCents)} of fixed costs. Past unit{' '}
              {(be.unitsToBreakEven ?? 0).toLocaleString()}, that contribution is profit.
              {be.unitsForTargetProfit !== null && (
                <>
                  {' '}
                  For {formatMoney(be.targetProfitCents)} of profit you need{' '}
                  <strong>{be.unitsForTargetProfit.toLocaleString()} units</strong>.
                </>
              )}
            </div>
          </>
        )}
      </Card>

      <Card title="Margins">
        <div className="grid-2">
          <Amount label="Revenue" value={revenue} onChange={setRevenue} />
          <Amount label="Cost of goods sold" value={cogs} onChange={setCogs} />
        </div>
        <Amount label="Operating expenses" value={opex} onChange={setOpex} />

        <div className="chart-scroll" style={{ marginTop: 14 }}>
          <table className="table">
            <tbody>
              <tr>
                <td>Revenue</td>
                <td className="num">{formatMoney(mg.revenueCents)}</td>
                <td className="num faint">100%</td>
              </tr>
              <tr>
                <td>Less cost of goods sold</td>
                <td className="num">({formatMoney(mg.cogsCents)})</td>
                <td className="num faint" />
              </tr>
              <tr>
                <td style={{ fontWeight: 650 }}>Gross profit</td>
                <td className="num" style={{ fontWeight: 650 }}>
                  {formatMoney(mg.grossProfitCents)}
                </td>
                <td className="num" style={{ fontWeight: 650 }}>
                  {formatPercent(mg.grossMarginPercent, 1)}
                </td>
              </tr>
              <tr>
                <td>Less operating expenses</td>
                <td className="num">({formatMoney(mg.operatingExpensesCents)})</td>
                <td className="num faint" />
              </tr>
              <tr>
                <td style={{ fontWeight: 700 }}>Operating profit</td>
                <td
                  className={`num ${mg.operatingProfitCents < 0 ? 'neg' : ''}`}
                  style={{ fontWeight: 700 }}
                >
                  {formatMoney(mg.operatingProfitCents)}
                </td>
                <td
                  className={`num ${mg.operatingMarginPercent < 0 ? 'neg' : ''}`}
                  style={{ fontWeight: 700 }}
                >
                  {formatPercent(mg.operatingMarginPercent, 1)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <Explain>
          <strong>
            Margin {formatPercent(mg.grossMarginPercent, 1)}, markup{' '}
            {formatPercent(mg.markupOnCostPercent, 1)}.
          </strong>{' '}
          Margin is profit over revenue; markup is profit over cost. They are never the same number,
          and pricing to one when you meant the other is the most expensive arithmetic mistake in
          small business — a 50% markup is only a 33.3% margin.
        </Explain>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stocks
// ---------------------------------------------------------------------------

interface SymbolState {
  quote: Quote | null;
  candles: Candle[];
  metrics: StudyMetrics | null;
  error: string | null;
  loading: boolean;
}

const emptySymbolState: SymbolState = {
  quote: null,
  candles: [],
  metrics: null,
  error: null,
  loading: false,
};

function StocksPanel() {
  const { state, dispatch } = useStore();
  const [config, setConfig] = useState<MarketConfig>(loadMarketConfig);
  const [data, setData] = useState<Record<string, SymbolState>>({});
  const [selected, setSelected] = useState<string | null>(state.watchlist[0] ?? null);
  const [entry, setEntry] = useState('');
  const [entryError, setEntryError] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);

  const connected = isMarketConfigured(config);
  const watchlist = state.watchlist;

  // Keep a selection valid as the watchlist changes underneath it.
  useEffect(() => {
    if (selected && watchlist.includes(selected)) return;
    setSelected(watchlist[0] ?? null);
  }, [watchlist, selected]);

  const load = useRef<(symbol: string) => void>(() => undefined);
  load.current = (symbol: string) => {
    if (!connected) return;
    setData((current) => ({
      ...current,
      [symbol]: {
        ...(current[symbol] ?? emptySymbolState),
        loading: true,
        error: null,
      },
    }));

    void (async () => {
      try {
        const quote = await fetchQuote(symbol, config);
        let candles = cachedHistory(symbol) ?? [];
        if (providerSupportsHistory(config.provider) && candles.length === 0) {
          // History failing is not fatal — the quote is still worth showing, so
          // the chart simply stays empty rather than taking the panel down.
          candles = await fetchHistory(symbol, config).catch(() => []);
        }
        setData((current) => ({
          ...current,
          [symbol]: {
            quote,
            candles,
            metrics: candles.length > 0 ? study(candles) : null,
            error: null,
            loading: false,
          },
        }));
      } catch (error) {
        setData((current) => ({
          ...current,
          [symbol]: {
            ...(current[symbol] ?? emptySymbolState),
            quote: cachedQuote(symbol),
            loading: false,
            error: describeMarketError(error),
          },
        }));
      }
    })();
  };

  // Load the selected symbol, and only that one. Loading the whole watchlist on
  // mount would spend a day's worth of a free tier's allowance in one render.
  useEffect(() => {
    if (!selected || !connected) return;
    load.current(selected);
  }, [selected, connected, config.provider, config.apiKey]);

  const addSymbol = () => {
    const symbol = normaliseSymbol(entry);
    if (!symbol) {
      setEntryError('That does not look like a ticker. Try something like AAPL.');
      return;
    }
    dispatch({ type: 'watchlist/add', symbol });
    setSelected(symbol);
    setEntry('');
    setEntryError(null);
  };

  const current = selected ? (data[selected] ?? emptySymbolState) : emptySymbolState;

  return (
    <div className="stack">
      {!connected && (
        <Card>
          <EmptyState title="No market data connected">
            Prices need a data provider, and this app has no server holding a key for you. Connect
            your own free key and the watchlist comes alive — until then it stays empty rather than
            showing you a number I made up.
          </EmptyState>
          <button
            type="button"
            className="btn btn--primary btn--block"
            onClick={() => setShowSetup(true)}
          >
            Connect a provider
          </button>
        </Card>
      )}

      <Card
        title="Watchlist"
        action={
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setShowSetup(true)}
          >
            {connected ? 'Data source' : 'Connect'}
          </button>
        }
      >
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input grow"
            value={entry}
            placeholder="Add a ticker, e.g. AAPL"
            aria-label="Ticker symbol"
            onChange={(event) => {
              setEntry(event.target.value.toUpperCase());
              setEntryError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') addSymbol();
            }}
          />
          <button type="button" className="btn" onClick={addSymbol} disabled={!entry.trim()}>
            Add
          </button>
        </div>
        {entryError && (
          <div className="tiny warn" style={{ marginTop: 6 }}>
            {entryError}
          </div>
        )}

        {watchlist.length === 0 ? (
          <div className="tiny faint" style={{ marginTop: 10 }}>
            Nothing followed yet.
          </div>
        ) : (
          <div className="row row--wrap" style={{ gap: 6, marginTop: 12 }}>
            {watchlist.map((symbol) => (
              <button
                key={symbol}
                type="button"
                className="chip"
                aria-pressed={selected === symbol}
                style={
                  selected === symbol
                    ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
                    : undefined
                }
                onClick={() => setSelected(symbol)}
              >
                {symbol}
              </button>
            ))}
          </div>
        )}
      </Card>

      {selected && (
        <SymbolCard
          symbol={selected}
          state={current}
          connected={connected}
          onRefresh={() => load.current(selected)}
          onRemove={() => dispatch({ type: 'watchlist/remove', symbol: selected })}
        />
      )}

      {showSetup && (
        <MarketSetupSheet
          config={config}
          onClose={() => setShowSetup(false)}
          onSave={(next) => {
            saveMarketConfig(next);
            setConfig(next);
            setShowSetup(false);
          }}
        />
      )}
    </div>
  );
}

function SymbolCard({
  symbol,
  state,
  connected,
  onRefresh,
  onRemove,
}: {
  symbol: string;
  state: SymbolState;
  connected: boolean;
  onRefresh: () => void;
  onRemove: () => void;
}) {
  const { quote, candles, metrics, error, loading } = state;

  const closes = candles.map((candle) => candle.closeCents);
  const overlays = useMemo(() => {
    if (candles.length < 50) return [];
    const rolling = (window: number) =>
      candles.map((_, index) =>
        index + 1 < window ? null : simpleMovingAverage(candles.slice(0, index + 1), window),
      );
    const lines = [{ values: rolling(50), color: 'var(--accent)', label: '50-day' }];
    if (candles.length >= 200) {
      lines.push({
        values: rolling(200),
        color: 'var(--text-faint)',
        label: '200-day',
      });
    }
    return lines;
  }, [candles]);

  const up = (quote?.changeCents ?? 0) >= 0;

  return (
    <Card
      title={symbol}
      action={
        <span className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className="btn btn--sm"
            onClick={onRefresh}
            disabled={!connected || loading}
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onRemove}>
            Remove
          </button>
        </span>
      }
    >
      {error && (
        <div className="alert alert--warning">
          <span className="grow small">{error}</span>
        </div>
      )}

      {!quote && !error && (
        <div className="tiny faint">
          {connected ? 'Fetching…' : 'Connect a data provider to see a price.'}
        </div>
      )}

      {quote && (
        <>
          <div className="row row--between" style={{ alignItems: 'flex-end' }}>
            <span>
              <div
                className="tnum"
                style={{
                  fontSize: 30,
                  fontWeight: 700,
                  letterSpacing: '-0.02em',
                }}
              >
                {formatMoney(quote.priceCents)}
              </div>
              <div className={`small tnum ${up ? 'pos' : 'neg'}`}>
                {up ? '+' : ''}
                {quote.changeCents === null ? '—' : formatMoney(quote.changeCents)}
                {quote.changePercent !== null && ` (${formatPercent(quote.changePercent, 2)})`}{' '}
                today
              </div>
            </span>
            <span className="right tiny faint">
              <div>{quote.asOf || 'latest close'}</div>
              <div>fetched {quoteAge(quote)}</div>
            </span>
          </div>

          <div className="tiny faint" style={{ marginTop: 6 }}>
            Delayed end-of-day data from {quote.provider}. Not a live feed, and not suitable for
            trading decisions.
          </div>
        </>
      )}

      {closes.length > 1 && (
        <>
          <div style={{ marginTop: 14 }}>
            <PriceChart closes={closes} overlays={overlays} />
          </div>
          <div className="row row--wrap tiny faint" style={{ gap: 12, marginTop: 4 }}>
            <span>{candles.length} sessions</span>
            {overlays.map((overlay) => (
              <span key={overlay.label} style={{ color: overlay.color }}>
                — {overlay.label} average
              </span>
            ))}
          </div>
        </>
      )}

      {metrics && <StudyPanel metrics={metrics} />}

      {quote && !metrics && (
        <div className="tiny faint" style={{ marginTop: 12 }}>
          Daily history is not available on this provider, so the moving averages, volatility and
          range statistics stay blank. Alpha Vantage supplies history on its free tier.
        </div>
      )}
    </Card>
  );
}

function StudyPanel({ metrics }: { metrics: StudyMetrics }) {
  const range =
    metrics.periodLowCents !== null && metrics.periodHighCents !== null
      ? `${formatMoneyCompact(metrics.periodLowCents)} – ${formatMoneyCompact(metrics.periodHighCents)}`
      : '—';

  return (
    <div style={{ marginTop: 14 }}>
      <div className="split split--auto">
        <Stat
          label="Over the window"
          value={
            metrics.windowChangePercent === null
              ? '—'
              : `${metrics.windowChangePercent >= 0 ? '+' : ''}${formatPercent(metrics.windowChangePercent, 1)}`
          }
          tone={(metrics.windowChangePercent ?? 0) >= 0 ? 'pos' : 'neg'}
        />
        <Stat
          label="Volatility (annualised)"
          value={
            metrics.annualisedVolatilityPercent === null
              ? '—'
              : formatPercent(metrics.annualisedVolatilityPercent, 1)
          }
        />
        <Stat
          label="Max drawdown"
          value={
            metrics.maxDrawdownPercent === null
              ? '—'
              : `−${formatPercent(metrics.maxDrawdownPercent, 1)}`
          }
        />
      </div>

      <div className="split split--auto" style={{ marginTop: 10 }}>
        <Stat label="Range" value={range} />
        <Stat
          label="50-day average"
          value={metrics.sma50Cents === null ? 'needs 50 days' : formatMoney(metrics.sma50Cents)}
        />
        <Stat
          label="200-day average"
          value={metrics.sma200Cents === null ? 'needs 200 days' : formatMoney(metrics.sma200Cents)}
        />
      </div>

      {metrics.positionInRangePercent !== null && (
        <>
          <div className="meter" style={{ marginTop: 12 }}>
            <div
              className="meter__fill"
              style={{
                width: `${Math.max(1, Math.min(100, metrics.positionInRangePercent))}%`,
                background: 'var(--accent)',
              }}
            />
          </div>
          <div className="tiny faint" style={{ marginTop: 6 }}>
            Sitting {formatPercent(metrics.positionInRangePercent, 0)} of the way up its{' '}
            {metrics.sampleDays}-session range, {metrics.trend}.
          </div>
        </>
      )}

      <Explain>
        These are descriptions of what the price has already done, not forecasts. Volatility is the
        spread of past daily moves annualised; a moving average is arithmetic on old closes.
        CashCompass will not tell you what to buy — that is a decision with your money in it, and
        nothing here knows your tax position, your horizon or your nerve.
      </Explain>
    </div>
  );
}

function MarketSetupSheet({
  config,
  onSave,
  onClose,
}: {
  config: MarketConfig;
  onSave: (next: MarketConfig) => void;
  onClose: () => void;
}) {
  const [provider, setProvider] = useState(config.provider);
  const [apiKey, setApiKey] = useState(config.apiKey);

  return (
    <Sheet
      title="Market data"
      onClose={onClose}
      footer={
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className="btn grow"
            onClick={() => onSave({ provider: 'none', apiKey: '' })}
          >
            Disconnect
          </button>
          <button
            type="button"
            className="btn btn--primary grow"
            disabled={provider === 'none' || !apiKey.trim()}
            onClick={() => onSave({ provider, apiKey: apiKey.trim() })}
          >
            Save
          </button>
        </div>
      }
    >
      <div className="stack">
        <Explain>
          A published web app has no secrets — anything compiled into it is readable by anyone who
          opens the developer tools. So CashCompass ships without a market data key and you supply
          your own. It is stored on this device only, it is never written into a backup file, and it
          is sent to the provider you pick and nowhere else.
        </Explain>

        <Field label="Provider">
          <select
            className="select"
            value={provider}
            onChange={(event) => setProvider(event.target.value as MarketConfig['provider'])}
          >
            <option value="none">Not connected</option>
            {PROVIDER_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="tiny faint">
            {PROVIDER_OPTIONS.find((option) => option.id === provider)?.note ??
              'Pick a provider to see what its free tier includes.'}
          </span>
        </Field>

        {provider !== 'none' && (
          <>
            <Field label="API key">
              <input
                className="input"
                type="password"
                autoComplete="off"
                value={apiKey}
                placeholder="Paste your key"
                onChange={(event) => setApiKey(event.target.value)}
              />
            </Field>
            <div className="tiny faint">
              Free keys are issued instantly at{' '}
              <a
                href={PROVIDER_OPTIONS.find((option) => option.id === provider)?.signupUrl}
                target="_blank"
                rel="noreferrer"
              >
                {PROVIDER_OPTIONS.find((option) => option.id === provider)?.signupUrl}
              </a>
              .
            </div>
          </>
        )}

        <div className="tiny faint">
          Data is end-of-day and delayed. Treat it as material for study, not as a trading screen.
        </div>
      </div>
    </Sheet>
  );
}
