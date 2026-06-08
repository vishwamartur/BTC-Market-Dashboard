import { NextResponse } from 'next/server';
import { getDb } from '../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200);

    const db = await getDb();
    const trades = await db.collection('trades')
      .find({ type: { $ne: 'ARBITRAGE' } })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const cleanTrades = trades.map(({ _id, ...rest }: Record<string, any>) => rest);

    return NextResponse.json({ trades: cleanTrades, timestamp: Date.now() });
  } catch (error) {
    console.error('Trades query error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch trades', trades: [] },
      { status: 500 }
    );
  }
}
