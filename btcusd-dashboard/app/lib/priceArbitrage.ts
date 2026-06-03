export interface ArbitrageConfig {
  entryThresholdPct: number;  // Enter when Delta deviates by this much % (must exceed roundTripFeePct)
  exitThresholdPct: number;   // Exit when spread drops below this % (default: 0.03%)
  stopLossPct: number;        // Stop loss if spread widens to this % (default: 0.30%)
  maxHoldTimeMs: number;      // Max time to hold an arb trade (default: 180000ms / 3min)
  maxDailyTrades: number;     // Cap daily trades (default: 30)
  tradeSize: number;          // Size in contracts (default: 15)
  takerFeePct: number;        // Taker fee per side (default: 0.05%)
  roundTripFeePct: number;    // Total round-trip fee cost (default: 0.10%)
}

export const DEFAULT_ARB_CONFIG: ArbitrageConfig = {
  entryThresholdPct: 0.18,    // Must be > roundTripFeePct (0.10%) to be profitable
  exitThresholdPct: 0.03,     // Exit when spread converges to near zero
  stopLossPct: 0.30,          // Wider stop to avoid premature exits
  maxHoldTimeMs: 180000,      // 3 minutes — give spread time to converge
  maxDailyTrades: 30,
  tradeSize: 15,
  takerFeePct: 0.05,          // 0.05% per side on Delta Exchange
  roundTripFeePct: 0.10,      // 0.05% × 2 sides
};

export type ArbAction = 'BUY_DELTA' | 'SELL_DELTA' | 'NONE';

/**
 * Calculates the percentage spread between Delta and a reference price (Binance).
 * Positive spread means Delta is higher than reference.
 * Negative spread means Delta is lower than reference.
 */
export function calculateSpread(refPrice: number, deltaPrice: number): number {
  if (!refPrice || !deltaPrice) return 0;
  return ((deltaPrice - refPrice) / refPrice) * 100;
}

/**
 * Determines if a new arbitrage trade should be entered.
 * Includes a fee-aware guard: rejects entries where expected profit < fees.
 * Also rejects wildly divergent prices (>5%) as likely data errors.
 */
export function shouldEnterTrade(
  refPrice: number, 
  deltaPrice: number, 
  config: ArbitrageConfig = DEFAULT_ARB_CONFIG
): { action: ArbAction, spread: number, reason?: string } {
  const spread = calculateSpread(refPrice, deltaPrice);
  const absSpread = Math.abs(spread);

  // Sanity check: if spread is >5%, something is wrong (possible USD/INR mismatch or stale data)
  if (absSpread > 5.0) {
    console.warn(`[ARB] Rejecting entry — spread ${spread.toFixed(3)}% is unreasonably large. Possible data error.`);
    return { action: 'NONE', spread, reason: 'SPREAD_TOO_LARGE' };
  }

  // Fee-aware guard: entry spread must exceed round-trip fees to be profitable
  if (absSpread < config.roundTripFeePct) {
    return { action: 'NONE', spread, reason: 'BELOW_FEE_THRESHOLD' };
  }

  if (absSpread >= config.entryThresholdPct) {
    if (spread < 0) {
      // Delta is cheaper -> BUY Delta
      return { action: 'BUY_DELTA', spread };
    } else {
      // Delta is more expensive -> SELL Delta
      return { action: 'SELL_DELTA', spread };
    }
  }

  return { action: 'NONE', spread };
}

/**
 * Determines if an existing arbitrage trade should be exited.
 * Evaluates convergence, stop-loss, and timeout conditions.
 */
export function shouldExitTrade(
  currentRefPrice: number,
  currentDeltaPrice: number,
  entrySide: 'BUY_DELTA' | 'SELL_DELTA',
  entryTime: number,
  config: ArbitrageConfig = DEFAULT_ARB_CONFIG
): { shouldExit: boolean, reason: 'CONVERGENCE' | 'STOP_LOSS' | 'TIMEOUT' | 'NONE' } {
  
  const currentSpread = calculateSpread(currentRefPrice, currentDeltaPrice);
  const elapsedMs = Date.now() - entryTime;

  // 1. Check Timeout
  if (elapsedMs >= config.maxHoldTimeMs) {
    return { shouldExit: true, reason: 'TIMEOUT' };
  }

  // 2. Check Convergence (Take Profit)
  // If we bought Delta, we want the spread (Delta - Ref) to increase (become less negative/cross zero).
  // If we sold Delta, we want the spread to decrease (become less positive/cross zero).
  
  // We use absolute spread for convergence if it has crossed 0, or is very close to 0
  if (Math.abs(currentSpread) <= config.exitThresholdPct) {
      return { shouldExit: true, reason: 'CONVERGENCE' };
  }
  
  // Also exit if the spread has flipped in our favor past 0
  if (entrySide === 'BUY_DELTA' && currentSpread > config.exitThresholdPct) {
       return { shouldExit: true, reason: 'CONVERGENCE' };
  }
  if (entrySide === 'SELL_DELTA' && currentSpread < -config.exitThresholdPct) {
      return { shouldExit: true, reason: 'CONVERGENCE' };
  }

  // 3. Check Stop Loss (Spread widening against us)
  if (entrySide === 'BUY_DELTA' && currentSpread <= -config.stopLossPct) {
     return { shouldExit: true, reason: 'STOP_LOSS' };
  }
  
  if (entrySide === 'SELL_DELTA' && currentSpread >= config.stopLossPct) {
      return { shouldExit: true, reason: 'STOP_LOSS' };
  }

  return { shouldExit: false, reason: 'NONE' };
}
