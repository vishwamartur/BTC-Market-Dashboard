/**
 * Server-side signal engine singleton.
 * Subscribes to the shared WS manager for price/liquidation data,
 * reads market cache for OI/funding/ratios, reads on-chain cache
 * for mempool/fees/hashrate/whales, and computes a single
 * authoritative signal on a fixed interval.
 */

import { getWsManager, type StreamMessage } from './wsManager';
import { getMarketCache } from './marketCache';
import { getOnChainCache } from './onChainCache';
import { generateTradingSignal, type SignalResult, type SignalInputs } from './signals';
import type { LiquidationEvent } from './exchanges';
import {
  parseBinanceLiquidationEvent,
  parseBybitLiquidationEvent,
  parseOkxLiquidationEvent,
} from './exchanges';
import type { WhaleTransaction } from './blockchain';
import { getDb } from './db';

const SIGNAL_INTERVAL_MS = 5000;
const MAX_EVENTS = 200;
const PRICE_HISTORY_SIZE = 50;
const LIQUIDATION_WINDOW_MS = 15 * 60 * 1000; // 15-minute rolling window

class SignalEngine {
  private started = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private unsubscribeWs: (() => void) | null = null;

  // Accumulated state
  private liquidationEvents: LiquidationEvent[] = [];
  private priceHistory: number[] = [];
  private oiHistory: number[] = [];
  private currentPrice = 0;
  private whaleTransactions: WhaleTransaction[] = [];

  // Latest computed signal
  private latestSignal: SignalResult = {
    overallSignal: 'NEUTRAL',
    confidence: 0,
    score: 0,
    components: [],
    timestamp: Date.now(),
  };

  /** Get the most recently computed signal. */
  getLatestSignal(): SignalResult {
    this.ensureStarted();
    return this.latestSignal;
  }

  /** Get the current price. */
  getCurrentPrice(): number {
    return this.currentPrice;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private ensureStarted() {
    if (this.started) return;
    this.started = true;

    console.log('[SignalEngine] Starting server-side signal engine');

    // Subscribe to WS manager for live data
    const manager = getWsManager();
    this.unsubscribeWs = manager.subscribe((msg: StreamMessage) => {
      this.handleStreamMessage(msg);
    });

    // Wire up the on-chain cache with our price getter
    const onChainCache = getOnChainCache();
    onChainCache.setPriceGetter(() => this.currentPrice);

    // Seed historical liquidation events from MongoDB
    this.seedFromDb();

    // Compute signal on fixed interval
    this.intervalId = setInterval(() => this.computeSignal(), SIGNAL_INTERVAL_MS);
  }

  private handleStreamMessage(msg: StreamMessage) {
    if (msg.type === 'price') {
      const raw = msg.data as Record<string, unknown>;
      if (raw && raw.p) {
        const newPrice = parseFloat(raw.p as string);
        if (!isNaN(newPrice) && newPrice > 0) {
          this.currentPrice = newPrice;
          this.priceHistory.push(newPrice);
          if (this.priceHistory.length > PRICE_HISTORY_SIZE) {
            this.priceHistory.shift();
          }
        }
      }
    } else if (msg.type === 'liquidation') {
      try {
        let events: LiquidationEvent[] = [];
        if (msg.source === 'binance') {
          events = [parseBinanceLiquidationEvent(msg.data as Record<string, unknown>)];
        } else if (msg.source === 'bybit') {
          events = [parseBybitLiquidationEvent(msg.data as Record<string, unknown>)];
        } else if (msg.source === 'okx') {
          events = parseOkxLiquidationEvent(msg.data as Record<string, unknown>);
        }
        if (events.length > 0) {
          this.liquidationEvents = [...events, ...this.liquidationEvents].slice(0, MAX_EVENTS);
        }
      } catch { /* ignore parse errors */ }
    }
  }

  /**
   * Seed historical liquidation events from MongoDB so the engine
   * starts with context instead of an empty array.
   */
  private async seedFromDb() {
    try {
      const db = await getDb();
      const cutoff = Date.now() - LIQUIDATION_WINDOW_MS;
      const docs = await db
        .collection('liquidations')
        .find({ orderTradeTime: { $gte: cutoff } })
        .sort({ orderTradeTime: -1 })
        .limit(MAX_EVENTS)
        .toArray();

      if (docs.length > 0) {
        const seeded: LiquidationEvent[] = docs.map((doc) => ({
          id: doc.id as string,
          exchange: doc.exchange as LiquidationEvent['exchange'],
          symbol: doc.symbol as string,
          side: doc.side as 'BUY' | 'SELL',
          originalQuantity: doc.originalQuantity as number,
          price: doc.price as number,
          orderTradeTime: doc.orderTradeTime as number,
          usdValue: doc.usdValue as number,
        }));

        // Merge with any events that arrived via WS while we were querying
        const existingIds = new Set(this.liquidationEvents.map((e) => e.id));
        const unique = seeded.filter((e) => !existingIds.has(e.id));
        this.liquidationEvents = [...this.liquidationEvents, ...unique]
          .sort((a, b) => b.orderTradeTime - a.orderTradeTime)
          .slice(0, MAX_EVENTS);

        console.log(`[SignalEngine] Seeded ${unique.length} historical liquidation events from MongoDB`);
      }
    } catch (err) {
      console.warn('[SignalEngine] Could not seed from MongoDB (non-fatal):', err);
    }
  }

  private computeSignal() {
    // Expire liquidation events outside the rolling 15-minute window
    const windowCutoff = Date.now() - LIQUIDATION_WINDOW_MS;
    this.liquidationEvents = this.liquidationEvents.filter(
      (e) => e.orderTradeTime >= windowCutoff
    );

    // Build liquidation stats from accumulated events
    let totalLongLiquidations = 0;
    let totalShortLiquidations = 0;
    let totalLongUsd = 0;
    let totalShortUsd = 0;
    let largestLiquidation: LiquidationEvent | null = null;

    for (const event of this.liquidationEvents) {
      const isLong = event.side === 'SELL';
      if (isLong) {
        totalLongLiquidations++;
        totalLongUsd += event.usdValue;
      } else {
        totalShortLiquidations++;
        totalShortUsd += event.usdValue;
      }
      if (!largestLiquidation || event.usdValue > largestLiquidation.usdValue) {
        largestLiquidation = event;
      }
    }

    // Read market data from cache
    const marketCache = getMarketCache();
    const snapshot = marketCache.get();

    let longShortRatio: number | null = null;
    let fundingRate: number | null = null;

    if (snapshot) {
      if (snapshot.longShortRatio && typeof snapshot.longShortRatio === 'object') {
        const lsr = (snapshot.longShortRatio as Record<string, unknown>).longShortRatio;
        if (lsr) longShortRatio = parseFloat(String(lsr));
      }
      if (snapshot.fundingRate && typeof snapshot.fundingRate === 'object') {
        const fr = (snapshot.fundingRate as Record<string, unknown>).fundingRate;
        if (fr) fundingRate = parseFloat(String(fr));
      }
      if (snapshot.openInterest && typeof snapshot.openInterest === 'object') {
        const oi = (snapshot.openInterest as Record<string, unknown>).openInterest;
        if (oi) {
          const oiVal = parseFloat(String(oi));
          if (!isNaN(oiVal) && oiVal > 0) {
            this.oiHistory.push(oiVal);
            if (this.oiHistory.length > PRICE_HISTORY_SIZE) {
              this.oiHistory.shift();
            }
          }
        }
      }
    }

    // Read on-chain data from cache
    const onChainCache = getOnChainCache();
    const onChain = onChainCache.get();

    const inputs: SignalInputs = {
      liquidationStats: {
        totalLongLiquidations,
        totalShortLiquidations,
        totalLongUsd,
        totalShortUsd,
        largestLiquidation,
      },
      longShortRatio: longShortRatio !== null && !isNaN(longShortRatio) ? longShortRatio : null,
      mempoolTxCount: onChain.mempoolStats?.count ?? null,
      fastestFee: onChain.mempoolFees?.fastestFee ?? null,
      whaleTransactions: onChain.whaleTransactions,
      hashrateTrend: onChain.hashrateTrend,
      fundingRate,
      recentPrices: this.priceHistory,
      oiHistory: this.oiHistory,
    };

    this.latestSignal = generateTradingSignal(inputs);
  }

  /** Update whale transactions (called from on-chain data hook). */
  setWhaleTransactions(txs: WhaleTransaction[]) {
    this.whaleTransactions = txs;
  }

  destroy() {
    if (this.intervalId) clearInterval(this.intervalId);
    if (this.unsubscribeWs) this.unsubscribeWs();
    this.started = false;
  }
}

// ---------------------------------------------------------------------------
// Global singleton (survives Next.js hot reloads)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-namespace
declare global {
  // eslint-disable-next-line no-var
  var _signalEngine: SignalEngine | undefined;
}

export function getSignalEngine(): SignalEngine {
  if (!global._signalEngine) {
    global._signalEngine = new SignalEngine();
  }
  return global._signalEngine;
}
