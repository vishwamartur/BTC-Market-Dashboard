/**
 * Freshness and readiness metadata for the signal engine.  Values from a
 * source are only eligible for scoring while that source is fresh.
 */

export type SignalSource =
  | 'price'
  | 'market'
  | 'mempool'
  | 'hashrate'
  | 'whales'
  | 'news';

export type SignalSourceState = 'FRESH' | 'STALE' | 'UNAVAILABLE';

export interface SignalSourceStatus {
  state: SignalSourceState;
  timestamp: number | null;
  ageMs: number | null;
  maxAgeMs: number;
}

export interface SignalDataQuality {
  /** False means a critical feed is unavailable or stale and trading is paused. */
  isReady: boolean;
  /** Critical sources which make a directional signal unsafe. */
  blockingSources: SignalSource[];
  sources: Record<SignalSource, SignalSourceStatus>;
}

export const SIGNAL_SOURCE_MAX_AGE_MS: Record<SignalSource, number> = {
  price: 30_000,
  market: 30_000,
  mempool: 2 * 60_000,
  hashrate: 6 * 60 * 60_000,
  whales: 5 * 60_000,
  news: 15 * 60_000,
};

export interface SignalSourceTimestamps {
  price: number | null;
  market: number | null;
  mempool: number | null;
  hashrate: number | null;
  whales: number | null;
  news: number | null;
}

export function getSourceStatus(
  timestamp: number | null | undefined,
  maxAgeMs: number,
  now: number = Date.now(),
): SignalSourceStatus {
  if (timestamp === null || timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0) {
    return { state: 'UNAVAILABLE', timestamp: null, ageMs: null, maxAgeMs };
  }

  const ageMs = Math.max(0, now - timestamp);
  return {
    state: ageMs <= maxAgeMs ? 'FRESH' : 'STALE',
    timestamp,
    ageMs,
    maxAgeMs,
  };
}

/**
 * Price and derivatives data are required before a directional signal may be
 * acted on. Slow-moving/on-chain inputs are useful but deliberately optional.
 */
export function buildSignalDataQuality(
  timestamps: SignalSourceTimestamps,
  now: number = Date.now(),
): SignalDataQuality {
  const sources = Object.fromEntries(
    (Object.keys(SIGNAL_SOURCE_MAX_AGE_MS) as SignalSource[]).map((source) => [
      source,
      getSourceStatus(timestamps[source], SIGNAL_SOURCE_MAX_AGE_MS[source], now),
    ]),
  ) as Record<SignalSource, SignalSourceStatus>;

  const blockingSources = (['price', 'market'] as const).filter(
    (source) => sources[source].state !== 'FRESH',
  );

  return {
    isReady: blockingSources.length === 0,
    blockingSources,
    sources,
  };
}

export function isFresh(source: SignalSourceStatus): boolean {
  return source.state === 'FRESH';
}

/** Re-evaluate a persisted quality snapshot at response time. */
export function refreshSignalDataQuality(
  quality: SignalDataQuality | undefined,
  now: number = Date.now(),
): SignalDataQuality | undefined {
  if (!quality) return undefined;
  return buildSignalDataQuality({
    price: quality.sources.price.timestamp,
    market: quality.sources.market.timestamp,
    mempool: quality.sources.mempool.timestamp,
    hashrate: quality.sources.hashrate.timestamp,
    whales: quality.sources.whales.timestamp,
    news: quality.sources.news.timestamp,
  }, now);
}
