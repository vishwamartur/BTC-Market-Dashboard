import { NextResponse } from 'next/server';
import { placeDeltaOrder, setDeltaLeverage, getOrderById, cancelOrder } from '../../../lib/delta';
import { insertOneAsync } from '../../../lib/db';

export const runtime = 'nodejs';

const DELTA_API_KEY = process.env.DELTA_API_KEY || '';
const DELTA_API_SECRET = process.env.DELTA_API_SECRET || '';
const BTCUSDT_PRODUCT_ID = 27;
const LEVERAGE = 50;

// How long to wait for a fill before cancelling the order
const FILL_TIMEOUT_MS = 5000;
const FILL_POLL_INTERVAL_MS = 1500;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wait for an order to fill, or cancel it if it doesn't fill in time.
 * Returns the final order state.
 */
async function waitForFillOrCancel(orderId: number): Promise<{
  filled: boolean;
  state: string;
  filledSize?: number;
  avgFillPrice?: number;
}> {
  const startTime = Date.now();

  while (Date.now() - startTime < FILL_TIMEOUT_MS) {
    await new Promise(resolve => setTimeout(resolve, FILL_POLL_INTERVAL_MS));

    const orderResult = await getOrderById(DELTA_API_KEY, DELTA_API_SECRET, orderId);
    if (!orderResult.success || !orderResult.result) continue;

    const order = orderResult.result;
    const state = String(order.state || '');

    // Fully filled
    if (state === 'closed' || state === 'filled') {
      return {
        filled: true,
        state,
        filledSize: Number(order.size || 0),
        avgFillPrice: Number(order.average_fill_price || order.limit_price || 0),
      };
    }

    // Cancelled or rejected externally
    if (state === 'cancelled' || state === 'rejected') {
      return { filled: false, state };
    }
  }

  // Timed out — cancel the order
  console.log(`[ARB] Order ${orderId} not filled within ${FILL_TIMEOUT_MS}ms, cancelling...`);
  const cancelResult = await cancelOrder(DELTA_API_KEY, DELTA_API_SECRET, orderId, BTCUSDT_PRODUCT_ID);

  if (cancelResult.success) {
    console.log(`[ARB] Order ${orderId} cancelled successfully`);
  } else {
    // If cancel fails, the order might have filled in the meantime — re-check
    const recheckResult = await getOrderById(DELTA_API_KEY, DELTA_API_SECRET, orderId);
    if (recheckResult.success && recheckResult.result) {
      const finalState = String(recheckResult.result.state || '');
      if (finalState === 'closed' || finalState === 'filled') {
        return {
          filled: true,
          state: finalState,
          filledSize: Number(recheckResult.result.size || 0),
          avgFillPrice: Number(recheckResult.result.average_fill_price || recheckResult.result.limit_price || 0),
        };
      }
    }
    console.warn(`[ARB] Failed to cancel order ${orderId}:`, cancelResult.error);
  }

  return { filled: false, state: 'cancelled_timeout' };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, size = 1, limitPrice, reason, spreadPct } = body;

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
      reason,
      spreadPct,
      status: 'PENDING'
    };

    if (!DELTA_API_KEY || !DELTA_API_SECRET) {
      return NextResponse.json({ error: 'Delta API credentials not configured' }, { status: 500 });
    }

    if (!limitPrice) {
      return NextResponse.json({ error: 'Limit price required for arbitrage execution' }, { status: 400 });
    }

    console.log(`[ARB REAL] Preparing order to Delta: ${side.toUpperCase()} ${size} contracts @ ${limitPrice}`);

    // 1. Set Leverage (ignore 'leverage_not_changed' errors)
    const levResult = await setDeltaLeverage(DELTA_API_KEY, DELTA_API_SECRET, BTCUSDT_PRODUCT_ID, LEVERAGE);
    if (!levResult.success && levResult.error?.code !== 'leverage_not_changed') {
      console.log('[ARB REAL] Failed to set leverage:', levResult.error);
    }

    // 2. Place Limit Order
    console.log(`[ARB REAL] Sending LIMIT order: ${side.toUpperCase()} ${size} @ ${limitPrice}`);

    const result = await placeDeltaOrder(
      DELTA_API_KEY,
      DELTA_API_SECRET,
      BTCUSDT_PRODUCT_ID,
      size,
      side,
      'limit',
      limitPrice.toString(),
      { reduceOnly: action === 'CLOSE_LONG' || action === 'CLOSE_SHORT' }
    );

    if (!result.success) {
      console.error('[ARB REAL] Order placement failed:', result.error);
      insertOneAsync('trades', { ...tradeRecord, status: 'FAILED', error: result.error });
      return NextResponse.json(result, { status: 400 });
    }

    const orderId = result.result?.id;
    if (!orderId) {
      console.error('[ARB REAL] No order ID in response');
      insertOneAsync('trades', { ...tradeRecord, status: 'FAILED', error: 'No order ID' });
      return NextResponse.json({ success: false, error: 'No order ID in response' }, { status: 500 });
    }

    // 3. Wait for fill or cancel if unfilled
    const fillResult = await waitForFillOrCancel(orderId);

    if (fillResult.filled) {
      console.log(`[ARB REAL] Order ${orderId} FILLED — ${side.toUpperCase()} ${fillResult.filledSize} @ ${fillResult.avgFillPrice}`);
      insertOneAsync('trades', {
        ...tradeRecord,
        status: 'FILLED',
        orderId,
        fillPrice: fillResult.avgFillPrice,
        fillSize: fillResult.filledSize,
        rawResult: result.result,
      });

      return NextResponse.json({
        success: true,
        filled: true,
        orderId,
        fillPrice: fillResult.avgFillPrice,
        fillSize: fillResult.filledSize,
        result: result.result,
      });
    } else {
      console.log(`[ARB REAL] Order ${orderId} NOT FILLED (${fillResult.state}), trade skipped`);
      insertOneAsync('trades', {
        ...tradeRecord,
        status: 'CANCELLED_UNFILLED',
        orderId,
        cancelReason: fillResult.state,
      });

      return NextResponse.json({
        success: false,
        filled: false,
        orderId,
        cancelReason: fillResult.state,
        error: { code: 'order_not_filled', context: `Order ${orderId} was not filled within ${FILL_TIMEOUT_MS}ms` },
      }, { status: 408 });
    }

  } catch (error: unknown) {
    console.error('Arbitrage execution error:', error);
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
