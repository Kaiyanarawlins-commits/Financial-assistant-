/**
 * Market data.
 *
 * Three constraints shape everything below.
 *
 * **No key can ship in the bundle.** A static web app has no secrets — anything
 * compiled in is readable by anyone who opens devtools, and a free market-data
 * key shared by every user is rate-limited into uselessness within an hour. So
 * the user supplies their own key, it is stored in its own localStorage slot
 * (never in AppState, which is what "Download backup" serialises), and it goes
 * only to the provider it belongs to.
 *
 * **Prices are never invented.** Every other number in this app is derived from
 * something the user entered; a stock price is not, and a plausible-looking
 * fabricated quote is the worst possible failure here. With no provider
 * configured, or on any error, this module returns a typed failure and the UI
 * says what is missing. It does not fall back to sample data, cached-but-stale
 * figures presented as live, or a guess.
 *
 * **Free tiers are strict.** Alpha Vantage allows around 25 requests a day.
 * Everything is cached — quotes briefly, history for hours — and the cache is
 * shared with the advisor's tool so asking about a symbol costs nothing extra.
 */

import type { Candle } from './study';

export type MarketProvider = 'none' | 'alphavantage' | 'finnhub';

export interface MarketConfig {
  provider: MarketProvider;
  apiKey: string;
}

export const PROVIDER_OPTIONS: {
  id: MarketProvider;
  label: string;
  note: string;
  signupUrl: string;
  supportsHistory: boolean;
}[] = [
  {
    id: 'alphavantage',
    label: 'Alpha Vantage',
    note: 'Free key, quotes and daily history. Around 25 requests a day, so results are cached.',
    signupUrl: 'https://www.alphavantage.co/support/#api-key',
    supportsHistory: true,
  },
  {
    id: 'finnhub',
    label: 'Finnhub',
    note: 'Free key, generous quote limits. Daily history is a paid feature, so the charts stay empty.',
    signupUrl: 'https://finnhub.io/register',
    supportsHistory: false,
  },
];

const STORAGE_KEY = 'cashcompass.market.v1';

export function defaultMarketConfig(): MarketConfig {
  return { provider: 'none', apiKey: '' };
}

export function loadMarketConfig(): MarketConfig {
  if (typeof localStorage === 'undefined') return defaultMarketConfig();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultMarketConfig();
    return { ...defaultMarketConfig(), ...(JSON.parse(raw) as Partial<MarketConfig>) };
  } catch {
    return defaultMarketConfig();
  }
}

export function saveMarketConfig(config: MarketConfig): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Storage unavailable. The session keeps working; the key just won't persist.
  }
}

export function isMarketConfigured(config: MarketConfig): boolean {
  return config.provider !== 'none' && config.apiKey.trim().length > 0;
}

export function providerSupportsHistory(provider: MarketProvider): boolean {
  return PROVIDER_OPTIONS.find((option) => option.id === provider)?.supportsHistory ?? false;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface Quote {
  symbol: string;
  priceCents: number;
  previousCloseCents: number | null;
  changeCents: number | null;
  changePercent: number | null;
  openCents: number | null;
  highCents: number | null;
  lowCents: number | null;
  /** Provider's own timestamp for the price, as text. */
  asOf: string;
  provider: MarketProvider;
  /** When this app received it, for the "as of" line and cache expiry. */
  fetchedAt: number;
}

export type MarketFailure =
  | 'no-provider'
  | 'no-key'
  | 'rate-limited'
  | 'not-found'
  | 'not-supported'
  | 'network'
  | 'bad-response';

export class MarketError extends Error {
  readonly reason: MarketFailure;
  constructor(reason: MarketFailure, message: string) {
    super(message);
    this.name = 'MarketError';
    this.reason = reason;
  }
}

/** A symbol is a ticker, not free text — validated before it reaches a URL. */
export function normaliseSymbol(input: string): string | null {
  const symbol = input.trim().toUpperCase();
  return /^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol) ? symbol : null;
}

const toCents = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const QUOTE_TTL_MS = 60_000;
const HISTORY_TTL_MS = 6 * 60 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  storedAt: number;
}

const quoteCache = new Map<string, CacheEntry<Quote>>();
const historyCache = new Map<string, CacheEntry<Candle[]>>();

function fresh<T>(entry: CacheEntry<T> | undefined, ttl: number): T | null {
  if (!entry) return null;
  return Date.now() - entry.storedAt < ttl ? entry.value : null;
}

/**
 * The most recent quote held for a symbol, however old.
 *
 * Separate from the fetch path on purpose. The advisor's tool reads this so it
 * can answer from what the Stocks tab already loaded without spending a request
 * — but it gets `fetchedAt` alongside the price and is required to say how old
 * the figure is, because a stale price presented as current is exactly the
 * failure this module exists to avoid.
 */
export function cachedQuote(symbol: string): Quote | null {
  return quoteCache.get(symbol)?.value ?? null;
}

export function cachedHistory(symbol: string): Candle[] | null {
  return historyCache.get(symbol)?.value ?? null;
}

export function cachedSymbols(): string[] {
  return [...quoteCache.keys()];
}

/** Drops everything. Called on sign-out, so one user's watchlist data does not outlive their session. */
export function clearMarketCache(): void {
  quoteCache.clear();
  historyCache.clear();
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * A request that hangs is worse than one that fails: the card sits on
 * "Fetching…" forever and the user has no way to tell a slow provider from a
 * broken one. Ten seconds is generous for a single quote.
 */
const REQUEST_TIMEOUT_MS = 10_000;

async function getJson(url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, { signal: combineSignals(signal, deadline.signal) });
  } catch (error) {
    if (deadline.signal.aborted) {
      throw new MarketError('network', 'The market data provider did not respond in time.');
    }
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new MarketError('network', 'Could not reach the market data provider.');
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new MarketError('no-key', 'The provider rejected that API key.');
  }
  if (response.status === 429) {
    throw new MarketError('rate-limited', 'The provider rate-limited this key. Try again later.');
  }
  if (!response.ok) {
    throw new MarketError('bad-response', `The provider returned ${response.status}.`);
  }

  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new MarketError('bad-response', 'The provider returned something that was not JSON.');
  }
}

/**
 * Alpha Vantage signals a spent rate limit with HTTP 200 and a `Note` or
 * `Information` field rather than a 429, so the body has to be inspected — a
 * status-code-only check reads a rate-limit message as a valid empty quote.
 */
function checkAlphaVantageBody(body: Record<string, unknown>): void {
  const note = body.Note ?? body.Information ?? body['Error Message'];
  if (typeof note !== 'string') return;
  if (/api key/i.test(note) && /demo|invalid/i.test(note)) {
    throw new MarketError('no-key', 'Alpha Vantage rejected that API key.');
  }
  if (/limit|frequency|premium/i.test(note)) {
    throw new MarketError(
      'rate-limited',
      'Alpha Vantage daily limit reached for this key. The free tier allows about 25 requests a day.',
    );
  }
  throw new MarketError('bad-response', note);
}

export async function fetchQuote(
  symbol: string,
  config: MarketConfig,
  signal?: AbortSignal,
): Promise<Quote> {
  if (config.provider === 'none') {
    throw new MarketError('no-provider', 'No market data provider is connected.');
  }
  if (!config.apiKey.trim()) {
    throw new MarketError('no-key', 'No API key set for the market data provider.');
  }

  const cached = fresh(quoteCache.get(symbol), QUOTE_TTL_MS);
  if (cached) return cached;

  const key = encodeURIComponent(config.apiKey.trim());
  const ticker = encodeURIComponent(symbol);
  let quote: Quote;

  if (config.provider === 'alphavantage') {
    const body = await getJson(
      `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${key}`,
      signal,
    );
    checkAlphaVantageBody(body);

    const raw = body['Global Quote'] as Record<string, string> | undefined;
    const price = toCents(raw?.['05. price']);
    if (!raw || price === null) {
      throw new MarketError('not-found', `No quote for ${symbol}. Check the ticker.`);
    }

    const changePercentRaw = raw['10. change percent'] ?? '';
    const changePercent = Number(changePercentRaw.replace('%', ''));

    quote = {
      symbol,
      priceCents: price,
      previousCloseCents: toCents(raw['08. previous close']),
      changeCents: toCents(raw['09. change']),
      changePercent: Number.isFinite(changePercent) ? changePercent : null,
      openCents: toCents(raw['02. open']),
      highCents: toCents(raw['03. high']),
      lowCents: toCents(raw['04. low']),
      asOf: raw['07. latest trading day'] ?? '',
      provider: 'alphavantage',
      fetchedAt: Date.now(),
    };
  } else {
    const body = await getJson(
      `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${key}`,
      signal,
    );
    const price = toCents(body.c);
    // Finnhub answers an unknown ticker with zeroes and a 200, so a zero price
    // means "no such symbol" rather than a company that is worth nothing.
    if (price === null || price === 0) {
      throw new MarketError('not-found', `No quote for ${symbol}. Check the ticker.`);
    }
    const timestamp = typeof body.t === 'number' && body.t > 0 ? body.t * 1000 : Date.now();

    quote = {
      symbol,
      priceCents: price,
      previousCloseCents: toCents(body.pc),
      changeCents: toCents(body.d),
      changePercent: typeof body.dp === 'number' ? body.dp : null,
      openCents: toCents(body.o),
      highCents: toCents(body.h),
      lowCents: toCents(body.l),
      asOf: new Date(timestamp).toISOString().slice(0, 10),
      provider: 'finnhub',
      fetchedAt: Date.now(),
    };
  }

  quoteCache.set(symbol, { value: quote, storedAt: Date.now() });
  return quote;
}

export async function fetchHistory(
  symbol: string,
  config: MarketConfig,
  signal?: AbortSignal,
): Promise<Candle[]> {
  if (config.provider === 'none') {
    throw new MarketError('no-provider', 'No market data provider is connected.');
  }
  if (config.provider !== 'alphavantage') {
    throw new MarketError(
      'not-supported',
      'Daily history is a paid feature on Finnhub. Switch to Alpha Vantage for charts and study metrics.',
    );
  }
  if (!config.apiKey.trim()) {
    throw new MarketError('no-key', 'No API key set for the market data provider.');
  }

  const cached = fresh(historyCache.get(symbol), HISTORY_TTL_MS);
  if (cached) return cached;

  const body = await getJson(
    `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(
      symbol,
    )}&outputsize=compact&apikey=${encodeURIComponent(config.apiKey.trim())}`,
    signal,
  );
  checkAlphaVantageBody(body);

  const series = body['Time Series (Daily)'] as Record<string, Record<string, string>> | undefined;
  if (!series || Object.keys(series).length === 0) {
    throw new MarketError('not-found', `No price history for ${symbol}.`);
  }

  const candles: Candle[] = Object.entries(series)
    .map(([date, row]) => ({
      date,
      openCents: toCents(row['1. open']) ?? 0,
      highCents: toCents(row['2. high']) ?? 0,
      lowCents: toCents(row['3. low']) ?? 0,
      closeCents: toCents(row['4. close']) ?? 0,
      volume: Number(row['5. volume'] ?? 0) || 0,
    }))
    .filter((candle) => candle.closeCents > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  historyCache.set(symbol, { value: candles, storedAt: Date.now() });
  return candles;
}

/** Aborts when either signal does. `AbortSignal.any` is not available everywhere. */
function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  if (typeof AbortSignal !== 'undefined' && 'any' in AbortSignal) {
    return (AbortSignal as unknown as { any: (signals: AbortSignal[]) => AbortSignal }).any([a, b]);
  }
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (a.aborted || b.aborted) controller.abort();
  a.addEventListener('abort', forward, { once: true });
  b.addEventListener('abort', forward, { once: true });
  return controller.signal;
}

/** Turns any thrown value into a sentence a user can act on. */
export function describeMarketError(error: unknown): string {
  if (error instanceof MarketError) return error.message;
  if (error instanceof Error && error.name === 'AbortError') return 'Cancelled.';
  return error instanceof Error ? error.message : 'Something went wrong fetching market data.';
}

/** How long ago a quote was received, for the "as of" line. */
export function quoteAge(quote: Quote): string {
  const seconds = Math.max(0, Math.round((Date.now() - quote.fetchedAt) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
