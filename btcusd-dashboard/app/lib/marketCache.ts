/**
 * In-memory cache for market data (Binance REST).
 * A single background loop fetches every POLL_INTERVAL_MS.
 * All API route callers read from cache — zero outbound requests.
 */

const BINANCE_FAPI = 'https://fapi.binance.com';
const POLL_INTERVAL_MS = 10_000; // 10 seconds

export interface MarketSnapshot {
  longShortRatio: unknown;
  openInterest: unknown;
  topTraderRatio: unknown;
  ticker: unknown;
  price: unknown;
  fundingRate: unknown;
  timestamp: number;
}

class MarketCache {
  private cache: MarketSnapshot | null = null;
  private lastFetchTime = 0;
  private fetching = false;
  private started = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  /** Callback to persist each snapshot (e.g., to MongoDB). */
  private persistCallback: ((snapshot: MarketSnapshot) => void) | null = null;

  setPersistCallback(cb: (snapshot: MarketSnapshot) => void) {
    this.persistCallback = cb;
  }

  /** Get the cached snapshot (may be null on first call). */
  get(): MarketSnapshot | null {
    this.ensureStarted();
    return this.cache;
  }

  /** Age of the current cache entry in ms. */
  get ageMs(): number {
    return this.lastFetchTime ? Date.now() - this.lastFetchTime : Infinity;
  }

  /** Force a refresh (returns when complete). */
  async refresh(): Promise<MarketSnapshot | null> {
    await this.fetchAll();
    return this.cache;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private ensureStarted() {
    if (this.started) return;
    this.started = true;

    console.log('[MarketCache] Starting background fetch loop');

    // Kick off initial fetch immediately
    this.fetchAll().catch(() => {});

    // Then poll on interval
    this.intervalId = setInterval(() => {
      this.fetchAll().catch((err) => {
        console.error('[MarketCache] Background fetch error:', err);
      });
    }, POLL_INTERVAL_MS);
  }

  private async fetchAll(): Promise<void> {
    if (this.fetching) return; // deduplicate concurrent calls
    this.fetching = true;

    try {
      const [lsRatioRes, oiRes, ttRatioRes, tickerRes, priceRes, fundingRes] =
        await Promise.allSettled([
          fetch(`${BINANCE_FAPI}/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=1`),
          fetch(`${BINANCE_FAPI}/fapi/v1/openInterest?symbol=BTCUSDT`),
          fetch(`${BINANCE_FAPI}/futures/data/topLongShortPositionRatio?symbol=BTCUSDT&period=5m&limit=1`),
          fetch(`${BINANCE_FAPI}/fapi/v1/ticker/24hr?symbol=BTCUSDT`),
          fetch(`${BINANCE_FAPI}/fapi/v1/ticker/price?symbol=BTCUSDT`),
          fetch(`${BINANCE_FAPI}/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1`),
        ]);

      const extract = async (res: PromiseSettledResult<Response>) => {
        if (res.status === 'fulfilled' && res.value.ok) {
          return res.value.json();
        }
        return null;
      };

      const longShortRatioRaw = await extract(lsRatioRes);
      const openInterest = await extract(oiRes);
      const topTraderRatioRaw = await extract(ttRatioRes);
      const ticker = await extract(tickerRes);
      const priceData = await extract(priceRes);
      const fundingDataRaw = await extract(fundingRes);

      const snapshot: MarketSnapshot = {
        longShortRatio:
          Array.isArray(longShortRatioRaw) && longShortRatioRaw.length > 0
            ? longShortRatioRaw[longShortRatioRaw.length - 1]
            : null,
        openInterest,
        topTraderRatio:
          Array.isArray(topTraderRatioRaw) && topTraderRatioRaw.length > 0
            ? topTraderRatioRaw[topTraderRatioRaw.length - 1]
            : null,
        ticker,
        price: priceData,
        fundingRate:
          Array.isArray(fundingDataRaw) && fundingDataRaw.length > 0
            ? fundingDataRaw[fundingDataRaw.length - 1]
            : null,
        timestamp: Date.now(),
      };

      this.cache = snapshot;
      this.lastFetchTime = Date.now();

      if (this.persistCallback) {
        try { this.persistCallback(snapshot); } catch { /* ignore */ }
      }
    } finally {
      this.fetching = false;
    }
  }

  destroy() {
    if (this.intervalId) clearInterval(this.intervalId);
    this.started = false;
    this.cache = null;
  }
}

// ---------------------------------------------------------------------------
// Global singleton (survives Next.js hot reloads)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-namespace
declare global {
  // eslint-disable-next-line no-var
  var _marketCache: MarketCache | undefined;
}

export function getMarketCache(): MarketCache {
  if (!global._marketCache) {
    global._marketCache = new MarketCache();
  }
  return global._marketCache;
}
