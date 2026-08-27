/**
 * Study metrics for a price series.
 *
 * Every figure here is computed locally from the candles the app already holds,
 * not fetched. That is deliberate: free market-data tiers hand out a daily price
 * history and very little else, and the derived statistics — moving averages,
 * volatility, drawdown, where the price sits in its yearly range — are the part
 * that turns a number into something you can study. Computing them means they
 * are always available for any symbol whose history loaded, they cost no extra
 * request against a rate limit, and they are unit-testable without a network.
 *
 * Nothing in this file is a recommendation. A moving average crossing is a
 * description of what the price has done, not a forecast, and the UI is careful
 * to present it that way.
 */

import type { ISODate } from '../../types';

export interface Candle {
  date: ISODate;
  openCents: number;
  highCents: number;
  lowCents: number;
  closeCents: number;
  volume: number;
}

export interface StudyMetrics {
  /** Candles actually used. Fewer than requested is normal on free tiers. */
  sampleDays: number;
  firstDate: ISODate | null;
  lastDate: ISODate | null;
  lastCloseCents: number | null;
  /** Change from the first candle in the window to the last. */
  windowChangeCents: number | null;
  windowChangePercent: number | null;
  sma20Cents: number | null;
  sma50Cents: number | null;
  sma200Cents: number | null;
  /** Highest high and lowest low over the window, capped at one trading year. */
  periodHighCents: number | null;
  periodLowCents: number | null;
  /** 0 at the window low, 100 at the window high. */
  positionInRangePercent: number | null;
  /** Standard deviation of daily log returns, annualised at 252 trading days. */
  annualisedVolatilityPercent: number | null;
  /** Worst peak-to-trough fall inside the window, as a positive percentage. */
  maxDrawdownPercent: number | null;
  averageVolume: number | null;
  /** Plain description of where price sits against its averages. */
  trend: 'above both averages' | 'above the 50-day' | 'below both averages' | 'mixed' | 'not enough history';
}

/** Trading days in a year — the conventional annualisation factor. */
const TRADING_DAYS = 252;

export function simpleMovingAverage(candles: Candle[], window: number): number | null {
  if (candles.length < window || window <= 0) return null;
  const slice = candles.slice(-window);
  const total = slice.reduce((sum, candle) => sum + candle.closeCents, 0);
  return Math.round(total / window);
}

/**
 * Annualised volatility from daily log returns.
 *
 * Log returns rather than simple returns because they are additive over time,
 * which is what makes the √252 scaling correct rather than approximately
 * correct. Uses the sample standard deviation (n−1): with a hundred-odd
 * observations the difference is small, but the population form understates
 * risk, and understating risk is the wrong direction to be wrong in.
 */
export function annualisedVolatility(candles: Candle[]): number | null {
  if (candles.length < 3) return null;

  const returns: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const previous = candles[i - 1]!.closeCents;
    const current = candles[i]!.closeCents;
    if (previous <= 0 || current <= 0) continue;
    returns.push(Math.log(current / previous));
  }
  if (returns.length < 2) return null;

  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS) * 100;
}

/** Worst peak-to-trough decline in the window, as a positive percentage. */
export function maxDrawdown(candles: Candle[]): number | null {
  if (candles.length < 2) return null;
  let peak = candles[0]!.closeCents;
  let worst = 0;
  for (const candle of candles) {
    if (candle.closeCents > peak) peak = candle.closeCents;
    if (peak > 0) {
      const fall = ((peak - candle.closeCents) / peak) * 100;
      if (fall > worst) worst = fall;
    }
  }
  return worst;
}

export function study(candles: Candle[]): StudyMetrics {
  const clean = [...candles]
    .filter((candle) => Number.isFinite(candle.closeCents) && candle.closeCents > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  if (clean.length === 0) {
    return {
      sampleDays: 0,
      firstDate: null,
      lastDate: null,
      lastCloseCents: null,
      windowChangeCents: null,
      windowChangePercent: null,
      sma20Cents: null,
      sma50Cents: null,
      sma200Cents: null,
      periodHighCents: null,
      periodLowCents: null,
      positionInRangePercent: null,
      annualisedVolatilityPercent: null,
      maxDrawdownPercent: null,
      averageVolume: null,
      trend: 'not enough history',
    };
  }

  const first = clean[0]!;
  const last = clean.at(-1)!;
  const yearWindow = clean.slice(-TRADING_DAYS);

  const high = Math.max(...yearWindow.map((c) => c.highCents || c.closeCents));
  const low = Math.min(...yearWindow.map((c) => c.lowCents || c.closeCents));
  const span = high - low;

  const sma50 = simpleMovingAverage(clean, 50);
  const sma200 = simpleMovingAverage(clean, 200);

  let trend: StudyMetrics['trend'] = 'not enough history';
  if (sma50 !== null && sma200 !== null) {
    if (last.closeCents > sma50 && last.closeCents > sma200) trend = 'above both averages';
    else if (last.closeCents < sma50 && last.closeCents < sma200) trend = 'below both averages';
    else trend = 'mixed';
  } else if (sma50 !== null) {
    trend = last.closeCents > sma50 ? 'above the 50-day' : 'mixed';
  }

  return {
    sampleDays: clean.length,
    firstDate: first.date,
    lastDate: last.date,
    lastCloseCents: last.closeCents,
    windowChangeCents: last.closeCents - first.closeCents,
    windowChangePercent:
      first.closeCents > 0 ? ((last.closeCents - first.closeCents) / first.closeCents) * 100 : null,
    sma20Cents: simpleMovingAverage(clean, 20),
    sma50Cents: sma50,
    sma200Cents: sma200,
    periodHighCents: high,
    periodLowCents: low,
    positionInRangePercent: span > 0 ? ((last.closeCents - low) / span) * 100 : null,
    annualisedVolatilityPercent: annualisedVolatility(clean),
    maxDrawdownPercent: maxDrawdown(clean),
    averageVolume:
      clean.some((c) => c.volume > 0)
        ? Math.round(clean.reduce((sum, c) => sum + c.volume, 0) / clean.length)
        : null,
    trend,
  };
}
