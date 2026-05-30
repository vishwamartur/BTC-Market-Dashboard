import { NextResponse } from 'next/server';
import { getDb } from '../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '200', 10), 1000);
    const since = searchParams.get('since');
    const exchange = searchParams.get('exchange');
    const side = searchParams.get('side');

    const db = await getDb();
    const collection = db.collection('liquidations');

    // Build filter
    const filter: Record<string, unknown> = {};
    if (since) {
      filter.orderTradeTime = { $gt: parseInt(since, 10) };
    }
    if (exchange) {
      filter.exchange = exchange.charAt(0).toUpperCase() + exchange.slice(1).toLowerCase();
    }
    if (side) {
      filter.side = side.toUpperCase();
    }

    // Fetch recent liquidations
    const events = await collection
      .find(filter)
      .sort({ orderTradeTime: -1 })
      .limit(limit)
      .toArray();

    // Compute aggregate stats from all stored events (last 24h)
    const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
    const statsAgg = await collection.aggregate([
      { $match: { orderTradeTime: { $gt: twentyFourHoursAgo } } },
      {
        $group: {
          _id: null,
          totalLongLiquidations: {
            $sum: { $cond: [{ $eq: ['$side', 'SELL'] }, 1, 0] },
          },
          totalShortLiquidations: {
            $sum: { $cond: [{ $eq: ['$side', 'BUY'] }, 1, 0] },
          },
          totalLongUsd: {
            $sum: { $cond: [{ $eq: ['$side', 'SELL'] }, '$usdValue', 0] },
          },
          totalShortUsd: {
            $sum: { $cond: [{ $eq: ['$side', 'BUY'] }, '$usdValue', 0] },
          },
          largestUsdValue: { $max: '$usdValue' },
          count: { $sum: 1 },
        },
      },
    ]).toArray();

    const stats = statsAgg[0] || {
      totalLongLiquidations: 0,
      totalShortLiquidations: 0,
      totalLongUsd: 0,
      totalShortUsd: 0,
      count: 0,
    };

    // Clean _id from events
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const cleanEvents = events.map(({ _id, _insertedAt, ...rest }: Record<string, any>) => rest);

    return NextResponse.json({
      events: cleanEvents,
      stats,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('Liquidations query error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch liquidations', events: [], stats: null },
      { status: 500 }
    );
  }
}
