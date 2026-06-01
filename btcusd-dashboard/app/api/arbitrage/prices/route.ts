import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const BINANCE_API = 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT';
    const BYBIT_API = 'https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT';
    const DELTA_API = 'https://api.india.delta.exchange/v2/tickers/BTCUSD';

    const timeFetch = async (url: string) => {
      const start = Date.now();
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        return { res, latency: Date.now() - start };
      } catch (error) {
        return { res: null, latency: Date.now() - start };
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

    if (binanceResult.res && binanceResult.res.ok) {
      const data = await binanceResult.res.json();
      binancePrice = parseFloat(data.price);
    }

    if (bybitResult.res && bybitResult.res.ok) {
      const data = await bybitResult.res.json();
      if (data.result?.list?.[0]?.lastPrice) {
        bybitPrice = parseFloat(data.result.list[0].lastPrice);
      }
    }

    if (deltaResult.res && deltaResult.res.ok) {
      const data = await deltaResult.res.json();
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
