import type { CategoryBreakdown } from '../types';
import type { TrendPoint } from '../lib/finance';
import { formatMonthShort } from '../lib/dates';
import { formatMoneyCompact } from '../lib/money';

/**
 * Hand-rolled SVG charts.
 *
 * Three small, purpose-built charts are cheaper than a charting library here —
 * no bundle cost, no theme-override fight, and they inherit the app's CSS
 * variables so they track light and dark mode for free.
 */

// ---------------------------------------------------------------------------
// Donut
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

function arcPath(cx: number, cy: number, rOuter: number, rInner: number, from: number, to: number) {
  // A full circle cannot be drawn as a single arc — the start and end points
  // coincide and the path collapses. Nudge it just short of a full turn.
  const sweep = Math.min(to - from, TAU - 0.0001);
  const end = from + sweep;
  const large = sweep > Math.PI ? 1 : 0;
  const x0 = cx + rOuter * Math.cos(from);
  const y0 = cy + rOuter * Math.sin(from);
  const x1 = cx + rOuter * Math.cos(end);
  const y1 = cy + rOuter * Math.sin(end);
  const x2 = cx + rInner * Math.cos(end);
  const y2 = cy + rInner * Math.sin(end);
  const x3 = cx + rInner * Math.cos(from);
  const y3 = cy + rInner * Math.sin(from);
  return `M${x0} ${y0}A${rOuter} ${rOuter} 0 ${large} 1 ${x1} ${y1}L${x2} ${y2}A${rInner} ${rInner} 0 ${large} 0 ${x3} ${y3}Z`;
}

export function DonutChart({
  data,
  totalCents,
  size = 168,
  onSelect,
}: {
  data: CategoryBreakdown[];
  totalCents: number;
  size?: number;
  onSelect?: (categoryId: string) => void;
}) {
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size / 2 - 3;
  const rInner = rOuter * 0.62;
  let cursor = -Math.PI / 2; // start at 12 o'clock

  return (
    <svg
      className="donut"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`Spending by category, total ${formatMoneyCompact(totalCents)}`}
    >
      {data.length === 0 ? (
        <circle cx={cx} cy={cy} r={(rOuter + rInner) / 2} fill="none" stroke="var(--surface-3)" strokeWidth={rOuter - rInner} />
      ) : (
        data.map((slice) => {
          const sweep = (slice.percent / 100) * TAU;
          const path = arcPath(cx, cy, rOuter, rInner, cursor, cursor + sweep);
          cursor += sweep;
          return (
            <path
              key={slice.categoryId}
              className="donut__slice"
              d={path}
              fill={slice.color}
              onClick={onSelect ? () => onSelect(slice.categoryId) : undefined}
              role={onSelect ? 'button' : undefined}
              tabIndex={onSelect ? 0 : undefined}
              onKeyDown={
                onSelect
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') onSelect(slice.categoryId);
                    }
                  : undefined
              }
            >
              <title>{`${slice.name}: ${formatMoneyCompact(slice.spentCents)} (${slice.percent.toFixed(1)}%)`}</title>
            </path>
          );
        })
      )}
      <text x={cx} y={cy - 5} textAnchor="middle" fontSize="10.5" fontWeight="700" fill="var(--text-faint)" letterSpacing="0.06em">
        SPENT
      </text>
      <text
        x={cx}
        y={cy + 14}
        textAnchor="middle"
        fontSize={totalCents >= 1_000_000 ? 15 : 17}
        fontWeight="700"
        fill="var(--text)"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {formatMoneyCompact(totalCents)}
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Trend bars
// ---------------------------------------------------------------------------

export function TrendChart({
  points,
  height = 150,
  showIncome = true,
}: {
  points: TrendPoint[];
  height?: number;
  showIncome?: boolean;
}) {
  if (points.length === 0) return null;

  const barWidth = 30;
  const gap = 20;
  const leftPad = 6;
  const bottomPad = 22;
  const width = leftPad * 2 + points.length * barWidth + (points.length - 1) * gap;
  const plotHeight = height - bottomPad;

  const max = Math.max(
    1,
    ...points.map((p) => Math.max(p.totalSpentCents, showIncome ? p.totalIncomeCents : 0)),
  );

  return (
    <div className="chart-scroll">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Monthly spending trend">
        {/* Baseline */}
        <line x1={0} y1={plotHeight} x2={width} y2={plotHeight} stroke="var(--border)" strokeWidth="1" />

        {points.map((point, index) => {
          const x = leftPad + index * (barWidth + gap);
          const spentHeight = Math.max(2, (point.totalSpentCents / max) * (plotHeight - 8));
          const incomeHeight = Math.max(2, (point.totalIncomeCents / max) * (plotHeight - 8));
          const isLast = index === points.length - 1;

          return (
            <g key={point.cycleKey}>
              {showIncome && (
                <rect
                  x={x - 5}
                  y={plotHeight - incomeHeight}
                  width={barWidth + 10}
                  height={incomeHeight}
                  rx="4"
                  fill="var(--accent)"
                  opacity="0.14"
                >
                  <title>{`${formatMonthShort(point.cycleKey)} income: ${formatMoneyCompact(point.totalIncomeCents)}`}</title>
                </rect>
              )}
              <rect
                x={x}
                y={plotHeight - spentHeight}
                width={barWidth}
                height={spentHeight}
                rx="4"
                fill={isLast ? 'var(--accent)' : 'var(--border-strong)'}
              >
                <title>{`${formatMonthShort(point.cycleKey)} spent: ${formatMoneyCompact(point.totalSpentCents)}`}</title>
              </rect>
              <text
                x={x + barWidth / 2}
                y={height - 7}
                textAnchor="middle"
                fontSize="10.5"
                fontWeight="600"
                fill={isLast ? 'var(--text)' : 'var(--text-faint)'}
              >
                {formatMonthShort(point.cycleKey)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Per-category trend, used inside the category drill-down. */
export function CategoryTrendChart({
  points,
  categoryId,
  color,
  height = 90,
}: {
  points: TrendPoint[];
  categoryId: string;
  color: string;
  height?: number;
}) {
  const values = points.map((p) => p.byCategory[categoryId] ?? 0);
  const max = Math.max(1, ...values);
  const barWidth = 26;
  const gap = 14;
  const bottomPad = 18;
  const width = points.length * barWidth + (points.length - 1) * gap;
  const plotHeight = height - bottomPad;

  return (
    <div className="chart-scroll">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Category trend">
        {points.map((point, index) => {
          const value = values[index] ?? 0;
          const barHeight = value === 0 ? 2 : Math.max(3, (value / max) * (plotHeight - 4));
          const x = index * (barWidth + gap);
          return (
            <g key={point.cycleKey}>
              <rect
                x={x}
                y={plotHeight - barHeight}
                width={barWidth}
                height={barHeight}
                rx="3"
                fill={color}
                opacity={index === points.length - 1 ? 1 : 0.45}
              >
                <title>{`${formatMonthShort(point.cycleKey)}: ${formatMoneyCompact(value)}`}</title>
              </rect>
              <text x={x + barWidth / 2} y={height - 5} textAnchor="middle" fontSize="10" fill="var(--text-faint)">
                {formatMonthShort(point.cycleKey)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Net worth line
// ---------------------------------------------------------------------------

export function NetWorthChart({
  points,
  height = 130,
}: {
  points: { date: string; valueCents: number }[];
  height?: number;
}) {
  if (points.length < 2) return null;

  const width = 320;
  const pad = 10;
  const values = points.map((p) => p.valueCents);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const span = max - min || 1;

  const coords = points.map((point, index) => {
    const x = pad + (index / (points.length - 1)) * (width - pad * 2);
    const y = height - pad - ((point.valueCents - min) / span) * (height - pad * 2);
    return { x, y, ...point };
  });

  const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ');
  const area = `${line}L${coords.at(-1)!.x.toFixed(1)} ${height - pad}L${coords[0]!.x.toFixed(1)} ${height - pad}Z`;
  const zeroY = height - pad - ((0 - min) / span) * (height - pad * 2);
  const rising = values.at(-1)! >= values[0]!;
  const color = rising ? 'var(--positive)' : 'var(--negative)';

  return (
    <div className="chart-scroll">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Net worth over time">
        {min < 0 && max > 0 && (
          <line x1={0} y1={zeroY} x2={width} y2={zeroY} stroke="var(--border-strong)" strokeDasharray="3 3" strokeWidth="1" />
        )}
        <path d={area} fill={color} opacity="0.12" />
        <path d={line} fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        {coords.map((c) => (
          <circle key={c.date} cx={c.x} cy={c.y} r="3.2" fill={color}>
            <title>{`${c.date}: ${formatMoneyCompact(c.valueCents)}`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}
