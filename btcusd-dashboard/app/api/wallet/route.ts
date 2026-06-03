import { NextResponse } from 'next/server';
import { getDeltaWalletBalances } from '../../lib/delta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DELTA_API_KEY = process.env.DELTA_API_KEY || '';
const DELTA_API_SECRET = process.env.DELTA_API_SECRET || '';

export async function GET() {
  if (!DELTA_API_KEY || !DELTA_API_SECRET) {
    return NextResponse.json({ error: 'Delta API credentials not configured' }, { status: 500 });
  }

  const result = await getDeltaWalletBalances(DELTA_API_KEY, DELTA_API_SECRET);
  if (!result.success) {
    return NextResponse.json({ error: result.error || 'Failed to fetch wallet balances' }, { status: 502 });
  }

  return NextResponse.json({
    success: true,
    balances: result.result,
    timestamp: Date.now(),
  });
}
