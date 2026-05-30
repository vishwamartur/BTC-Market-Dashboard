import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const hours = Math.min(parseInt(searchParams.get('hours') || '72', 10), 168); // Max 7 days

    const db = await getDb();
    const collection = db.collection('market_snapshots');

    const sinceTs = Date.now() - hours * 60 * 60 * 1000;

    // Get market snapshots within the time window, sampled every ~5 minutes
    const snapshots = await collection
      .find({ timestamp: { $gt: sinceTs } })
      .sort({ timestamp: 1 })
      .toArray();

    // Downsample to prevent too many points — keep 1 per ~5 minute window
    const sampledData: {
      timestamp: number;
      price: number | null;
      openInterest: number | null;
      longShortRatio: number | null;
    }[] = [];

    let lastSampledTs = 0;
    const SAMPLE_INTERVAL = 5 * 60 * 1000; // 5 minutes

    for (const snap of snapshots) {
      if (snap.timestamp - lastSampledTs < SAMPLE_INTERVAL) continue;
      lastSampledTs = snap.timestamp;

      const priceVal = snap.price?.price
        ? parseFloat(snap.price.price)
        : snap.ticker?.lastPrice
          ? parseFloat(snap.ticker.lastPrice)
          : null;

      const oiVal = snap.openInterest?.openInterest
        ? parseFloat(snap.openInterest.openInterest)
        : null;

      const lsVal = snap.longShortRatio?.longShortRatio
        ? parseFloat(snap.longShortRatio.longShortRatio)
        : null;

      sampledData.push({
        timestamp: snap.timestamp,
        price: priceVal,
        openInterest: oiVal,
        longShortRatio: lsVal,
      });
    }

    return NextResponse.json({
      data: sampledData,
      hours,
      totalSnapshots: snapshots.length,
      sampledPoints: sampledData.length,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('OI divergence error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch OI data', data: [] },
      { status: 500 }
    );
  }
}
