import { NextResponse } from 'next/server';
import { insertOneAsync } from '../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const BINANCE_FAPI = 'https://fapi.binance.com';

export async function GET() {
  try {
    const [lsRatioRes, oiRes, ttRatioRes, tickerRes, priceRes, fundingRes] = await Promise.allSettled([
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

    const longShortRatio = await extract(lsRatioRes);
    const openInterest = await extract(oiRes);
    const topTraderRatio = await extract(ttRatioRes);
    const ticker = await extract(tickerRes);
    const priceData = await extract(priceRes);
    const fundingData = await extract(fundingRes);

    const response = {
      longShortRatio: Array.isArray(longShortRatio) && longShortRatio.length > 0
        ? longShortRatio[longShortRatio.length - 1]
        : null,
      openInterest,
      topTraderRatio: Array.isArray(topTraderRatio) && topTraderRatio.length > 0
        ? topTraderRatio[topTraderRatio.length - 1]
        : null,
      ticker,
      price: priceData,
      fundingRate: Array.isArray(fundingData) && fundingData.length > 0
        ? fundingData[fundingData.length - 1]
        : null,
      timestamp: Date.now(),
    };

    // Persist snapshot to MongoDB (fire-and-forget)
    insertOneAsync('market_snapshots', {
      ...response,
      _insertedAt: new Date(),
    });

    return NextResponse.json(response);
  } catch (error) {
    console.error('Market data fetch error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch market data' },
      { status: 500 }
    );
  }
}
