/**
 * Server-side signal engine.
 *
 * Live messages are reduced into bounded time buckets and timestamp-aligned
 * market bars. The latest state is persisted so API instances can read a
 * consistent result after a cold start instead of trusting process memory.
 */

import { getWsManager, type StreamMessage } from './wsManager';
import { getMarketCache, type MarketSnapshot } from './marketCache';
import { getOnChainCache } from './onChainCache';
import { generateTradingSignal, type SignalResult, type SignalInputs } from './signals';
import type { LiquidationEvent } from './exchanges';
import {
  parseBinanceLiquidationEvent,
  parseBybitLiquidationEvent,
  parseOkxLiquidationEvent,
} from './exchanges';
import { getDb, isDatabaseConfigured } from './db';
import { getNewsSentimentManager } from './newsSentiment';
import { buildSignalDataQuality, isFresh } from './signalQuality';
import {
  readSignalState,
  writeSignalState,
  type LiquidationBucket,
  type PersistedSignalState,
  type TimedNumber,
} from './signalState';

const SIGNAL_INTERVAL_MS = 5000;
const SIGNAL_BAR_INTERVAL_MS = 60 * 1000;
const PRICE_HISTORY_SIZE = 60;
const HISTORY_RETENTION_MS = 90 * 60 * 1000;
const LIQUIDATION_WINDOW_MS = 15 * 60 * 1000;
const LIQUIDATION_BUCKET_MS = 60 * 1000;
const SIGNAL_ENGINE_VERSION = 3;

type LiquidationStats = SignalInputs['liquidationStats'];

function trimHistory(points: TimedNumber[], now: number): TimedNumber[] {
  const cutoff = now - HISTORY_RETENTION_MS;
  return points.filter((point) => point.timestamp >= cutoff).slice(-PRICE_HISTORY_SIZE);
}

/** Keep the latest sample from each fixed one-minute bar. */
function toOneMinuteBars(points: TimedNumber[], now: number): TimedNumber[] {
  const bars = new Map<number, TimedNumber>();
  for (const point of points) {
    if (!Number.isFinite(point.value) || !Number.isFinite(point.timestamp)) continue;
    const timestamp = Math.floor(point.timestamp / SIGNAL_BAR_INTERVAL_MS) * SIGNAL_BAR_INTERVAL_MS;
    const previous = bars.get(timestamp);
    if (!previous || point.timestamp >= previous.timestamp) {
      bars.set(timestamp, { value: point.value, timestamp });
    }
  }
  return trimHistory([...bars.values()].sort((a, b) => a.timestamp - b.timestamp), now);
}

function asFiniteNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

class SignalEngine {
  readonly version = SIGNAL_ENGINE_VERSION;
  private started = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private unsubscribeWs: (() => void) | null = null;
  private startupPromise: Promise<void> | null = null;

  // Bounded, timestamped rolling state.
  private liquidationBuckets = new Map<number, LiquidationBucket>();
  private seenLiquidationIds = new Map<string, number>();
  private priceHistory: TimedNumber[] = [];
  private oiHistory: TimedNumber[] = [];
  private currentPrice = 0;
  private lastPriceTimestamp = 0;
  private lastMarketSnapshotTimestamp = 0;

  // Latest computed signal.
  private latestSignal: SignalResult = {
    overallSignal: 'NEUTRAL',
    confidence: 0,
    score: 0,
    components: [],
    timestamp: Date.now(),
  };

  // Writes are coalesced so a slow database never creates an unbounded queue.
  private pendingPersistedState: PersistedSignalState | null = null;
  private persistenceInFlight = false;

  /** Starts the engine without waiting for the database bootstrap. */
  start(): void {
    this.ensureStarted();
  }

  /** Used by the dedicated worker to restore state before publishing. */
  async initialize(): Promise<void> {
    this.ensureStarted();
    await this.startupPromise;
  }

  /** Get the most recently computed signal without triggering network I/O. */
  getLatestSignal(): SignalResult {
    this.ensureStarted();
    return this.latestSignal;
  }

  getCurrentPrice(): number {
    return this.currentPrice;
  }

  // -----------------------------------------------------------------------
  // Startup and stream handling
  // -----------------------------------------------------------------------

  private ensureStarted() {
    if (this.started) return;
    this.started = true;

    console.log('[SignalEngine] Starting signal engine');
    getOnChainCache().setPriceGetter(() => this.currentPrice);

    this.startupPromise = this.restoreState()
      .then(async (restored) => {
        // A durable snapshot is preferred. Mongo aggregation is only a
        // bootstrap path for installations that do not yet have one.
        if (!restored) await this.seedLiquidationBucketsFromDb();
      })
      .catch((error) => {
        console.warn('[SignalEngine] State bootstrap failed (non-fatal):', error);
      })
      .finally(() => {
        const manager = getWsManager();
        this.unsubscribeWs = manager.subscribe((msg: StreamMessage) => this.handleStreamMessage(msg));
        this.computeSignal();
        this.intervalId = setInterval(() => this.computeSignal(), SIGNAL_INTERVAL_MS);
      });
  }

  private handleStreamMessage(msg: StreamMessage) {
    if (msg.type === 'price') {
      const raw = msg.data as Record<string, unknown>;
      const newPrice = raw ? asFiniteNumber(raw.p) : null;
      if (newPrice !== null && newPrice > 0) {
        this.currentPrice = newPrice;
        this.lastPriceTimestamp = Date.now();
      }
      return;
    }

    if (msg.type !== 'liquidation') return;

    try {
      let events: LiquidationEvent[] = [];
      if (msg.source === 'binance') {
        events = [parseBinanceLiquidationEvent(msg.data as Record<string, unknown>)];
      } else if (msg.source === 'bybit') {
        events = [parseBybitLiquidationEvent(msg.data as Record<string, unknown>)];
      } else if (msg.source === 'okx') {
        events = parseOkxLiquidationEvent(msg.data as Record<string, unknown>);
      }
      for (const event of events) this.addLiquidationEvent(event);
    } catch {
      // One malformed exchange message must never stop the aggregation loop.
    }
  }

  private addLiquidationEvent(event: LiquidationEvent) {
    if (!Number.isFinite(event.orderTradeTime) || !Number.isFinite(event.usdValue) || event.usdValue <= 0) {
      return;
    }

    const now = Date.now();
    const cutoff = now - LIQUIDATION_WINDOW_MS;
    if (event.orderTradeTime < cutoff) return;
    if (this.seenLiquidationIds.has(event.id)) return;
    this.seenLiquidationIds.set(event.id, event.orderTradeTime);

    const bucketStart = Math.floor(event.orderTradeTime / LIQUIDATION_BUCKET_MS) * LIQUIDATION_BUCKET_MS;
    const bucket = this.liquidationBuckets.get(bucketStart) ?? {
      bucketStart,
      totalLongLiquidations: 0,
      totalShortLiquidations: 0,
      totalLongUsd: 0,
      totalShortUsd: 0,
      largestUsdValue: 0,
    };

    // A forced SELL closes a long; a forced BUY closes a short.
    if (event.side === 'SELL') {
      bucket.totalLongLiquidations++;
      bucket.totalLongUsd += event.usdValue;
    } else {
      bucket.totalShortLiquidations++;
      bucket.totalShortUsd += event.usdValue;
    }
    bucket.largestUsdValue = Math.max(bucket.largestUsdValue, event.usdValue);
    this.liquidationBuckets.set(bucketStart, bucket);
  }

  // -----------------------------------------------------------------------
  // Durable state
  // -----------------------------------------------------------------------

  private async restoreState(): Promise<boolean> {
    const state = await readSignalState();
    if (!state) return false;

    this.latestSignal = state.latestSignal;
    this.currentPrice = state.currentPrice;
    this.priceHistory = toOneMinuteBars(state.priceHistory, Date.now());
    this.oiHistory = toOneMinuteBars(state.oiHistory, Date.now());
    this.lastPriceTimestamp = state.lastPriceTimestamp;
    this.lastMarketSnapshotTimestamp = Math.floor(
      state.lastMarketSnapshotTimestamp / SIGNAL_BAR_INTERVAL_MS,
    ) * SIGNAL_BAR_INTERVAL_MS;

    const cutoff = Date.now() - LIQUIDATION_WINDOW_MS;
    for (const bucket of state.liquidationBuckets) {
      if (bucket.bucketStart >= cutoff) this.liquidationBuckets.set(bucket.bucketStart, bucket);
    }

    console.log('[SignalEngine] Restored durable signal state');
    return true;
  }

  /**
   * Aggregate the database on the server side; this avoids retaining every
   * liquidation in process memory during volatile periods.
   */
  private async seedLiquidationBucketsFromDb(): Promise<void> {
    if (!isDatabaseConfigured) return;

    const cutoff = Date.now() - LIQUIDATION_WINDOW_MS;
    const db = await getDb();
    const rows = await db.collection('liquidations').aggregate<{
      _id: number;
      totalLongLiquidations: number;
      totalShortLiquidations: number;
      totalLongUsd: number;
      totalShortUsd: number;
      largestUsdValue: number;
    }>([
      { $match: { orderTradeTime: { $gte: cutoff } } },
      {
        $group: {
          _id: { $multiply: [{ $floor: { $divide: ['$orderTradeTime', LIQUIDATION_BUCKET_MS] } }, LIQUIDATION_BUCKET_MS] },
          totalLongLiquidations: { $sum: { $cond: [{ $eq: ['$side', 'SELL'] }, 1, 0] } },
          totalShortLiquidations: { $sum: { $cond: [{ $eq: ['$side', 'BUY'] }, 1, 0] } },
          totalLongUsd: { $sum: { $cond: [{ $eq: ['$side', 'SELL'] }, '$usdValue', 0] } },
          totalShortUsd: { $sum: { $cond: [{ $eq: ['$side', 'BUY'] }, '$usdValue', 0] } },
          largestUsdValue: { $max: '$usdValue' },
        },
      },
    ]).toArray();

    for (const row of rows) {
      if (!Number.isFinite(row._id) || this.liquidationBuckets.has(row._id)) continue;
      this.liquidationBuckets.set(row._id, {
        bucketStart: row._id,
        totalLongLiquidations: row.totalLongLiquidations,
        totalShortLiquidations: row.totalShortLiquidations,
        totalLongUsd: row.totalLongUsd,
        totalShortUsd: row.totalShortUsd,
        largestUsdValue: row.largestUsdValue,
      });
    }
  }

  private queuePersistence() {
    if (!isDatabaseConfigured) return;

    this.pendingPersistedState = {
      latestSignal: this.latestSignal,
      currentPrice: this.currentPrice,
      priceHistory: this.priceHistory,
      oiHistory: this.oiHistory,
      liquidationBuckets: [...this.liquidationBuckets.values()].sort((a, b) => a.bucketStart - b.bucketStart),
      lastPriceTimestamp: this.lastPriceTimestamp,
      lastMarketSnapshotTimestamp: this.lastMarketSnapshotTimestamp,
      computedAt: Date.now(),
    };

    if (!this.persistenceInFlight) void this.flushPersistence();
  }

  private async flushPersistence() {
    this.persistenceInFlight = true;
    try {
      while (this.pendingPersistedState) {
        const state = this.pendingPersistedState;
        this.pendingPersistedState = null;
        await writeSignalState(state);
      }
    } catch (error) {
      console.warn('[SignalEngine] Could not persist signal state (non-fatal):', error);
    } finally {
      this.persistenceInFlight = false;
    }
  }

  // -----------------------------------------------------------------------
  // Signal calculation
  // -----------------------------------------------------------------------

  private trimLiquidationBuckets(now: number) {
    const cutoff = now - LIQUIDATION_WINDOW_MS;
    for (const [bucketStart] of this.liquidationBuckets) {
      if (bucketStart + LIQUIDATION_BUCKET_MS < cutoff) this.liquidationBuckets.delete(bucketStart);
    }
    for (const [id, timestamp] of this.seenLiquidationIds) {
      if (timestamp < cutoff) this.seenLiquidationIds.delete(id);
    }
  }

  private getLiquidationStats(): LiquidationStats {
    let totalLongLiquidations = 0;
    let totalShortLiquidations = 0;
    let totalLongUsd = 0;
    let totalShortUsd = 0;

    for (const bucket of this.liquidationBuckets.values()) {
      totalLongLiquidations += bucket.totalLongLiquidations;
      totalShortLiquidations += bucket.totalShortLiquidations;
      totalLongUsd += bucket.totalLongUsd;
      totalShortUsd += bucket.totalShortUsd;
    }

    return {
      totalLongLiquidations,
      totalShortLiquidations,
      totalLongUsd,
      totalShortUsd,
      // The scoring model currently only uses totals; preserving every raw
      // event merely to return this optional field is not worth the cost.
      largestLiquidation: null,
    };
  }

  private appendAlignedMarketBar(snapshot: MarketSnapshot) {
    const barTimestamp = Math.floor(snapshot.timestamp / SIGNAL_BAR_INTERVAL_MS) * SIGNAL_BAR_INTERVAL_MS;
    if (barTimestamp <= this.lastMarketSnapshotTimestamp) return;
    this.lastMarketSnapshotTimestamp = barTimestamp;

    if (this.currentPrice > 0) {
      this.priceHistory.push({ value: this.currentPrice, timestamp: barTimestamp });
    }

    const rawOi = snapshot.openInterest && typeof snapshot.openInterest === 'object'
      ? (snapshot.openInterest as Record<string, unknown>).openInterest
      : null;
    const oi = asFiniteNumber(rawOi);
    if (oi !== null && oi > 0) {
      this.oiHistory.push({ value: oi, timestamp: barTimestamp });
    }
  }

  private computeSignal() {
    const now = Date.now();
    this.trimLiquidationBuckets(now);
    this.priceHistory = trimHistory(this.priceHistory, now);
    this.oiHistory = trimHistory(this.oiHistory, now);

    const marketCache = getMarketCache();
    const snapshot = marketCache.get();
    const hasMarketPayload = Boolean(
      snapshot && (snapshot.openInterest || snapshot.longShortRatio || snapshot.fundingRate),
    );
    if (snapshot && hasMarketPayload) this.appendAlignedMarketBar(snapshot);

    const onChain = getOnChainCache().get();
    const news = getNewsSentimentManager().getLatestSentiment();
    const dataQuality = buildSignalDataQuality({
      price: this.lastPriceTimestamp || null,
      market: hasMarketPayload && snapshot ? snapshot.timestamp : null,
      mempool: onChain.mempoolTimestamp || null,
      hashrate: onChain.hashrateTimestamp || null,
      whales: onChain.whaleTimestamp || null,
      news: news.timestamp || null,
    }, now);

    const marketIsFresh = isFresh(dataQuality.sources.market);
    const mempoolIsFresh = isFresh(dataQuality.sources.mempool);
    const hashrateIsFresh = isFresh(dataQuality.sources.hashrate);
    const whalesAreFresh = isFresh(dataQuality.sources.whales);
    const newsIsFresh = isFresh(dataQuality.sources.news);

    let longShortRatio: number | null = null;
    let fundingRate: number | null = null;
    if (marketIsFresh && snapshot) {
      const ratioData = snapshot.longShortRatio as Record<string, unknown> | null;
      const fundingData = snapshot.fundingRate as Record<string, unknown> | null;
      longShortRatio = asFiniteNumber(ratioData?.longShortRatio);
      fundingRate = asFiniteNumber(fundingData?.fundingRate);
    }

    const inputs: SignalInputs = {
      liquidationStats: this.getLiquidationStats(),
      longShortRatio: longShortRatio !== null && longShortRatio > 0 ? longShortRatio : null,
      mempoolTxCount: mempoolIsFresh ? onChain.mempoolStats?.count ?? null : null,
      fastestFee: mempoolIsFresh ? onChain.mempoolFees?.fastestFee ?? null : null,
      whaleTransactions: whalesAreFresh ? onChain.whaleTransactions : [],
      hashrateTrend: hashrateIsFresh ? onChain.hashrateTrend : null,
      fundingRate,
      recentPrices: this.priceHistory.map((point) => point.value),
      oiHistory: this.oiHistory.map((point) => point.value),
      newsSentiment: newsIsFresh ? news.score : null,
      dataQuality,
    };

    this.latestSignal = generateTradingSignal(inputs);
    this.queuePersistence();
  }

  destroy() {
    if (this.intervalId) clearInterval(this.intervalId);
    if (this.unsubscribeWs) this.unsubscribeWs();
    this.intervalId = null;
    this.unsubscribeWs = null;
    this.started = false;
    this.startupPromise = null;
  }
}

// Global singleton (survives Next.js hot reloads in a single process only).
declare global {
  var _signalEngine: SignalEngine | undefined;
}

export function getSignalEngine(): SignalEngine {
  // Next.js keeps globals across hot reloads. Replace an instance produced by
  // an older module version so newly added lifecycle methods are available.
  const existing = global._signalEngine as unknown;
  if (
    !existing
    || typeof (existing as { start?: unknown }).start !== 'function'
    || (existing as { version?: unknown }).version !== SIGNAL_ENGINE_VERSION
  ) {
    const legacy = existing as { destroy?: () => void } | undefined;
    try {
      legacy?.destroy?.();
    } catch {
      // A legacy instance must not block the refreshed engine from starting.
    }
    global._signalEngine = new SignalEngine();
  }
  return global._signalEngine!;
}
