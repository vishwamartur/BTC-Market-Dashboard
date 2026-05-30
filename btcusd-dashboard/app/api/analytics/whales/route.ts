import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = Math.min(parseInt(searchParams.get('days') || '7', 10), 30);

    const db = await getDb();
    const collection = db.collection('whale_transactions');

    const sinceTs = Date.now() - days * 24 * 60 * 60 * 1000;

    // Aggregate by day and flow type
    const dailyFlows = await collection.aggregate([
      { $match: { time: { $gt: sinceTs } } },
      {
        $addFields: {
          dateObj: { $toDate: '$time' },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: '$dateObj' },
            month: { $month: '$dateObj' },
            day: { $dayOfMonth: '$dateObj' },
            type: '$type',
          },
          totalBtc: { $sum: '$amountBtc' },
          totalUsd: { $sum: '$usdValue' },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
    ]).toArray();

    // Reshape into daily summaries
    const dailyMap = new Map<string, {
      date: string;
      inflowBtc: number;
      inflowUsd: number;
      inflowCount: number;
      outflowBtc: number;
      outflowUsd: number;
      outflowCount: number;
      transferBtc: number;
      transferUsd: number;
      transferCount: number;
      netFlowBtc: number;
    }>();

    for (const row of dailyFlows) {
      const dateKey = `${row._id.year}-${String(row._id.month).padStart(2, '0')}-${String(row._id.day).padStart(2, '0')}`;

      if (!dailyMap.has(dateKey)) {
        dailyMap.set(dateKey, {
          date: dateKey,
          inflowBtc: 0, inflowUsd: 0, inflowCount: 0,
          outflowBtc: 0, outflowUsd: 0, outflowCount: 0,
          transferBtc: 0, transferUsd: 0, transferCount: 0,
          netFlowBtc: 0,
        });
      }

      const day = dailyMap.get(dateKey)!;
      if (row._id.type === 'INFLOW') {
        day.inflowBtc += row.totalBtc;
        day.inflowUsd += row.totalUsd;
        day.inflowCount += row.count;
      } else if (row._id.type === 'OUTFLOW') {
        day.outflowBtc += row.totalBtc;
        day.outflowUsd += row.totalUsd;
        day.outflowCount += row.count;
      } else {
        day.transferBtc += row.totalBtc;
        day.transferUsd += row.totalUsd;
        day.transferCount += row.count;
      }
      day.netFlowBtc = day.outflowBtc - day.inflowBtc; // positive = bullish
    }

    // Overall totals
    const totals = await collection.aggregate([
      { $match: { time: { $gt: sinceTs } } },
      {
        $group: {
          _id: '$type',
          totalBtc: { $sum: '$amountBtc' },
          totalUsd: { $sum: '$usdValue' },
          count: { $sum: 1 },
        },
      },
    ]).toArray();

    const summary: Record<string, { totalBtc: number; totalUsd: number; count: number }> = {};
    for (const t of totals) {
      summary[t._id] = { totalBtc: t.totalBtc, totalUsd: t.totalUsd, count: t.count };
    }

    // Top whale transactions
    const topWhales = await collection
      .find({ time: { $gt: sinceTs } })
      .sort({ amountBtc: -1 })
      .limit(10)
      .toArray();

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const cleanWhales = topWhales.map(({ _id, _insertedAt, ...rest }: Record<string, any>) => rest);

    return NextResponse.json({
      daily: Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
      summary,
      topWhales: cleanWhales,
      days,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('Whale flows error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch whale flows', daily: [], summary: {} },
      { status: 500 }
    );
  }
}
