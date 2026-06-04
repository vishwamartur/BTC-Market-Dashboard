import { NextResponse } from 'next/server';
import { getSignalEngine } from '../../lib/signalEngine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const engine = getSignalEngine();
  const signal = engine.getLatestSignal();

  return NextResponse.json({
    ...signal,
    serverTime: Date.now(),
  });
}
