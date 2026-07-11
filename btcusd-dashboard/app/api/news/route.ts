import { NextResponse } from 'next/server';
import { getNewsSentimentManager } from '../../lib/newsSentiment';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const manager = getNewsSentimentManager();
  const snapshot = manager.getLatestSentiment();

  return NextResponse.json({
    score: snapshot.score,
    timestamp: snapshot.timestamp,
    headline: snapshot.headline,
  });
}
