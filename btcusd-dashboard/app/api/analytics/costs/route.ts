import { NextResponse } from 'next/server';
import { getDeltaFills } from '../../../lib/delta';

export const runtime = 'nodejs';

const DELTA_API_KEY = process.env.DELTA_API_KEY || '';
const DELTA_API_SECRET = process.env.DELTA_API_SECRET || '';
const BTCUSDT_PRODUCT_ID = 27;

interface FillEntry {
  id: number;
  size: number;
  fill_type: string;
  side: string;
  price: string;
  role: string; // 'maker' or 'taker'
  commission: string;
  created_at: string;
  product_id: number;
  realized_pnl?: string;
  meta_data?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function GET(request: Request) {
  try {
    if (!DELTA_API_KEY || !DELTA_API_SECRET) {
      return NextResponse.json(
        { success: false, error: 'Delta API credentials not configured' },
        { status: 500 }
      );
    }

    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '200', 10);

    const fillsRes = await getDeltaFills(DELTA_API_KEY, DELTA_API_SECRET, BTCUSDT_PRODUCT_ID, limit);

    if (!fillsRes.success) {
      return NextResponse.json(
        { success: false, error: fillsRes.error || 'Failed to fetch fills' },
        { status: 502 }
      );
    }

    const fills = (fillsRes.result as FillEntry[]) || [];

    // Calculate cost analysis
    let totalFees = 0;
    let totalMakerFees = 0;
    let totalTakerFees = 0;
    let makerCount = 0;
    let takerCount = 0;
    let totalRealizedPnl = 0;
    let grossWins = 0;
    let grossLosses = 0;
    let netWins = 0;
    let netLosses = 0;
    let feeKilledTrades = 0; // Profitable before fees, loss after
    let totalGst = 0;

    const GST_RATE = 0.1525; // 15.25% observed from user data

    // Per-trade cost breakdown for charting
    const tradeBreakdown: Array<{
      timestamp: string;
      side: string;
      size: number;
      price: number;
      fee: number;
      gst: number;
      totalCost: number;
      realizedPnl: number;
      netPnl: number;
      role: string;
      isFeeKilled: boolean;
    }> = [];

    // Daily aggregates
    const dailyCosts: Record<string, { fees: number; gst: number; pnl: number; netPnl: number; trades: number }> = {};

    for (const fill of fills) {
      const commission = Math.abs(parseFloat(fill.commission || '0'));
      const gst = commission * GST_RATE;
      const pnl = parseFloat(fill.realized_pnl || '0');
      const role = fill.role || 'taker';
      const totalCost = commission + gst;

      totalFees += commission;
      totalGst += gst;
      totalRealizedPnl += pnl;

      if (role === 'maker') {
        totalMakerFees += commission;
        makerCount++;
      } else {
        totalTakerFees += commission;
        takerCount++;
      }

      // Gross P&L (before fees)
      const grossPnl = pnl + commission; // Add back the commission to get gross
      if (grossPnl > 0) grossWins++;
      else if (grossPnl < 0) grossLosses++;

      // Net P&L (after fees — which is the realized_pnl from Delta minus GST)
      const netPnl = pnl - gst; // Delta already deducts commission from realized_pnl
      if (netPnl > 0) netWins++;
      else if (netPnl < 0) netLosses++;

      // Fee-killed: gross positive, net negative
      const isFeeKilled = grossPnl > 0 && netPnl <= 0;
      if (isFeeKilled) feeKilledTrades++;

      tradeBreakdown.push({
        timestamp: fill.created_at,
        side: fill.side,
        size: fill.size,
        price: parseFloat(fill.price),
        fee: commission,
        gst,
        totalCost,
        realizedPnl: pnl,
        netPnl,
        role,
        isFeeKilled,
      });

      // Daily aggregation
      const dateKey = new Date(fill.created_at).toISOString().split('T')[0];
      if (!dailyCosts[dateKey]) {
        dailyCosts[dateKey] = { fees: 0, gst: 0, pnl: 0, netPnl: 0, trades: 0 };
      }
      dailyCosts[dateKey].fees += commission;
      dailyCosts[dateKey].gst += gst;
      dailyCosts[dateKey].pnl += pnl;
      dailyCosts[dateKey].netPnl += netPnl;
      dailyCosts[dateKey].trades++;
    }

    const totalCosts = totalFees + totalGst;
    const grossTotalTrades = grossWins + grossLosses;
    const grossWinRate = grossTotalTrades > 0 ? ((grossWins / grossTotalTrades) * 100).toFixed(1) : '0';
    const netTotalTrades = netWins + netLosses;
    const netWinRate = netTotalTrades > 0 ? ((netWins / netTotalTrades) * 100).toFixed(1) : '0';
    const feeToGrossRatio = totalRealizedPnl !== 0
      ? ((totalCosts / Math.abs(totalRealizedPnl)) * 100).toFixed(1)
      : '0';
    const avgFeePerTrade = fills.length > 0 ? totalFees / fills.length : 0;
    const avgCostPerTrade = fills.length > 0 ? totalCosts / fills.length : 0;

    // Convert daily costs to sorted array
    const dailyCostsSorted = Object.entries(dailyCosts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, data]) => ({ date, ...data }));

    return NextResponse.json({
      success: true,
      summary: {
        totalFills: fills.length,
        totalFees: parseFloat(totalFees.toFixed(4)),
        totalGst: parseFloat(totalGst.toFixed(4)),
        totalCosts: parseFloat(totalCosts.toFixed(4)),
        totalMakerFees: parseFloat(totalMakerFees.toFixed(4)),
        totalTakerFees: parseFloat(totalTakerFees.toFixed(4)),
        makerCount,
        takerCount,
        totalRealizedPnl: parseFloat(totalRealizedPnl.toFixed(4)),
        netPnlAfterGst: parseFloat((totalRealizedPnl - totalGst).toFixed(4)),
        grossWinRate,
        netWinRate,
        grossWins,
        grossLosses,
        netWins,
        netLosses,
        feeKilledTrades,
        feeToGrossRatio,
        avgFeePerTrade: parseFloat(avgFeePerTrade.toFixed(4)),
        avgCostPerTrade: parseFloat(avgCostPerTrade.toFixed(4)),
      },
      dailyCosts: dailyCostsSorted,
      tradeBreakdown: tradeBreakdown.slice(0, 50), // Limit to recent 50 for UI
    });
  } catch (error: unknown) {
    console.error('Cost analysis error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
