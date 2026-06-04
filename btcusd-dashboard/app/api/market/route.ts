import { NextResponse } from 'next/server';
import { getMarketCache } from '../../lib/marketCache';
import { insertOneAsync } from '../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const cache = getMarketCache();

    // Wire up MongoDB persistence (idempotent)
    cache.setPersistCallback((snapshot) => {
      insertOneAsync('market_snapshots', {
        ...snapshot,
        _insertedAt: new Date(),
      });
    });

    // Read from cache — near-instant; no outbound API calls
    let snapshot = cache.get();

    // First call ever: cache is empty — force a refresh
    if (!snapshot) {
      snapshot = await cache.refresh();
    }

    if (!snapshot) {
      return NextResponse.json(
        { error: 'Market data not yet available' },
        { status: 503 }
      );
    }

    return NextResponse.json(snapshot);
  } catch (error) {
    console.error('Market data fetch error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch market data' },
      { status: 500 }
    );
  }
}
