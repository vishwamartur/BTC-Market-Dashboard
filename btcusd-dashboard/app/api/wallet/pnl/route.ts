import { NextResponse } from 'next/server';
import { getDeltaFills } from '../../../lib/delta';

const DELTA_API_KEY = process.env.DELTA_API_KEY || '';
const DELTA_API_SECRET = process.env.DELTA_API_SECRET || '';
// We can omit product ID to get fills across all products, or use BTCUSDT_PRODUCT_ID=27

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '500', 10), 1000);

    if (!DELTA_API_KEY || !DELTA_API_SECRET) {
      return NextResponse.json({ error: 'Delta API credentials not configured' }, { status: 500 });
    }

    // Fetch real fills from Delta Exchange
    const fillsData = await getDeltaFills(DELTA_API_KEY, DELTA_API_SECRET, undefined, limit);
    
    if (!fillsData || !fillsData.success) {
      return NextResponse.json({ error: fillsData?.error || 'Failed to fetch fills from Delta' }, { status: 502 });
    }

    const deltaFills = Array.isArray(fillsData.result) ? fillsData.result : [];
    
    // Fills are usually returned newest first. We need oldest first for cumulative sum.
    const sortedFills = [...deltaFills].sort((a, b) => {
      const timeA = new Date(a.created_at).getTime();
      const timeB = new Date(b.created_at).getTime();
      return timeA - timeB;
    });

    let cumulativePnl = 0;
    let winCount = 0;
    let lossCount = 0;
    let totalTrades = sortedFills.length;

    const pnlSeries: {
      timestamp: string;
      cumulativePnl: number;
      realizedPnl: number;
      tradeNumber: number;
      rawFill?: any;
    }[] = [];

    // Base point (start at 0)
    pnlSeries.push({
      timestamp: sortedFills.length > 0 ? sortedFills[0].created_at : new Date().toISOString(),
      cumulativePnl: 0,
      realizedPnl: 0,
      tradeNumber: 0,
    });

    for (let i = 0; i < sortedFills.length; i++) {
      const fill = sortedFills[i];
      const pnl = Number(fill.realized_pnl || 0);
      
      cumulativePnl += pnl;

      if (pnl > 0) winCount++;
      else if (pnl < 0) lossCount++;

      pnlSeries.push({
        timestamp: fill.created_at,
        cumulativePnl: Math.round(cumulativePnl * 100) / 100,
        realizedPnl: Math.round(pnl * 100) / 100,
        tradeNumber: i + 1,
        rawFill: fill,
      });
    }

    return NextResponse.json({
      success: true,
      pnlSeries,
      stats: {
        totalTrades,
        winCount,
        lossCount,
        winRate: totalTrades > 0 ? Math.round((winCount / Math.max(winCount + lossCount, 1)) * 100) : 0,
        cumulativePnl: Math.round(cumulativePnl * 100) / 100,
      },
      timestamp: Date.now(),
    });
  } catch (error: any) {
    console.error('Wallet PNL API error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to calculate PNL' },
      { status: 500 }
    );
  }
}
