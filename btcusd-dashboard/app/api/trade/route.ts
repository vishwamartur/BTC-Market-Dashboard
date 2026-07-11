import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getDeltaPositions, placeDeltaOrder, setDeltaLeverage, getOrderById, cancelOrder } from '../../lib/delta';
import { insertOneAsync } from '../../lib/db';
import { normalizeDeltaPosition } from '../../lib/positions';
import { calculateBreakEven, DEFAULT_RISK_CONFIG } from '../../lib/riskManager';
import { getCurrentDayRisk } from '../../lib/dailyRiskService';
import { validateServerEntry, type EntryProtection } from '../../lib/serverTradeGuard';
import {
  acquireExecutionLease,
  recordEntryAccepted,
  releaseExecutionLease,
  reserveTradeRequest,
  completeTradeRequest,
  type ExecutionLease,
} from '../../lib/tradeExecutionState';
import { isTrustedTradingOrigin } from '../../lib/tradeAuth';
import { resilientFetch } from '../../lib/resilientFetch';

export const runtime = 'nodejs';

// Delta API Keys — MUST be set in .env.local, no hardcoded fallbacks
const DELTA_API_KEY = process.env.DELTA_API_KEY || '';
const DELTA_API_SECRET = process.env.DELTA_API_SECRET || '';
const LIVE_TRADING_ENABLED = process.env.LIVE_TRADING_ENABLED === 'true';

// Product ID 27 is BTCUSD linear perp on Delta Exchange India
const BTCUSDT_PRODUCT_ID = 27;
const DEFAULT_LEVERAGE = 10;
const MAX_LEVERAGE = 20;
const configuredLeverage = Number(process.env.TRADING_LEVERAGE || DEFAULT_LEVERAGE);
const LEVERAGE = Number.isFinite(configuredLeverage)
  ? Math.min(Math.max(1, Math.floor(configuredLeverage)), MAX_LEVERAGE)
  : DEFAULT_LEVERAGE;

// Server-side safety limits
const DEFAULT_TRADE_SIZE = 15;

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
  let executionLease: ExecutionLease | null = null;
  let reservedRequestId: string | null = null;
  try {
    const body = await request.json();
    const { action, reason, requestId } = body;
    const executionRequestId = typeof requestId === 'string' && requestId.length > 0
      ? requestId.slice(0, 24)
      : randomUUID().replaceAll('-', '').slice(0, 24);
    const clientOrderId = `signal-${executionRequestId}`.slice(0, 32);

    if (!['BUY', 'SELL', 'CLOSE_POSITION'].includes(action)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    if (!isTrustedTradingOrigin(request)) {
      return NextResponse.json({ error: 'Untrusted trading request origin' }, { status: 403 });
    }

    // Entries are explicitly opt-in at deployment time. This prevents a
    // dashboard with configured credentials from trading just because a user
    // toggled local browser state or an endpoint was exposed accidentally.
    if (action !== 'CLOSE_POSITION' && !LIVE_TRADING_ENABLED) {
      return NextResponse.json(
        { error: 'Live entries are disabled. Set LIVE_TRADING_ENABLED=true only after deployment hardening.' },
        { status: 403 },
      );
    }

    const isEntry = action !== 'CLOSE_POSITION';
    const leaseResult = await acquireExecutionLease(
      executionRequestId,
      isEntry,
      DEFAULT_RISK_CONFIG.cooldownMs,
    );
    if (!leaseResult.acquired) {
      const retryAfterSeconds = leaseResult.retryAfterMs
        ? Math.max(1, Math.ceil(leaseResult.retryAfterMs / 1000))
        : undefined;
      return NextResponse.json(
        {
          error: leaseResult.reason === 'cooldown'
            ? `Entry cooldown active. Retry after ${retryAfterSeconds}s.`
            : leaseResult.reason === 'busy'
              ? 'Another trade execution is already in progress.'
              : 'Durable trade lock is unavailable; entries are paused.',
        },
        { status: leaseResult.reason === 'persistence_unavailable' ? 503 : 409 },
      );
    }
    executionLease = leaseResult.lease;

    const finalizeTradeResponse = async (responseData: Record<string, unknown>, status: number) => {
      if (reservedRequestId) {
        await completeTradeRequest(reservedRequestId, responseData, status);
      }
      return cacheAndRespond(executionRequestId, responseData, status);
    };

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

    console.log(`[TRADE] ${action} reason=${reason || 'none'} requestId=${executionRequestId}`);

    // Live trading — verify credentials exist

    if (!DELTA_API_KEY || !DELTA_API_SECRET) {
      console.error('[REAL TRADE] Missing DELTA_API_KEY or DELTA_API_SECRET in env');
      return NextResponse.json({ error: 'Delta API credentials not configured' }, { status: 500 });
    }

    // This guard is deliberately server-side and fail-closed. The client may
    // display P&L, but only the authenticated Delta account may authorize a
    // new entry after checking the current-day realized result.
    let entryProtection: EntryProtection | null = null;
    let serverSize = DEFAULT_TRADE_SIZE;
    if (action !== 'CLOSE_POSITION') {
      const serverDecision = await validateServerEntry(action === 'BUY' ? 'BUY' : 'SELL');
      if (!serverDecision.allowed) {
        return NextResponse.json({ error: serverDecision.error }, { status: serverDecision.status });
      }
      serverSize = serverDecision.size;
      entryProtection = serverDecision.protection;

      const dailyRisk = await getCurrentDayRisk(DELTA_API_KEY, DELTA_API_SECRET);
      if (!dailyRisk.available) {
        return NextResponse.json(
          { error: dailyRisk.reason || 'Daily-loss guard unavailable; new entries are paused', dailyRisk },
          { status: 503 },
        );
      }
      if (dailyRisk.lossLimitReached) {
        return NextResponse.json(
          { error: 'Daily-loss limit reached; new entries are locked until the next trading day', dailyRisk },
          { status: 403 },
        );
      }
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

      const reservation = await reserveTradeRequest(executionRequestId, action);
      if (reservation.state === 'replay') return NextResponse.json(reservation.response, { status: reservation.statusCode });
      if (reservation.state === 'pending') return NextResponse.json({ error: 'This trade request is already executing.' }, { status: 409 });
      if (reservation.state === 'unavailable') return NextResponse.json({ error: 'Durable idempotency is unavailable; execution is paused.' }, { status: 503 });
      reservedRequestId = executionRequestId;

      const result = await placeDeltaOrder(
        DELTA_API_KEY,
        DELTA_API_SECRET,
        BTCUSDT_PRODUCT_ID,
        closeSize,
        closeSide,
        'market',
        undefined,
        { reduceOnly: true, clientOrderId }
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

        return finalizeTradeResponse({
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

      return finalizeTradeResponse(result as unknown as Record<string, unknown>, 400);
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

    // Entry size is calculated from durable server signal/risk state; clients
    // cannot choose a larger manual size through this endpoint.
    const size = serverSize;
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
      const tickerRes = await resilientFetch(`${baseUrl}/v2/tickers/BTCUSD`, {
        retries: 1,
        timeoutMs: 8000,
      });
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
    const reservation = await reserveTradeRequest(executionRequestId, action);
    if (reservation.state === 'replay') return NextResponse.json(reservation.response, { status: reservation.statusCode });
    if (reservation.state === 'pending') return NextResponse.json({ error: 'This trade request is already executing.' }, { status: 409 });
    if (reservation.state === 'unavailable') return NextResponse.json({ error: 'Durable idempotency is unavailable; execution is paused.' }, { status: 503 });
    reservedRequestId = executionRequestId;
    const result = await placeDeltaOrder(
      DELTA_API_KEY,
      DELTA_API_SECRET,
      BTCUSDT_PRODUCT_ID,
      size,
      side,
      'limit',
      limitPrice,
      {
        clientOrderId,
        bracket: entryProtection ? {
          stopLossPrice: entryProtection.stopLossPrice,
          takeProfitPrice: entryProtection.takeProfitPrice,
          triggerMethod: 'mark_price',
        } : undefined,
      }
    );

    // Calculate fee estimates for cost tracking
    const entryPrice = parseFloat(limitPrice);
    const breakEvenData = calculateBreakEven(size, entryPrice, DEFAULT_RISK_CONFIG, true);

    if (result.success) {
      await recordEntryAccepted(executionLease);
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

          return finalizeTradeResponse({
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
        protection: entryProtection,
      });

      return finalizeTradeResponse(result as unknown as Record<string, unknown>, 200);
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

      return finalizeTradeResponse(result as unknown as Record<string, unknown>, 400);
    }

  } catch (error: unknown) {
    console.error('Trade execution error:', error);
    const response = { error: getErrorMessage(error) };
    if (reservedRequestId) {
      try {
        await completeTradeRequest(reservedRequestId, response, 500);
      } catch (completionError) {
        console.error('[TRADE] Failed to persist failed request:', completionError);
      }
    }
    return NextResponse.json(response, { status: 500 });
  } finally {
    if (executionLease) {
      try {
        await releaseExecutionLease(executionLease);
      } catch (error) {
        console.error('[TRADE] Failed to release durable execution lease:', error);
      }
    }
  }
}
