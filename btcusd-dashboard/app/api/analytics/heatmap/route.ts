import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = Math.min(parseInt(searchParams.get('days') || '7', 10), 30);

    const db = await getDb();
    const collection = db.collection('liquidations');

    const sinceTs = Date.now() - days * 24 * 60 * 60 * 1000;

    // Aggregate liquidations by day-of-week (0-6) and hour (0-23)
    const heatmapData = await collection.aggregate([
      { $match: { orderTradeTime: { $gt: sinceTs } } },
      {
        $addFields: {
          dateObj: { $toDate: '$orderTradeTime' },
        },
      },
      {
        $group: {
          _id: {
            dayOfWeek: { $dayOfWeek: '$dateObj' }, // 1=Sun, 7=Sat
            hour: { $hour: '$dateObj' },
          },
          totalUsd: { $sum: '$usdValue' },
          count: { $sum: 1 },
          longUsd: {
            $sum: { $cond: [{ $eq: ['$side', 'SELL'] }, '$usdValue', 0] },
          },
          shortUsd: {
            $sum: { $cond: [{ $eq: ['$side', 'BUY'] }, '$usdValue', 0] },
          },
        },
      },
      { $sort: { '_id.dayOfWeek': 1, '_id.hour': 1 } },
    ]).toArray();

    // Also aggregate by hour only (for hourly distribution)
    const hourlyData = await collection.aggregate([
      { $match: { orderTradeTime: { $gt: sinceTs } } },
      {
        $addFields: {
          dateObj: { $toDate: '$orderTradeTime' },
        },
      },
      {
        $group: {
          _id: { hour: { $hour: '$dateObj' } },
          totalUsd: { $sum: '$usdValue' },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.hour': 1 } },
    ]).toArray();

    // Daily totals
    const dailyData = await collection.aggregate([
      { $match: { orderTradeTime: { $gt: sinceTs } } },
      {
        $addFields: {
          dateObj: { $toDate: '$orderTradeTime' },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: '$dateObj' },
            month: { $month: '$dateObj' },
            day: { $dayOfMonth: '$dateObj' },
          },
          totalUsd: { $sum: '$usdValue' },
          longUsd: {
            $sum: { $cond: [{ $eq: ['$side', 'SELL'] }, '$usdValue', 0] },
          },
          shortUsd: {
            $sum: { $cond: [{ $eq: ['$side', 'BUY'] }, '$usdValue', 0] },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
    ]).toArray();

    return NextResponse.json({
      heatmap: heatmapData,
      hourly: hourlyData,
      daily: dailyData,
      days,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('Heatmap analytics error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch heatmap data', heatmap: [], hourly: [], daily: [] },
      { status: 500 }
    );
  }
}
