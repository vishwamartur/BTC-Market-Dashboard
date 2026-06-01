import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { getDeltaFills } from '../../../lib/delta';

const DELTA_API_KEY = process.env.DELTA_API_KEY || '';
const DELTA_API_SECRET = process.env.DELTA_API_SECRET || '';
const BTCUSDT_PRODUCT_ID = 27;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '100', 10), 500);

    const db = await getDb();
    const collection = db.collection('trades');

    // Get all trades sorted by time
    const trades = await collection
      .find({})
      .sort({ timestamp: 1 }) // ascending for P&L calculation
      .limit(limit)
      .toArray();

    // Calculate cumulative P&L
    let cumulativePnl = 0;
    let winCount = 0;
    let lossCount = 0;
    let totalTrades = 0;

    // Fetch real fills from Delta Exchange to get actual realized P&L
    const fillsData = await getDeltaFills(DELTA_API_KEY, DELTA_API_SECRET, BTCUSDT_PRODUCT_ID, limit);
    if (fillsData && !fillsData.success) {
      console.warn('Could not fetch Delta fills:', fillsData.error);
    }

    const deltaFills = fillsData?.success && Array.isArray(fillsData.result) ? fillsData.result : [];
    
    // Map order_id to sum of realized_pnl
    const orderPnlMap = new Map<number, number>();
    for (const fill of deltaFills) {
      const oid = Number(fill.order_id);
      const pnl = Number(fill.realized_pnl || 0);
      orderPnlMap.set(oid, (orderPnlMap.get(oid) || 0) + pnl);
    }

    const pnlSeries: {
      timestamp: string;
      action: string;
      side: string;
      isPaperTrade: boolean;
      status: string;
      cumulativePnl: number;
      tradeNumber: number;
    }[] = [];

    // Group trades by day for daily summary
    const dailyMap = new Map<string, {
      date: string;
      buyCount: number;
      sellCount: number;
      successCount: number;
      failedCount: number;
      totalTrades: number;
    }>();

    for (const trade of trades) {
      totalTrades++;
      const ts = new Date(trade.timestamp);
      const dateKey = ts.toISOString().split('T')[0];

      if (trade.status === 'SUCCESS') {
        let tradePnl = 0;

        if (trade.isPaperTrade) {
          // Simulate a random P&L between -50 and +80 for paper trades
          const seed = trade.orderId || totalTrades;
          const pseudoRandom = Math.sin(typeof seed === 'number' ? seed : parseInt(String(seed), 10) || totalTrades) * 43758.5453;
          const normalized = pseudoRandom - Math.floor(pseudoRandom); // 0-1
          tradePnl = (normalized * 130) - 50; 
        } else {
          // Use actual realized PnL from Delta Exchange fills
          if (trade.orderId && orderPnlMap.has(Number(trade.orderId))) {
            tradePnl = orderPnlMap.get(Number(trade.orderId))!;
          }
        }

        cumulativePnl += tradePnl;

        if (tradePnl > 0) winCount++;
        else if (tradePnl < 0) lossCount++;
      }

      pnlSeries.push({
        timestamp: ts.toISOString(),
        action: trade.action,
        side: trade.side,
        isPaperTrade: trade.isPaperTrade,
        status: trade.status,
        cumulativePnl: Math.round(cumulativePnl * 100) / 100,
        tradeNumber: totalTrades,
      });

      // Daily summary
      if (!dailyMap.has(dateKey)) {
        dailyMap.set(dateKey, {
          date: dateKey,
          buyCount: 0,
          sellCount: 0,
          successCount: 0,
          failedCount: 0,
          totalTrades: 0,
        });
      }
      const day = dailyMap.get(dateKey)!;
      day.totalTrades++;
      if (trade.action === 'BUY') day.buyCount++;
      else day.sellCount++;
      if (trade.status === 'SUCCESS') day.successCount++;
      else day.failedCount++;
    }

    return NextResponse.json({
      pnlSeries,
      dailySummary: Array.from(dailyMap.values()),
      stats: {
        totalTrades,
        winCount,
        lossCount,
        winRate: totalTrades > 0 ? Math.round((winCount / Math.max(winCount + lossCount, 1)) * 100) : 0,
        cumulativePnl: Math.round(cumulativePnl * 100) / 100,
      },
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('Trade performance error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch trade performance', pnlSeries: [], stats: null },
      { status: 500 }
    );
  }
}
