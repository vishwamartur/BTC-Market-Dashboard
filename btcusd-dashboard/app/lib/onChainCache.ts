/**
 * Server-side on-chain data cache singleton.
 * Polls mempool.space (30s) and blockchain.info (60s) APIs,
 * caching results in memory for the SignalEngine to consume.
 *
 * This fills the architecture gap where on-chain data was only
 * available client-side but the signal engine runs server-side.
 */

import type { MempoolStats, MempoolFees, HashrateData } from './mempool';
import { fetchMempoolStats, fetchMempoolFees, fetchHashrate } from './mempool';
import {
  fetchUnconfirmedTransactions,
  classifyWhaleTransaction,
  type WhaleTransaction,
} from './blockchain';

const MEMPOOL_POLL_MS = 30_000;    // 30s for mempool.space (generous rate limits)
const BLOCKCHAIN_POLL_MS = 60_000; // 60s for blockchain.info (aggressive rate limiting)

export interface OnChainSnapshot {
  mempoolStats: MempoolStats | null;
  mempoolFees: MempoolFees | null;
  hashrateData: HashrateData | null;
  hashrateTrend: 'UP' | 'DOWN' | 'FLAT' | null;
  whaleTransactions: WhaleTransaction[];
  timestamp: number;
}

class OnChainCache {
  private started = false;
  private mempoolTimerId: ReturnType<typeof setInterval> | null = null;
  private blockchainTimerId: ReturnType<typeof setInterval> | null = null;

  // Cached data
  private mempoolStats: MempoolStats | null = null;
  private mempoolFees: MempoolFees | null = null;
  private hashrateData: HashrateData | null = null;
  private hashrateTrend: 'UP' | 'DOWN' | 'FLAT' | null = null;
  private whaleTransactions: WhaleTransaction[] = [];
  private lastTimestamp = 0;

  // Rate-limit protection for blockchain.info
  private blockchainBackoffMs = 0;
  private blockchainNextAllowed = 0;

  // Price getter — will be injected by the signal engine
  private priceGetter: (() => number) | null = null;

  setPriceGetter(fn: () => number) {
    this.priceGetter = fn;
  }

  /** Get the cached on-chain snapshot. */
  get(): OnChainSnapshot {
    this.ensureStarted();
    return {
      mempoolStats: this.mempoolStats,
      mempoolFees: this.mempoolFees,
      hashrateData: this.hashrateData,
      hashrateTrend: this.hashrateTrend,
      whaleTransactions: this.whaleTransactions,
      timestamp: this.lastTimestamp,
    };
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private ensureStarted() {
    if (this.started) return;
    this.started = true;

    console.log('[OnChainCache] Starting server-side on-chain data polling');

    // Kick off initial fetches immediately
    this.fetchMempoolData().catch(() => {});
    this.fetchBlockchainData().catch(() => {});

    // Mempool.space poll: every 30s
    this.mempoolTimerId = setInterval(() => {
      this.fetchMempoolData().catch((err) => {
        console.error('[OnChainCache] Mempool fetch error:', err);
      });
    }, MEMPOOL_POLL_MS);

    // Blockchain.info poll: every 60s
    this.blockchainTimerId = setInterval(() => {
      this.fetchBlockchainData().catch((err) => {
        console.error('[OnChainCache] Blockchain fetch error:', err);
      });
    }, BLOCKCHAIN_POLL_MS);
  }

  /**
   * Fetch mempool stats, fees, and hashrate from mempool.space.
   * This API has generous rate limits.
   */
  private async fetchMempoolData(): Promise<void> {
    const [statsRes, feesRes, hashrateRes] = await Promise.allSettled([
      fetchMempoolStats(),
      fetchMempoolFees(),
      fetchHashrate(),
    ]);

    if (statsRes.status === 'fulfilled') {
      this.mempoolStats = statsRes.value;
    }

    if (feesRes.status === 'fulfilled') {
      this.mempoolFees = feesRes.value;
    }

    if (hashrateRes.status === 'fulfilled') {
      this.hashrateData = hashrateRes.value;
      this.hashrateTrend = this.computeHashrateTrend(hashrateRes.value);
    }

    this.lastTimestamp = Date.now();
  }

  /**
   * Fetch unconfirmed transactions from blockchain.info for whale classification.
   * This API rate-limits aggressively — includes backoff logic.
   */
  private async fetchBlockchainData(): Promise<void> {
    // Respect backoff
    if (Date.now() < this.blockchainNextAllowed) {
      return;
    }

    const currentPrice = this.priceGetter ? this.priceGetter() : 0;
    if (currentPrice <= 0) {
      // Can't classify whale txs without a price — skip
      return;
    }

    try {
      const txData = await fetchUnconfirmedTransactions();

      // Success — reset backoff
      this.blockchainBackoffMs = 0;
      this.blockchainNextAllowed = 0;

      if (txData.txs && txData.txs.length > 0) {
        const newWhales: WhaleTransaction[] = [];

        for (const tx of txData.txs) {
          const whaleTx = classifyWhaleTransaction(tx, currentPrice);
          if (whaleTx) {
            newWhales.push(whaleTx);
          }
        }

        if (newWhales.length > 0) {
          // Merge with existing, deduplicate by hash, keep newest 50
          const existingHashes = new Set(this.whaleTransactions.map(w => w.hash));
          const unique = newWhales.filter(w => !existingHashes.has(w.hash));
          this.whaleTransactions = [...unique, ...this.whaleTransactions]
            .sort((a, b) => b.time - a.time)
            .slice(0, 50);
        }
      }

      this.lastTimestamp = Date.now();
    } catch (err: unknown) {
      // Handle rate limiting with exponential backoff
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('Rate') || errMsg.includes('429') || errMsg.includes('Too Many')) {
        this.blockchainBackoffMs = Math.min(
          Math.max(this.blockchainBackoffMs * 2, BLOCKCHAIN_POLL_MS),
          5 * 60_000 // cap at 5 minutes
        );
        this.blockchainNextAllowed = Date.now() + this.blockchainBackoffMs;
        console.warn(
          `[OnChainCache] blockchain.info rate-limited, backing off ${this.blockchainBackoffMs / 1000}s`
        );
      } else {
        console.error('[OnChainCache] blockchain.info fetch error:', errMsg);
      }
    }
  }

  /**
   * Compare current hashrate to average of recent datapoints.
   * Returns UP if current is >2% above average, DOWN if >2% below, else FLAT.
   */
  private computeHashrateTrend(data: HashrateData): 'UP' | 'DOWN' | 'FLAT' {
    if (!data.hashrates || data.hashrates.length === 0 || !data.currentHashrate) {
      return 'FLAT';
    }

    const avg = data.hashrates.reduce((sum, h) => sum + h.avgHashrate, 0) / data.hashrates.length;
    if (avg <= 0) return 'FLAT';

    const ratio = data.currentHashrate / avg;

    if (ratio > 1.02) return 'UP';
    if (ratio < 0.98) return 'DOWN';
    return 'FLAT';
  }

  destroy() {
    if (this.mempoolTimerId) clearInterval(this.mempoolTimerId);
    if (this.blockchainTimerId) clearInterval(this.blockchainTimerId);
    this.started = false;
  }
}

// ---------------------------------------------------------------------------
// Global singleton (survives Next.js hot reloads)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-namespace
declare global {
  // eslint-disable-next-line no-var
  var _onChainCache: OnChainCache | undefined;
}

export function getOnChainCache(): OnChainCache {
  if (!global._onChainCache) {
    global._onChainCache = new OnChainCache();
  }
  return global._onChainCache;
}
