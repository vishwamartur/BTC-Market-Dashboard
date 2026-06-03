import { NextResponse } from 'next/server';
import { getDeltaPositions } from '../../lib/delta';
import { normalizeDeltaPosition } from '../../lib/positions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DELTA_API_KEY = process.env.DELTA_API_KEY || '';
const DELTA_API_SECRET = process.env.DELTA_API_SECRET || '';
const BTCUSDT_PRODUCT_ID = 27;

export async function GET() {
  if (!DELTA_API_KEY || !DELTA_API_SECRET) {
    return NextResponse.json({ error: 'Delta API credentials not configured' }, { status: 500 });
  }

  const result = await getDeltaPositions(DELTA_API_KEY, DELTA_API_SECRET, BTCUSDT_PRODUCT_ID);
  if (!result.success) {
    return NextResponse.json({ error: result.error || 'Failed to fetch Delta position' }, { status: 502 });
  }

  return NextResponse.json({
    success: true,
    position: normalizeDeltaPosition(result.result, BTCUSDT_PRODUCT_ID),
    timestamp: Date.now(),
  });
}
