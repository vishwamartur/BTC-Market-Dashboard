import { NextResponse } from 'next/server';
import { getDeltaFills, getDeltaPositions } from '../../../lib/delta';
import {
  buildPayoffCurve,
  buildPnlHistory,
  isOptionSymbol,
  parseOptionStrike,
  type OptionPosition,
} from '../../../lib/hedgePayoff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DELTA_API_KEY = process.env.DELTA_API_KEY || '';
const DELTA_API_SECRET = process.env.DELTA_API_SECRET || '';

const CACHE_TTL_MS = 5000;
let cachedResult: { data: unknown; fetchedAt: number } | null = null;

interface RawDeltaPosition {
  product_symbol?: string;
  symbol?: string;
  size?: number;
  entry_price?: string;
  unrealized_pnl?: string;
  side?: string;
}

function normalizeOptionPositions(rawPositions: unknown[]): OptionPosition[] {
  return rawPositions
    .filter((p): p is RawDeltaPosition => {
      const sym = (p as RawDeltaPosition).product_symbol || (p as RawDeltaPosition).symbol || '';
      return isOptionSymbol(sym);
    })
    .map((p) => {
      const sym = p.product_symbol || p.symbol || '';
      const size = Math.abs(Number(p.size) || 0);
      const rawSide = String(p.side || '').toLowerCase();
      const side: OptionPosition['side'] =
        rawSide.includes('short') || rawSide === 'sell' ? 'SHORT' : 'LONG';
      return {
        symbol: sym,
        side,
        size,
        entryPrice: Number(p.entry_price) || 0,
        unrealizedPnl: Number(p.unrealized_pnl) || 0,
      };
    })
    .filter((p) => p.size > 0 && parseOptionStrike(p.symbol) !== null);
}

function findStraddlePair(positions: OptionPosition[]): {
  call: OptionPosition | null;
  put: OptionPosition | null;
} {
  const call = positions.find((p) => p.symbol.startsWith('C-')) || null;
  const put = positions.find((p) => p.symbol.startsWith('P-')) || null;
  return { call, put };
}

/**
 * Parse the YYMMDD expiry segment of a Delta option symbol (e.g. 250711)
 * into a UTC timestamp. Returns null if the segment is missing or malformed.
 */
function parseOptionExpiry(symbol: string | null): number | null {
  if (!symbol) return null;
  const expiryPart = symbol.split('-')[2];
  if (!expiryPart || !/^\d{6}$/.test(expiryPart)) return null;
  return new Date(
    `20${expiryPart.slice(0, 2)}-${expiryPart.slice(2, 4)}-${expiryPart.slice(4, 6)}T00:00:00Z`,
  ).getTime();
}

export async function GET() {
  if (!DELTA_API_KEY || !DELTA_API_SECRET) {
    return NextResponse.json(
      { success: false, error: 'Delta API credentials not configured' },
      { status: 500 },
    );
  }

  if (cachedResult && Date.now() - cachedResult.fetchedAt < CACHE_TTL_MS) {
    return NextResponse.json(cachedResult.data);
  }

  try {
    const [positionsRes, fillsRes] = await Promise.all([
      getDeltaPositions(DELTA_API_KEY, DELTA_API_SECRET),
      getDeltaFills(DELTA_API_KEY, DELTA_API_SECRET, undefined, 500),
    ]);

    if (!positionsRes.success) {
      return NextResponse.json(
        { success: false, error: positionsRes.error || 'Failed to fetch positions' },
        { status: 502 },
      );
    }

    const rawPositions = Array.isArray(positionsRes.result) ? positionsRes.result : [];
    const optionPositions = normalizeOptionPositions(rawPositions);
    const { call, put } = findStraddlePair(optionPositions);

    // Use current BTC price from positions if available, otherwise a sensible default
    const btcFutures = rawPositions.find(
      (p: any) => p.product_id === 27 || (p.product_symbol || p.symbol) === 'BTCUSDT',
    ) as any;
    const currentPrice = Number(btcFutures?.mark_price || 0);

    const payoffResult = buildPayoffCurve({ call, put, _currentPrice: currentPrice });

    const { history, totalRealizedPnl } = buildPnlHistory(
      Array.isArray(fillsRes?.result) ? fillsRes.result : [],
      optionPositions,
    );

    const currentUnrealizedPnl = optionPositions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
    const hasHedge = optionPositions.length > 0;

    const responseData = {
      success: true,
      hasHedge,
      currentPrice: Math.round(currentPrice * 100) / 100,
      strike: payoffResult.strike,
      breakevens: payoffResult.breakevens,
      maxProfit: payoffResult.maxProfit,
      currentUnrealizedPnl: Math.round(currentUnrealizedPnl * 100) / 100,
      totalRealizedPnl,
      payoffCurve: payoffResult.curve,
      pnlHistory: history,
      metadata: {
        callSymbol: call?.symbol || null,
        putSymbol: put?.symbol || null,
        size: call?.size || put?.size || null,
        entryNotional: payoffResult.maxProfit,
        expiryTime: parseOptionExpiry(call?.symbol || null),
      },
      timestamp: Date.now(),
    };

    cachedResult = { data: responseData, fetchedAt: Date.now() };
    return NextResponse.json(responseData);
  } catch (error: any) {
    console.error('[/api/hedge/payoff] error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to calculate hedge payoff' },
      { status: 500 },
    );
  }
}
