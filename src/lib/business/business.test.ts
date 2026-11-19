import { describe, expect, it } from 'vitest';
import {
  appreciate,
  breakEven,
  cagr,
  cpiAdjust,
  depreciate,
  impliedInflationPercent,
  inflationImpact,
  irr,
  margins,
  nominalRatePercent,
  npv,
  paybackPeriods,
  priceForMargin,
  realRatePercent,
  roiPercent,
} from './accounting';
import { annualisedVolatility, maxDrawdown, simpleMovingAverage, study, type Candle } from './study';
import {
  defaultMarketConfig,
  fetchQuote,
  isMarketConfigured,
  MarketError,
  normaliseSymbol,
  providerSupportsHistory,
  quoteAge,
} from './market';

// ---------------------------------------------------------------------------
// Depreciation
// ---------------------------------------------------------------------------

describe('depreciation', () => {
  it('spreads straight line evenly and foots exactly to the depreciable base', () => {
    const schedule = depreciate({
      method: 'straight-line',
      costCents: 3_200_000,
      salvageCents: 400_000,
      lifeYears: 8,
    });

    expect(schedule.depreciableBaseCents).toBe(2_800_000);
    expect(schedule.rows).toHaveLength(8);
    expect(schedule.rows.every((row) => row.expenseCents === 350_000)).toBe(true);
    expect(schedule.totalExpenseCents).toBe(2_800_000);
    expect(schedule.endingBookValueCents).toBe(400_000);
  });

  it('foots exactly even when the yearly charge does not divide evenly', () => {
    // $10,000 over 3 years is $3,333.33 a year, which cannot sum to the base
    // if each year is rounded independently. The last year takes the remainder.
    const schedule = depreciate({
      method: 'straight-line',
      costCents: 1_000_000,
      salvageCents: 0,
      lifeYears: 3,
    });

    expect(schedule.totalExpenseCents).toBe(1_000_000);
    expect(schedule.rows.map((r) => r.expenseCents)).toEqual([333_333, 333_333, 333_334]);
    expect(schedule.endingBookValueCents).toBe(0);
  });

  it('front-loads declining balance and never writes below salvage', () => {
    const schedule = depreciate({
      method: 'declining-balance',
      costCents: 900_000,
      salvageCents: 60_000,
      lifeYears: 5,
      factor: 2,
    });

    expect(schedule.ratePercent).toBeCloseTo(40, 5);
    expect(schedule.rows[0]!.expenseCents).toBe(360_000);
    expect(schedule.rows[1]!.expenseCents).toBe(216_000);
    // Each year's charge is smaller than the last — that is the whole point.
    for (let i = 1; i < schedule.rows.length; i++) {
      expect(schedule.rows[i]!.expenseCents).toBeLessThan(schedule.rows[i - 1]!.expenseCents);
    }
    expect(schedule.endingBookValueCents).toBeGreaterThan(60_000);
    // And it says so, rather than leaving the reader to notice.
    expect(schedule.notes.join(' ')).toMatch(/never quite reaches the floor/i);
  });

  it('caps a declining-balance charge at the salvage floor', () => {
    const schedule = depreciate({
      method: 'declining-balance',
      costCents: 100_000,
      salvageCents: 90_000,
      lifeYears: 5,
      factor: 2,
    });

    expect(schedule.totalExpenseCents).toBe(10_000);
    expect(schedule.endingBookValueCents).toBe(90_000);
    expect(schedule.rows.every((row) => row.closingBookValueCents >= 90_000)).toBe(true);
  });

  it('lands sum-of-years exactly on salvage', () => {
    const schedule = depreciate({
      method: 'sum-of-years',
      costCents: 900_000,
      salvageCents: 60_000,
      lifeYears: 5,
    });

    // Year one takes 5/15 of the $8,400 base.
    expect(schedule.rows[0]!.expenseCents).toBe(280_000);
    expect(schedule.totalExpenseCents).toBe(840_000);
    expect(schedule.endingBookValueCents).toBe(60_000);
  });

  it('charges units of production by output rather than by time', () => {
    const schedule = depreciate({
      method: 'units-of-production',
      costCents: 1_450_000,
      salvageCents: 150_000,
      lifeYears: 7,
      totalUnits: 20_000,
      unitsPerPeriod: [3_200, 4_100, 3_800],
    });

    // $13,000 base ÷ 20,000 units = 65c a unit.
    expect(schedule.rows[0]!.expenseCents).toBe(208_000);
    expect(schedule.rows[1]!.expenseCents).toBe(266_500);
    expect(schedule.rows[2]!.expenseCents).toBe(247_000);
    expect(schedule.rows[0]!.units).toBe(3_200);
  });

  it('closes units of production exactly at salvage once rated output is reached', () => {
    const schedule = depreciate({
      method: 'units-of-production',
      costCents: 1_000_000,
      salvageCents: 100_000,
      lifeYears: 5,
      totalUnits: 3_000,
      unitsPerPeriod: [1_000, 1_000, 1_000],
    });

    expect(schedule.totalExpenseCents).toBe(900_000);
    expect(schedule.endingBookValueCents).toBe(100_000);
  });

  it('treats salvage above cost as salvage equal to cost rather than depreciating upward', () => {
    const schedule = depreciate({
      method: 'straight-line',
      costCents: 100_000,
      salvageCents: 500_000,
      lifeYears: 5,
    });

    expect(schedule.depreciableBaseCents).toBe(0);
    expect(schedule.totalExpenseCents).toBe(0);
    expect(schedule.rows.every((row) => row.expenseCents === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Appreciation
// ---------------------------------------------------------------------------

describe('appreciation', () => {
  it('compounds annually and reports the gain', () => {
    const result = appreciate(10_000_000, 5, 10);
    // $100,000 at 5% for ten years is about $162,889.
    expect(result.endingValueCents).toBeGreaterThan(16_280_000);
    expect(result.endingValueCents).toBeLessThan(16_300_000);
    expect(result.totalGainCents).toBe(result.endingValueCents - 10_000_000);
    expect(result.cagrPercent).toBeCloseTo(5, 2);
    expect(result.declining).toBe(false);
  });

  it('handles a negative rate as a decline in market value', () => {
    const result = appreciate(10_000_000, -12, 3);
    expect(result.endingValueCents).toBeLessThan(10_000_000);
    expect(result.totalGainCents).toBeLessThan(0);
    expect(result.declining).toBe(true);
  });

  it('derives a growth rate from two values', () => {
    expect(cagr(10_000_000, 16_288_946, 10)).toBeCloseTo(5, 2);
    expect(cagr(0, 100, 5)).toBeNull();
    expect(cagr(100, 200, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Inflation and deflation
// ---------------------------------------------------------------------------

describe('price levels', () => {
  it('separates what a thing will cost from what money will be worth', () => {
    const result = inflationImpact(10_000, 3, 10);

    // The two figures people conflate: +34.4% on the price, −25.6% on the money.
    expect(result.futureCostCents).toBe(13_439);
    expect(result.purchasingPowerCents).toBe(7_441);
    expect(result.cumulativePriceChangePercent).toBeCloseTo(34.39, 1);
    expect(result.purchasingPowerLostPercent).toBeCloseTo(25.59, 1);
    expect(result.cumulativePriceChangePercent).not.toBeCloseTo(
      result.purchasingPowerLostPercent,
      1,
    );
  });

  it('handles deflation as a negative rate', () => {
    const result = inflationImpact(10_000, -2, 5);
    expect(result.deflation).toBe(true);
    expect(result.futureCostCents).toBeLessThan(10_000);
    // Under deflation cash gains purchasing power, so "lost" goes negative.
    expect(result.purchasingPowerCents).toBeGreaterThan(10_000);
    expect(result.purchasingPowerLostPercent).toBeLessThan(0);
  });

  it('uses the exact Fisher relation rather than subtracting the rates', () => {
    // 12% nominal against 8% inflation is 3.70% real, not 4%.
    expect(realRatePercent(12, 8)).toBeCloseTo(3.7037, 3);
    expect(realRatePercent(12, 8)).not.toBeCloseTo(4, 2);
    expect(nominalRatePercent(realRatePercent(12, 8), 8)).toBeCloseTo(12, 6);
  });

  it('restates a sum between two CPI index values', () => {
    // Doubling the index doubles the nominal amount needed.
    expect(cpiAdjust(10_000, 100, 200)).toBe(20_000);
    expect(cpiAdjust(10_000, 0, 200)).toBeNull();
    expect(impliedInflationPercent(100, 200, 10)).toBeCloseTo(7.177, 2);
  });
});

// ---------------------------------------------------------------------------
// Break-even and margins
// ---------------------------------------------------------------------------

describe('break-even', () => {
  it('rounds units up, because you cannot break even on part of a sale', () => {
    const result = breakEven(500_000, 2_500, 1_000);
    expect(result.contributionMarginCents).toBe(1_500);
    // $5,000 ÷ $15 = 333.33 → 334.
    expect(result.unitsToBreakEven).toBe(334);
    expect(result.revenueAtBreakEvenCents).toBe(334 * 2_500);
    expect(result.neverBreaksEven).toBe(false);
  });

  it('says plainly when volume cannot help', () => {
    const result = breakEven(500_000, 1_000, 1_200);
    expect(result.neverBreaksEven).toBe(true);
    expect(result.unitsToBreakEven).toBeNull();
  });

  it('solves for a target profit', () => {
    const result = breakEven(500_000, 2_500, 1_000, 250_000);
    expect(result.unitsForTargetProfit).toBe(500);
  });
});

describe('margins', () => {
  it('distinguishes margin from markup', () => {
    const result = margins(20_000, 10_000);
    // A 100% markup is a 50% margin.
    expect(result.grossMarginPercent).toBeCloseTo(50, 5);
    expect(result.markupOnCostPercent).toBeCloseTo(100, 5);
  });

  it('reports the classic 50% markup as a 33.3% margin', () => {
    const result = margins(15_000, 10_000);
    expect(result.markupOnCostPercent).toBeCloseTo(50, 5);
    expect(result.grossMarginPercent).toBeCloseTo(33.33, 1);
  });

  it('walks the statement down to net', () => {
    const result = margins(100_000, 40_000, 35_000, 5_000);
    expect(result.grossProfitCents).toBe(60_000);
    expect(result.operatingProfitCents).toBe(25_000);
    expect(result.netProfitCents).toBe(20_000);
    expect(result.netMarginPercent).toBeCloseTo(20, 5);
  });

  it('prices back from a target margin', () => {
    expect(priceForMargin(10_000, 33.3333)).toBe(15_000);
    expect(priceForMargin(10_000, 100)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Appraisal
// ---------------------------------------------------------------------------

describe('project appraisal', () => {
  const flows = [-100_000, 50_000, 50_000, 50_000];

  it('discounts a cashflow to present value', () => {
    expect(npv(10, flows)).toBeCloseTo(24_343, -1);
    // A discount rate at the IRR drives NPV to roughly zero.
    expect(Math.abs(npv(irr(flows)!, flows))).toBeLessThan(5);
  });

  it('finds the internal rate of return', () => {
    expect(irr(flows)).toBeCloseTo(23.375, 1);
  });

  it('returns null when a cashflow has no sign change', () => {
    expect(irr([100, 200, 300])).toBeNull();
    expect(irr([-100])).toBeNull();
  });

  it('interpolates the payback period', () => {
    expect(paybackPeriods(flows)).toBeCloseTo(2, 5);
    expect(paybackPeriods([-100_000, 25_000, 25_000])).toBeNull();
  });

  it('computes return on cost', () => {
    expect(roiPercent(25_000, 100_000)).toBeCloseTo(25, 5);
    expect(roiPercent(25_000, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Study metrics
// ---------------------------------------------------------------------------

function series(closes: number[]): Candle[] {
  return closes.map((close, index) => ({
    date: `2026-01-${String(index + 1).padStart(2, '0')}`,
    openCents: close,
    highCents: close,
    lowCents: close,
    closeCents: close,
    volume: 1_000,
  }));
}

describe('study metrics', () => {
  it('averages only when there is enough history', () => {
    const candles = series(Array.from({ length: 30 }, (_, i) => 10_000 + i * 100));
    expect(simpleMovingAverage(candles, 20)).not.toBeNull();
    expect(simpleMovingAverage(candles, 50)).toBeNull();
  });

  it('reports no volatility for a flat series', () => {
    expect(annualisedVolatility(series([10_000, 10_000, 10_000, 10_000]))).toBeCloseTo(0, 6);
  });

  it('measures the worst peak-to-trough fall', () => {
    // Rises to 200, falls to 100 — a 50% drawdown — then partially recovers.
    expect(maxDrawdown(series([10_000, 20_000, 10_000, 15_000]))).toBeCloseTo(50, 5);
  });

  it('places the last price within its range', () => {
    const metrics = study(series([10_000, 20_000, 15_000]));
    expect(metrics.periodLowCents).toBe(10_000);
    expect(metrics.periodHighCents).toBe(20_000);
    expect(metrics.positionInRangePercent).toBeCloseTo(50, 5);
    expect(metrics.windowChangePercent).toBeCloseTo(50, 5);
  });

  it('degrades honestly with no data at all', () => {
    const metrics = study([]);
    expect(metrics.sampleDays).toBe(0);
    expect(metrics.lastCloseCents).toBeNull();
    expect(metrics.trend).toBe('not enough history');
  });

  it('sorts candles before measuring, so provider ordering cannot flip the result', () => {
    const reversed = [...series([10_000, 20_000])].reverse();
    expect(study(reversed).windowChangePercent).toBeCloseTo(100, 5);
  });
});

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

describe('market data', () => {
  it('accepts tickers and rejects anything that is not one', () => {
    expect(normaliseSymbol(' aapl ')).toBe('AAPL');
    expect(normaliseSymbol('brk.b')).toBe('BRK.B');
    expect(normaliseSymbol('')).toBeNull();
    expect(normaliseSymbol('what is a good stock')).toBeNull();
    expect(normaliseSymbol('1234')).toBeNull();
  });

  it('is not configured until a provider and a key are both present', () => {
    expect(isMarketConfigured(defaultMarketConfig())).toBe(false);
    expect(isMarketConfigured({ provider: 'finnhub', apiKey: '' })).toBe(false);
    expect(isMarketConfigured({ provider: 'finnhub', apiKey: 'abc' })).toBe(true);
  });

  it('refuses to fetch without a provider rather than inventing a price', async () => {
    await expect(fetchQuote('AAPL', defaultMarketConfig())).rejects.toBeInstanceOf(MarketError);
    await expect(fetchQuote('AAPL', { provider: 'finnhub', apiKey: '' })).rejects.toMatchObject({
      reason: 'no-key',
    });
  });

  it('knows which providers can supply history', () => {
    expect(providerSupportsHistory('alphavantage')).toBe(true);
    expect(providerSupportsHistory('finnhub')).toBe(false);
    expect(providerSupportsHistory('none')).toBe(false);
  });

  it('maps a rate-limit status to a reason the UI can explain', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('', { status: 429 })) as typeof fetch;
    try {
      await expect(
        fetchQuote('RATE', { provider: 'finnhub', apiKey: 'k' }),
      ).rejects.toMatchObject({ reason: 'rate-limited' });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('reads a spent Alpha Vantage allowance out of a 200 response body', async () => {
    // Alpha Vantage answers an exhausted key with HTTP 200 and a Note field, so
    // a status-code-only check would take the rate-limit message for a quote.
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ Note: 'Thank you for using Alpha Vantage! Our standard API call frequency limit is 25 requests per day.' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    try {
      await expect(
        fetchQuote('NOTE', { provider: 'alphavantage', apiKey: 'k' }),
      ).rejects.toMatchObject({ reason: 'rate-limited' });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('treats a zero-priced Finnhub response as an unknown ticker', async () => {
    // Finnhub answers a bad symbol with 200 and zeroes rather than a 404.
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ c: 0, d: 0, dp: 0, pc: 0, t: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    try {
      await expect(
        fetchQuote('NOPE', { provider: 'finnhub', apiKey: 'k' }),
      ).rejects.toMatchObject({ reason: 'not-found' });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('describes a quote by age, so a stale price is never shown as live', () => {
    const base = {
      symbol: 'AAPL',
      priceCents: 10_000,
      previousCloseCents: 9_900,
      changeCents: 100,
      changePercent: 1,
      openCents: null,
      highCents: null,
      lowCents: null,
      asOf: '2026-08-27',
      provider: 'finnhub' as const,
    };
    expect(quoteAge({ ...base, fetchedAt: Date.now() })).toBe('just now');
    expect(quoteAge({ ...base, fetchedAt: Date.now() - 5 * 60_000 })).toBe('5 min ago');
    expect(quoteAge({ ...base, fetchedAt: Date.now() - 3 * 3_600_000 })).toBe('3h ago');
  });
});
