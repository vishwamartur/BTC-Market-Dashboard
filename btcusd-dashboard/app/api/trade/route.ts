import { NextResponse } from 'next/server';
import { placeDeltaOrder, setDeltaLeverage } from '../../lib/delta';
import { insertOneAsync } from '../../lib/db';

export const runtime = 'nodejs';

// Delta API Keys — MUST be set in .env.local, no hardcoded fallbacks
const DELTA_API_KEY = process.env.DELTA_API_KEY || '';
const DELTA_API_SECRET = process.env.DELTA_API_SECRET || '';

// Product ID 27 is BTCUSD linear perp on Delta Exchange India
const BTCUSDT_PRODUCT_ID = 27;
const LEVERAGE = 50;

// Server-side safety limits
const DEFAULT_TRADE_SIZE = 1;
const MAX_TRADE_SIZE = 5; // Hard cap regardless of client request

export async function POST(request: Request) {
  try {
    const body = await request.json();
    // Default to paper trade for safety — client must explicitly set isPaperTrade=false
    const { action, size: rawSize = DEFAULT_TRADE_SIZE, isPaperTrade = true } = body;

    if (!['BUY', 'SELL'].includes(action)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    // Server-side size validation
    const size = Math.min(Math.max(1, Math.floor(Number(rawSize) || 1)), MAX_TRADE_SIZE);

    const side = action === 'BUY' ? 'buy' : 'sell';

    if (isPaperTrade) {
      // Simulate trade execution
      console.log(`[PAPER TRADE] Executing ${side.toUpperCase()} for ${size} contracts on Product ${BTCUSDT_PRODUCT_ID}`);
      const paperResult = {
        success: true,
        isPaperTrade: true,
        result: {
          id: Math.floor(Math.random() * 1000000),
          product_id: BTCUSDT_PRODUCT_ID,
          size,
          side,
          state: 'paper_filled',
          created_at: new Date().toISOString()
        }
      };

      insertOneAsync('trades', {
        timestamp: new Date(),
        action: action as string,
        side,
        size,
        isPaperTrade: true,
        status: 'SUCCESS',
        orderId: paperResult.result.id,
        productId: BTCUSDT_PRODUCT_ID,
      });

      return NextResponse.json(paperResult);
    }

    // Live trading — verify credentials exist
    if (!DELTA_API_KEY || !DELTA_API_SECRET) {
      console.error('[REAL TRADE] Missing DELTA_API_KEY or DELTA_API_SECRET in env');
      return NextResponse.json({ error: 'Delta API credentials not configured' }, { status: 500 });
    }

    console.log(`[REAL TRADE] Preparing order to Delta: ${side.toUpperCase()} ${size} contracts`);

    // 1. Set Leverage
    const levResult = await setDeltaLeverage(DELTA_API_KEY, DELTA_API_SECRET, BTCUSDT_PRODUCT_ID, LEVERAGE);
    if (!levResult.success && levResult.error?.code !== 'leverage_not_changed') {
      console.log('[REAL TRADE] Failed to set leverage:', levResult.error);
      // We log it but don't strictly fail the trade if leverage couldn't be adjusted 
      // (sometimes it throws leverage_not_changed which is fine)
    }

    // 2. Fetch Ticker for Best Price
    let limitPrice: string | undefined;
    try {
      const baseUrl = process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange';
      const tickerRes = await fetch(`${baseUrl}/v2/tickers/BTCUSD`);
      const tickerData = await tickerRes.json();
      if (tickerData.success) {
        // Use best_bid for Buy (Maker), best_ask for Sell (Maker)
        limitPrice = side === 'buy' ? tickerData.result.quotes.best_bid : tickerData.result.quotes.best_ask;
        console.log(`[REAL TRADE] Fetched limit price: ${limitPrice}`);
      }
    } catch (e) {
      console.error('[REAL TRADE] Error fetching ticker:', e);
      return NextResponse.json({ error: 'Failed to fetch limit price' }, { status: 500 });
    }

    if (!limitPrice) {
      return NextResponse.json({ error: 'Could not determine limit price' }, { status: 500 });
    }

    // 3. Execute Limit Order
    console.log(`[REAL TRADE] Sending LIMIT order to Delta: ${side.toUpperCase()} ${size} contracts at ${limitPrice}`);
    const result = await placeDeltaOrder(
      DELTA_API_KEY,
      DELTA_API_SECRET,
      BTCUSDT_PRODUCT_ID,
      size,
      side,
      'limit',
      limitPrice
    );

    if (result.success) {
      console.log('[REAL TRADE] Success:', result.result);

      // Persist real trade to MongoDB
      insertOneAsync('trades', {
        timestamp: new Date(),
        action: action as string,
        side,
        size,
        isPaperTrade: false,
        status: 'SUCCESS',
        orderId: result.result?.id,
        productId: BTCUSDT_PRODUCT_ID,
        rawResult: result.result,
      });

      return NextResponse.json(result);
    } else {
      console.error('[REAL TRADE] Failed:', result.error);

      // Persist failed trade to MongoDB
      insertOneAsync('trades', {
        timestamp: new Date(),
        action: action as string,
        side,
        size,
        isPaperTrade: false,
        status: 'FAILED',
        error: result.error,
        productId: BTCUSDT_PRODUCT_ID,
      });

      return NextResponse.json(result, { status: 400 });
    }

  } catch (error: any) {
    console.error('Trade execution error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
