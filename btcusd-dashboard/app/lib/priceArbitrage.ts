export interface ArbitrageConfig {
  entryThresholdPct: number;  // Enter when Delta deviates by this much % (default: 0.08% to clear fees)
  exitThresholdPct: number;   // Exit when spread drops below this % (default: 0.02%)
  stopLossPct: number;        // Stop loss if spread widens to this % (default: 0.20%)
  maxHoldTimeMs: number;      // Max time to hold an arb trade (default: 60000ms / 60s)
  maxDailyTrades: number;     // Cap daily trades (default: 50)
  tradeSize: number;          // Size in contracts (default: 1)
}

export const DEFAULT_ARB_CONFIG: ArbitrageConfig = {
  entryThresholdPct: 0.08,
  exitThresholdPct: 0.02,
  stopLossPct: 0.20,
  maxHoldTimeMs: 60000, 
  maxDailyTrades: 50,
  tradeSize: 1
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
 * Returns the action to take and the current spread.
 */
export function shouldEnterTrade(
  refPrice: number, 
  deltaPrice: number, 
  config: ArbitrageConfig = DEFAULT_ARB_CONFIG
): { action: ArbAction, spread: number } {
  const spread = calculateSpread(refPrice, deltaPrice);
  const absSpread = Math.abs(spread);

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
