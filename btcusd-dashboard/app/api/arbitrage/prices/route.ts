import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const BINANCE_API = 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT';
    const BYBIT_API = 'https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT';
    const DELTA_API = 'https://api.india.delta.exchange/v2/tickers/BTCUSD';

    // Consume the response body inside the fetch helper so the abort signal
    // cannot kill the body stream between fetch() and .json().
    const timeFetch = async (url: string): Promise<{ data: unknown; latency: number }> => {
      const start = Date.now();
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) {
          return { data: null, latency: Date.now() - start };
        }
        const data = await res.json();
        return { data, latency: Date.now() - start };
      } catch (error) {
        console.warn(`[ARB PRICES] Fetch failed for ${url}:`, (error as Error).message);
        return { data: null, latency: Date.now() - start };
      }
    };

    const [binanceResult, bybitResult, deltaResult] = await Promise.all([
      timeFetch(BINANCE_API),
      timeFetch(BYBIT_API),
      timeFetch(DELTA_API)
    ]);

    let binancePrice = null;
    let bybitPrice = null;
    let deltaPrice = null;
    let deltaBid = null;
    let deltaAsk = null;

    if (binanceResult.data) {
      const data = binanceResult.data as { price?: string };
      if (data.price) binancePrice = parseFloat(data.price);
    }

    if (bybitResult.data) {
      const data = bybitResult.data as { result?: { list?: { lastPrice?: string }[] } };
      if (data.result?.list?.[0]?.lastPrice) {
        bybitPrice = parseFloat(data.result.list[0].lastPrice);
      }
    }

    if (deltaResult.data) {
      const data = deltaResult.data as { success?: boolean; result?: { mark_price?: string; quotes?: { best_bid?: string; best_ask?: string } } };
      if (data.success && data.result?.mark_price) {
        deltaPrice = parseFloat(data.result.mark_price);
        deltaBid = parseFloat(data.result.quotes?.best_bid || data.result.mark_price);
        deltaAsk = parseFloat(data.result.quotes?.best_ask || data.result.mark_price);
      }
    }

    // Determine consensus fair price (favor Binance if available)
    let consensusPrice = null;
    if (binancePrice) {
      consensusPrice = binancePrice;
    } else if (bybitPrice) {
      consensusPrice = bybitPrice;
    } else if (deltaPrice) {
      consensusPrice = deltaPrice;
    }

    // Sanity check: detect possible USD/INR mismatch or stale data
    // If Delta price is >5x or <0.2x the consensus, something is very wrong
    if (consensusPrice && deltaPrice) {
      const ratio = deltaPrice / consensusPrice;
      if (ratio > 5 || ratio < 0.2) {
        console.error(`[ARB PRICES] CRITICAL: Delta price ($${deltaPrice}) is ${ratio.toFixed(1)}x consensus ($${consensusPrice}). Possible USD/INR mismatch or stale data. Skipping Delta price.`);
        deltaPrice = null;
        deltaBid = null;
        deltaAsk = null;
      }
    }

    // Calculate spread if we have consensus and delta prices
    let spreadPct = 0;
    if (consensusPrice && deltaPrice) {
        spreadPct = ((deltaPrice - consensusPrice) / consensusPrice) * 100;
    }

    return NextResponse.json({
      prices: {
        binance: binancePrice,
        bybit: bybitPrice,
        delta: deltaPrice,
        deltaBid,
        deltaAsk,
        consensus: consensusPrice
      },
      latencies: {
        binance: binanceResult.latency,
        bybit: bybitResult.latency,
        delta: deltaResult.latency
      },
      spreadPct,
      timestamp: Date.now()
    });

  } catch (error) {
    console.error('Arbitrage price fetch error:', error);
    return NextResponse.json({ error: 'Failed to fetch arbitrage prices' }, { status: 500 });
  }
}
