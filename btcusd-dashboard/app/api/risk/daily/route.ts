import { NextResponse } from 'next/server';
import { getCurrentDayRisk } from '../../../lib/dailyRiskService';
import { unavailableDailyRisk } from '../../../lib/dailyRisk';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DELTA_API_KEY = process.env.DELTA_API_KEY || '';
const DELTA_API_SECRET = process.env.DELTA_API_SECRET || '';

export async function GET() {
  if (!DELTA_API_KEY || !DELTA_API_SECRET) {
    return NextResponse.json(unavailableDailyRisk('Delta API credentials not configured'), { status: 503 });
  }

  const risk = await getCurrentDayRisk(DELTA_API_KEY, DELTA_API_SECRET);
  return NextResponse.json(risk, { status: risk.available ? 200 : 502 });
}
