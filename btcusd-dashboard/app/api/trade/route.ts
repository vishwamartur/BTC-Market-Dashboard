import { NextResponse } from 'next/server';
import { getDeltaPositions, placeDeltaOrder, setDeltaLeverage, getOrderById, cancelOrder } from '../../lib/delta';
import { insertOneAsync } from '../../lib/db';
import { normalizeDeltaPosition } from '../../lib/positions';
import { calculateBreakEven, DEFAULT_RISK_CONFIG } from '../../lib/riskManager';

export const runtime = 'nodejs';

// Delta API Keys — MUST be set in .env.local, no hardcoded fallbacks
const DELTA_API_KEY = process.env.DELTA_API_KEY || '';
const DELTA_API_SECRET = process.env.DELTA_API_SECRET || '';

// Product ID 27 is BTCUSD linear perp on Delta Exchange India
const BTCUSDT_PRODUCT_ID = 27;
const LEVERAGE = 50;

// Server-side safety limits
const DEFAULT_TRADE_SIZE = 15;
const MAX_TRADE_SIZE = 50; // Hard cap regardless of client request

// Maker order offset — place limit orders this many USD inside the spread
// to maximize maker fill chance (0.02% fee vs 0.05% taker)
const MAKER_OFFSET_USD = 0.5;

// Order fill monitoring — wait up to 30s for limit order to fill
const FILL_CHECK_INTERVAL_MS = 3000;
const FILL_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// Rate limiter (1 trade per 5 seconds)
// ---------------------------------------------------------------------------

const RATE_LIMIT_MS = 5000;
let lastTradeTimestamp = 0;

// ---------------------------------------------------------------------------
// Idempotency cache (60-second window)
// ---------------------------------------------------------------------------

const IDEMPOTENCY_TTL_MS = 60_000;
const idempotencyCache = new Map<string, { response: unknown; status: number; expiresAt: number }>();

function cleanIdempotencyCache() {
  const now = Date.now();
  for (const [key, entry] of idempotencyCache) {
    if (now > entry.expiresAt) idempotencyCache.delete(key);
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cacheAndRespond(requestId: string | undefined, responseData: unknown, status: number) {
  if (requestId && typeof requestId === 'string') {
    idempotencyCache.set(requestId, {
      response: responseData,
      status,
      expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
    });
  }
  return NextResponse.json(responseData, { status });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, size: rawSize = DEFAULT_TRADE_SIZE, reason, requestId } = body;

    if (!['BUY', 'SELL', 'CLOSE_POSITION'].includes(action)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    // Idempotency check
    if (requestId && typeof requestId === 'string') {
      cleanIdempotencyCache();
      const cached = idempotencyCache.get(requestId);
      if (cached) {
        console.log(`[TRADE] Idempotent replay for requestId=${requestId}`);
        return NextResponse.json(cached.response, { status: cached.status });
      }
    }

    // Rate limit check
    const now = Date.now();
    if (now - lastTradeTimestamp < RATE_LIMIT_MS) {
      const retryAfterMs = RATE_LIMIT_MS - (now - lastTradeTimestamp);
      return NextResponse.json(
        { error: `Rate limited. Retry after ${Math.ceil(retryAfterMs / 1000)}s.` },
        { status: 429 }
      );
    }
    lastTradeTimestamp = now;

    console.log(`[TRADE] ${action} size=${rawSize} reason=${reason || 'none'} requestId=${requestId || 'none'}`);

    // Live trading — verify credentials exist

    if (!DELTA_API_KEY || !DELTA_API_SECRET) {
      console.error('[REAL TRADE] Missing DELTA_API_KEY or DELTA_API_SECRET in env');
      return NextResponse.json({ error: 'Delta API credentials not configured' }, { status: 500 });
    }

    const positionsResult = await getDeltaPositions(DELTA_API_KEY, DELTA_API_SECRET, BTCUSDT_PRODUCT_ID);
    if (!positionsResult.success) {
      return NextResponse.json({ error: positionsResult.error || 'Failed to fetch open position' }, { status: 502 });
    }

    const activePosition = normalizeDeltaPosition(positionsResult.result, BTCUSDT_PRODUCT_ID);

    if (action === 'CLOSE_POSITION') {
      if (!activePosition) {
        return NextResponse.json({
          success: true,
          closed: false,
          message: 'No open BTC position to close',
          position: null,
        });
      }

      const closeSide = activePosition.side === 'LONG' ? 'sell' : 'buy';
      const closeAction = activePosition.side === 'LONG' ? 'CLOSE_LONG' : 'CLOSE_SHORT';
      const closeSize = Math.max(1, Math.ceil(activePosition.size));

      console.log(`[REAL TRADE] Closing ${activePosition.side} position with reduce-only ${closeSide.toUpperCase()} ${closeSize}`);

      const result = await placeDeltaOrder(
        DELTA_API_KEY,
        DELTA_API_SECRET,
        BTCUSDT_PRODUCT_ID,
        closeSize,
        closeSide,
        'market',
        undefined,
        { reduceOnly: true }
      );

      if (result.success) {
        insertOneAsync('trades', {
          timestamp: new Date(),
          action: closeAction,
          side: closeSide,
          size: closeSize,
          status: 'SUCCESS',
          orderId: result.result?.id,
          productId: BTCUSDT_PRODUCT_ID,
          reason: reason || 'Position close',
          reduceOnly: true,
          closedPosition: activePosition,
          rawResult: result.result,
        });

        return cacheAndRespond(requestId, {
          ...result,
          closed: true,
          position: activePosition,
        }, 200);
      }

      insertOneAsync('trades', {
        timestamp: new Date(),
        action: closeAction,
        side: closeSide,
        size: closeSize,
        status: 'FAILED',
        error: result.error,
        productId: BTCUSDT_PRODUCT_ID,
        reason: reason || 'Position close',
        reduceOnly: true,
        closedPosition: activePosition,
      });

      return cacheAndRespond(requestId, result, 400);
    }

    if (activePosition) {
      return NextResponse.json(
        {
          error: `Open ${activePosition.side} position already exists. Close it before opening a new trade.`,
          position: activePosition,
        },
        { status: 409 }
      );
    }

    // Server-side size validation
    const size = Math.min(Math.max(1, Math.floor(Number(rawSize) || 1)), MAX_TRADE_SIZE);
    const side = action === 'BUY' ? 'buy' : 'sell';

    console.log(`[REAL TRADE] Preparing order to Delta: ${side.toUpperCase()} ${size} contracts`);

    // 1. Set Leverage
    const levResult = await setDeltaLeverage(DELTA_API_KEY, DELTA_API_SECRET, BTCUSDT_PRODUCT_ID, LEVERAGE);
    const levError = levResult.error as Record<string, unknown> | undefined;
    if (!levResult.success && levError?.code !== 'leverage_not_changed') {
      console.log('[REAL TRADE] Failed to set leverage:', levResult.error);
      // We log it but don't strictly fail the trade if leverage couldn't be adjusted 
      // (sometimes it throws leverage_not_changed which is fine)
    }

    // 2. Fetch Ticker for Best Price — use maker offset for better fees
    let limitPrice: string | undefined;
    try {
      const baseUrl = process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange';
      const tickerRes = await fetch(`${baseUrl}/v2/tickers/BTCUSD`);
      const tickerData = await tickerRes.json();
      if (tickerData.success) {
        // Maker strategy: offset price to get maker fill (0.02% fee instead of 0.05%)
        // Buy: place slightly below best_bid (we're offering to buy cheaper)
        // Sell: place slightly above best_ask (we're offering to sell higher)
        const bestBid = parseFloat(tickerData.result.quotes.best_bid);
        const bestAsk = parseFloat(tickerData.result.quotes.best_ask);
        
        if (side === 'buy') {
          const makerPrice = bestBid - MAKER_OFFSET_USD;
          limitPrice = makerPrice.toFixed(2);
        } else {
          const makerPrice = bestAsk + MAKER_OFFSET_USD;
          limitPrice = makerPrice.toFixed(2);
        }
        console.log(`[REAL TRADE] Maker limit price: ${limitPrice} (bid: ${bestBid}, ask: ${bestAsk}, offset: ±$${MAKER_OFFSET_USD})`);
      }
    } catch (e) {
      console.error('[REAL TRADE] Error fetching ticker:', e);
      return NextResponse.json({ error: 'Failed to fetch limit price' }, { status: 500 });
    }

    if (!limitPrice) {
      return NextResponse.json({ error: 'Could not determine limit price' }, { status: 500 });
    }

    // 3. Execute Limit Order (maker strategy)
    console.log(`[REAL TRADE] Sending MAKER LIMIT order to Delta: ${side.toUpperCase()} ${size} contracts at ${limitPrice}`);
    const result = await placeDeltaOrder(
      DELTA_API_KEY,
      DELTA_API_SECRET,
      BTCUSDT_PRODUCT_ID,
      size,
      side,
      'limit',
      limitPrice
    );

    // Calculate fee estimates for cost tracking
    const entryPrice = parseFloat(limitPrice);
    const breakEvenData = calculateBreakEven(size, entryPrice, DEFAULT_RISK_CONFIG, true);

    if (result.success) {
      const orderId = result.result?.id;
      console.log('[REAL TRADE] Order placed:', orderId);

      // Monitor order fill with timeout
      let filled = false;
      if (orderId) {
        const startTime = Date.now();
        while (Date.now() - startTime < FILL_TIMEOUT_MS) {
          await new Promise(resolve => setTimeout(resolve, FILL_CHECK_INTERVAL_MS));
          try {
            const orderCheck = await getOrderById(DELTA_API_KEY, DELTA_API_SECRET, orderId);
            const orderResult = orderCheck.result as Record<string, unknown> | undefined;
            const state = orderResult?.state as string;
            if (state === 'closed' || state === 'filled') {
              filled = true;
              console.log(`[REAL TRADE] Order ${orderId} filled!`);
              break;
            } else if (state === 'cancelled') {
              console.log(`[REAL TRADE] Order ${orderId} was cancelled externally`);
              break;
            }
          } catch (checkErr) {
            console.warn('[REAL TRADE] Error checking order status:', checkErr);
          }
        }

        // If not filled after timeout, cancel and log
        if (!filled) {
          console.log(`[REAL TRADE] Order ${orderId} not filled after ${FILL_TIMEOUT_MS / 1000}s. Cancelling...`);
          try {
            await cancelOrder(DELTA_API_KEY, DELTA_API_SECRET, orderId, BTCUSDT_PRODUCT_ID);
            console.log(`[REAL TRADE] Order ${orderId} cancelled.`);
          } catch (cancelErr) {
            console.warn('[REAL TRADE] Error cancelling order:', cancelErr);
          }

          insertOneAsync('trades', {
            timestamp: new Date(),
            action: action as string,
            side,
            size,
            status: 'CANCELLED_TIMEOUT',
            orderId,
            productId: BTCUSDT_PRODUCT_ID,
            reason: `Not filled within ${FILL_TIMEOUT_MS / 1000}s`,
            estimatedFeeUsd: breakEvenData.feeUsd,
            estimatedGstUsd: breakEvenData.gstUsd,
            breakEvenMovePct: breakEvenData.breakEvenMovePct,
          });

          return cacheAndRespond(requestId, {
            success: false,
            error: 'Order not filled within timeout, cancelled',
            orderId,
          }, 408);
        }
      }

      // Persist successful trade with fee tracking to MongoDB
      insertOneAsync('trades', {
        timestamp: new Date(),
        action: action as string,
        side,
        size,
        status: 'SUCCESS',
        orderId: result.result?.id,
        productId: BTCUSDT_PRODUCT_ID,
        rawResult: result.result,
        // Fee tracking fields
        estimatedFeeUsd: breakEvenData.feeUsd,
        estimatedGstUsd: breakEvenData.gstUsd,
        roundTripCostUsd: breakEvenData.roundTripCostUsd,
        breakEvenMovePct: breakEvenData.breakEvenMovePct,
        notionalUsd: breakEvenData.notionalUsd,
        limitPrice: entryPrice,
        feeType: 'maker',
      });

      return cacheAndRespond(requestId, result, 200);
    } else {
      console.error('[REAL TRADE] Failed:', result.error);

      // Persist failed trade to MongoDB with fee estimates
      insertOneAsync('trades', {
        timestamp: new Date(),
        action: action as string,
        side,
        size,
        status: 'FAILED',
        error: result.error,
        productId: BTCUSDT_PRODUCT_ID,
        estimatedFeeUsd: breakEvenData.feeUsd,
        estimatedGstUsd: breakEvenData.gstUsd,
        breakEvenMovePct: breakEvenData.breakEvenMovePct,
      });

      return cacheAndRespond(requestId, result, 400);
    }

  } catch (error: unknown) {
    console.error('Trade execution error:', error);
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
