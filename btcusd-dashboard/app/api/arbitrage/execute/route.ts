import { NextResponse } from 'next/server';
import { placeDeltaOrder, setDeltaLeverage } from '../../../lib/delta';
import { insertOneAsync } from '../../../lib/db';

export const runtime = 'nodejs';

const DELTA_API_KEY = process.env.DELTA_API_KEY || '';
const DELTA_API_SECRET = process.env.DELTA_API_SECRET || '';
const BTCUSDT_PRODUCT_ID = 27;
const LEVERAGE = 50;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, size = 1, limitPrice, isPaperTrade = false, reason, spreadPct } = body;

    if (!['BUY_DELTA', 'SELL_DELTA', 'CLOSE_LONG', 'CLOSE_SHORT'].includes(action)) {
      return NextResponse.json({ error: 'Invalid arbitrage action' }, { status: 400 });
    }

    const side = (action === 'BUY_DELTA' || action === 'CLOSE_SHORT') ? 'buy' : 'sell';

    const tradeRecord = {
      timestamp: new Date(),
      type: 'ARBITRAGE',
      action,
      side,
      size,
      price: limitPrice,
      isPaperTrade,
      reason,
      spreadPct,
      status: 'PENDING'
    };

    if (isPaperTrade) {
      console.log(`[ARB PAPER] ${action} ${size} contracts at ${limitPrice} (Spread: ${spreadPct}%)`);
      const paperResult = {
        success: true,
        isPaperTrade: true,
        result: {
          id: `arb_${Math.floor(Math.random() * 1000000)}`,
          product_id: BTCUSDT_PRODUCT_ID,
          size,
          side,
          state: 'paper_filled',
          limit_price: limitPrice
        }
      };

      insertOneAsync('trades', { ...tradeRecord, status: 'SUCCESS', orderId: paperResult.result.id });
      return NextResponse.json(paperResult);
    }

    if (!DELTA_API_KEY || !DELTA_API_SECRET) {
      return NextResponse.json({ error: 'Delta API credentials not configured' }, { status: 500 });
    }

    if (!limitPrice) {
      return NextResponse.json({ error: 'Limit price required for arbitrage execution' }, { status: 400 });
    }

    console.log(`[ARB REAL] Preparing order to Delta: ${side.toUpperCase()} ${size} contracts`);

    // 1. Set Leverage
    const levResult = await setDeltaLeverage(DELTA_API_KEY, DELTA_API_SECRET, BTCUSDT_PRODUCT_ID, LEVERAGE);
    if (!levResult.success && levResult.error?.code !== 'leverage_not_changed') {
      console.log('[ARB REAL] Failed to set leverage:', levResult.error);
    }

    console.log(`[ARB REAL] Sending LIMIT order: ${side.toUpperCase()} ${size} @ ${limitPrice}`);

    
    const result = await placeDeltaOrder(
      DELTA_API_KEY,
      DELTA_API_SECRET,
      BTCUSDT_PRODUCT_ID,
      size,
      side,
      'limit',
      limitPrice.toString()
    );

    if (result.success) {
      insertOneAsync('trades', { ...tradeRecord, status: 'SUCCESS', orderId: result.result?.id, rawResult: result.result });
      return NextResponse.json(result);
    } else {
      console.error('[ARB REAL] Failed:', result.error);
      insertOneAsync('trades', { ...tradeRecord, status: 'FAILED', error: result.error });
      return NextResponse.json(result, { status: 400 });
    }

  } catch (error: any) {
    console.error('Arbitrage execution error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
