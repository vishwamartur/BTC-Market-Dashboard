/**
 * Options Manager — pure operations for BTC options on Delta Exchange.
 *
 * This module provides functions for:
 *  - Finding ATM options for straddle construction
 *  - Executing short straddle entries
 *  - Closing all open option positions
 *  - Evaluating hedge profit-taking conditions
 *
 * IMPORTANT: This module is STATELESS. All state lives in BotState
 * (see state.ts). Functions accept state as parameters and return
 * metadata for the caller to update state.
 */

import { getProducts, getTickers, placeLimitOrderWithRetry, getAllPositions } from './delta.js';
import { logger } from './logger.js';
import type { Config } from './config/index.js';
import type { BotState } from './state.js';
import type { HedgeProfitAction, NormalizedPosition } from './types.js';

// ---------------------------------------------------------------------------
// Hedge Profit-Taking Configuration
// ---------------------------------------------------------------------------

const HEDGE_PROFIT_CONFIG = {
  /** Close if unrealized profit >= this fraction of entry premium collected */
  PROFIT_TARGET_PCT: 0.60,
  /** Close if profit drops this fraction from its high-water mark */
  TRAILING_DRAWDOWN_PCT: 0.30,
  /** Close if this fraction of time-to-expiry has elapsed AND profit > 0 */
  TIME_DECAY_THRESHOLD: 0.75,
  /** Minimum absolute profit ($) to trigger any exit — avoids closing on noise */
  MIN_PROFIT_USD: 0.50,
};

/**
 * Delta-bleed exit configuration.
 *
 * The short straddle is delta-neutral at entry but becomes increasingly
 * directional as spot moves away from the strike. If BTCUSD drifts more
 * than `ATR_MULTIPLIER` × ATR away from the strike and we haven't already
 * banked 30%+ of premium, close the hedge to prevent further bleed.
 */
const DELTA_BLEED_EXIT = {
  /** Close if |spot − strike| >= this multiple of entry ATR */
  ATR_MULTIPLIER: 2.0,
  /** Don't trigger delta-bleed exit within this many ms of entry */
  MIN_TIME_MS: 5 * 60 * 1000,
  /** Skip delta-bleed exit if profit already exceeds this fraction of premium
   *  (let profit-taking handle it instead) */
  PROFIT_CAP_PCT: 0.30,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OptionProduct {
  id: number;
  symbol: string;
  contract_type: 'call_options' | 'put_options';
  strike_price: string;
  settlement_time: string;
  underlying_asset: { symbol: string };
  state: string;
}

interface StraddleResult {
  success: boolean;
  dryRun?: boolean;
  callRes?: any;
  putRes?: any;
  callProduct?: OptionProduct;
  putProduct?: OptionProduct;
  /** Estimated premium collected (for state tracking) */
  entryNotional?: number;
  /** Expiry timestamp (for state tracking) */
  expiryTime?: number;
}

// ---------------------------------------------------------------------------
// ATM Straddle Finder
// ---------------------------------------------------------------------------

export async function findAtTheMoneyStraddle(config: Config, currentPrice: number) {
  const productsRes = await getProducts(config.DELTA_API_KEY, config.DELTA_API_SECRET);
  if (!productsRes.success || !Array.isArray(productsRes.result)) {
    throw new Error('Failed to fetch Delta products for options hedging');
  }

  const allProducts = productsRes.result as any[];
  const btcOptions = allProducts.filter(p => 
    (p.contract_type === 'call_options' || p.contract_type === 'put_options') &&
    p.underlying_asset?.symbol === 'BTC' &&
    p.state === 'live'
  ) as OptionProduct[];

  if (btcOptions.length === 0) {
    throw new Error('No live BTC options found');
  }

  // Group by expiration (settlement_time)
  const expiries = [...new Set(btcOptions.map(o => o.settlement_time))].sort();
  // Get the closest expiration (Daily)
  const closestExpiry = expiries[0];
  
  const optionsForExpiry = btcOptions.filter(o => o.settlement_time === closestExpiry);
  
  // Find the strike closest to current price
  let closestStrike = 0;
  let minDiff = Infinity;
  
  const strikes = [...new Set(optionsForExpiry.map(o => Number(o.strike_price)))];
  for (const strike of strikes) {
    const diff = Math.abs(strike - currentPrice);
    if (diff < minDiff) {
      minDiff = diff;
      closestStrike = strike;
    }
  }

  const atmCall = optionsForExpiry.find(o => o.contract_type === 'call_options' && Number(o.strike_price) === closestStrike);
  const atmPut = optionsForExpiry.find(o => o.contract_type === 'put_options' && Number(o.strike_price) === closestStrike);

  if (!atmCall || !atmPut) {
    throw new Error(`Failed to find both Call and Put for ATM strike ${closestStrike}`);
  }

  return { call: atmCall, put: atmPut };
}

// ---------------------------------------------------------------------------
// Dynamic Size Calculator (Greek-based)
// ---------------------------------------------------------------------------

function calculateDynamicSize(dailyPnl: number, callTicker: any, putTicker: any): number {
  // Base Capital Scaling
  const baseSize = 20 + (dailyPnl > 0 ? dailyPnl * 2 : 0);
  
  // Extract Greeks
  const callGreeks = callTicker?.greeks || {};
  const putGreeks = putTicker?.greeks || {};
  
  const totalTheta = Math.abs(Number(callGreeks.theta) || 0) + Math.abs(Number(putGreeks.theta) || 0);
  const totalVega = Math.abs(Number(callGreeks.vega) || 0) + Math.abs(Number(putGreeks.vega) || 0);
  const totalGamma = Math.abs(Number(callGreeks.gamma) || 0) + Math.abs(Number(putGreeks.gamma) || 0);
  
  // Prevent division by zero
  if (totalVega === 0 && totalGamma === 0) return Math.round(baseSize);

  // Math formula from Implementation Plan:
  // Multiplier = |Total Theta| / ((Total Vega * 1) + (Total Gamma * 100000))
  // Weightings adjusted for typical crypto options greeks magnitudes
  const denominator = (totalVega * 1) + (totalGamma * 10000);
  const multiplier = denominator > 0 ? (totalTheta / denominator) : 1;
  
  // Cap the multiplier to prevent extreme sizes
  const cappedMultiplier = Math.max(0.1, Math.min(multiplier, 5));
  
  let finalSize = Math.round(baseSize * cappedMultiplier);
  
  // Risk Caps
  finalSize = Math.max(10, Math.min(finalSize, 200));
  
  return finalSize;
}

// ---------------------------------------------------------------------------
// Execute Short Straddle
// ---------------------------------------------------------------------------

export async function executeShortStraddle(
  config: Config,
  currentPrice: number,
  dailyPnl: number = 0,
  overrideSize?: number,
): Promise<StraddleResult> {
  logger.info({ price: currentPrice }, 'Setting up Delta-Neutral Short Straddle');
  
  const straddle = await findAtTheMoneyStraddle(config, currentPrice);
  logger.info({ call: straddle.call.symbol, put: straddle.put.symbol, strike: straddle.call.strike_price }, 'Found ATM options');

  // Fetch Greeks
  const [callTickerRes, putTickerRes] = await Promise.all([
    getTickers(config.DELTA_API_KEY, config.DELTA_API_SECRET, straddle.call.symbol),
    getTickers(config.DELTA_API_KEY, config.DELTA_API_SECRET, straddle.put.symbol)
  ]);

  const callTicker = callTickerRes.success && Array.isArray(callTickerRes.result) ? callTickerRes.result[0] : null;
  const putTicker = putTickerRes.success && Array.isArray(putTickerRes.result) ? putTickerRes.result[0] : null;

  // Use balance-based override if provided, otherwise fall back to Greek-based calculation
  const greekSize = calculateDynamicSize(dailyPnl, callTicker, putTicker);
  const dynamicSize = overrideSize ? Math.min(overrideSize, greekSize * 3) : greekSize;
  logger.info({ dailyPnl, greekSize, overrideSize, finalSize: dynamicSize, callTheta: callTicker?.greeks?.theta, putTheta: putTicker?.greeks?.theta }, 'Calculated dynamic position size');

  // Estimate premium collected (mark price × size for both legs)
  const callMark = Number(callTicker?.mark_price || 0);
  const putMark = Number(putTicker?.mark_price || 0);
  const estimatedPremium = (callMark + putMark) * dynamicSize;
  const expiryTime = new Date(straddle.call.settlement_time).getTime();

  if (config.DRY_RUN) {
    logger.info({ action: 'SELL', size: dynamicSize, estimatedPremium: estimatedPremium.toFixed(2) }, '[DRY RUN] Would SELL ATM Call and SELL ATM Put to collect premium.');
    return { success: true, dryRun: true, entryNotional: estimatedPremium, expiryTime, callProduct: straddle.call, putProduct: straddle.put };
  }

  // Sell Call via LIMIT order
  const callRes = await placeLimitOrderWithRetry(
    config.DELTA_API_KEY,
    config.DELTA_API_SECRET,
    straddle.call.id,
    dynamicSize,
    'sell',
    straddle.call.symbol,
  );

  // Sell Put via LIMIT order
  const putRes = await placeLimitOrderWithRetry(
    config.DELTA_API_KEY,
    config.DELTA_API_SECRET,
    straddle.put.id,
    dynamicSize,
    'sell',
    straddle.put.symbol,
  );

  if (!callRes.success || !putRes.success) {
    logger.error({ callRes, putRes }, 'Failed to execute Short Straddle');
    return { success: false, callRes, putRes };
  }

  logger.info('Successfully opened Delta-Neutral Short Straddle');
  return {
    success: true,
    callRes,
    putRes,
    callProduct: straddle.call,
    putProduct: straddle.put,
    entryNotional: estimatedPremium,
    expiryTime,
  };
}

// ---------------------------------------------------------------------------
// Close Options Hedge
// ---------------------------------------------------------------------------

/**
 * Closes all open BTC option positions by placing reduce-only LIMIT orders.
 * NOTE: Does NOT reset BotState — the caller is responsible for calling
 * resetHedgeState() after this returns.
 */
export async function closeOptionsHedge(config: Config): Promise<boolean> {
  logger.info('Closing all open BTC option positions...');

  const posRes = await getAllPositions(config.DELTA_API_KEY, config.DELTA_API_SECRET);
  if (!posRes.success || !Array.isArray(posRes.result)) {
    logger.error({ error: posRes.error }, 'Failed to fetch positions for hedge closure');
    return false;
  }

  const optionPositions = (posRes.result as any[]).filter(
    (p: any) => {
      const sym = (p.product_symbol || p.symbol || '') as string;
      return (sym.startsWith('C-') || sym.startsWith('P-')) && p.size !== 0;
    }
  );

  if (optionPositions.length === 0) {
    logger.info('No open option positions to close.');
    return true;
  }

  let allClosed = true;
  for (const pos of optionPositions) {
    const closeSide = pos.size > 0 ? 'sell' : 'buy';
    const closeSize = Math.abs(pos.size);
    logger.info({ symbol: pos.product_symbol || pos.product_id, side: closeSide, size: closeSize }, 'Closing option position');

    if (config.DRY_RUN) {
      logger.info('[DRY RUN] Would close option position');
      continue;
    }

    const sym = (pos.product_symbol || pos.symbol || '') as string;
    const res = await placeLimitOrderWithRetry(
      config.DELTA_API_KEY,
      config.DELTA_API_SECRET,
      pos.product_id,
      closeSize,
      closeSide,
      sym,
      { reduceOnly: true },
    );
    if (!res.success) {
      logger.error({ productId: pos.product_id, error: res.error }, 'Failed to close option position');
      allClosed = false;
    } else {
      logger.info({ productId: pos.product_id }, 'Option position closed successfully');
    }
  }

  return allClosed;
}

// ---------------------------------------------------------------------------
// Hedge Profit-Taking Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate whether the current hedge positions should be closed to book profits.
 * Called every tick from the orchestrator when isHedged === true.
 *
 * STATELESS: reads state from BotState, updates hedgePeakProfit via mutation.
 * All other state updates are the caller's responsibility.
 *
 * Uses four exit conditions:
 *  1. FIXED TARGET — unrealized profit >= 60% of premium collected
 *  2. TRAILING PEAK — profit dropped 30% from its high-water mark
 *  3. TIME-BASED DECAY — >75% of time-to-expiry elapsed and profit > 0
 *  4. DELTA-BLEED — spot moved > 2× ATR from strike and profit < 30% of premium
 */
export function evaluateHedgeProfitTaking(
  state: BotState,
  optionPositions: NormalizedPosition[],
  currentPrice: number,
): HedgeProfitAction {
  const noAction: HedgeProfitAction = { shouldClose: false, reason: '', currentProfit: 0, peakProfit: state.hedgePeakProfit };

  if (optionPositions.length === 0) {
    return noAction;
  }

  // Sum unrealized P&L across all option positions
  const totalUnrealizedPnl = optionPositions.reduce((sum, p) => sum + p.unrealizedPnl, 0);

  // Update high-water mark (direct state mutation — this is the ONE exception)
  if (totalUnrealizedPnl > state.hedgePeakProfit) {
    state.hedgePeakProfit = totalUnrealizedPnl;
  }

  logger.info({
    currentProfit: totalUnrealizedPnl.toFixed(4),
    peakProfit: state.hedgePeakProfit.toFixed(4),
    entryNotional: state.hedgeEntryNotional.toFixed(4),
    timeElapsedPct: state.hedgeExpiryTime > 0 && state.hedgeEntryTime > 0
      ? (((Date.now() - state.hedgeEntryTime) / (state.hedgeExpiryTime - state.hedgeEntryTime)) * 100).toFixed(1) + '%'
      : 'N/A',
  }, 'Hedge profit-taking tick');

  // --- Condition 4: Delta-Bleed Exit (run BEFORE the noisy-profit guard so
  //     it can still trigger even when P&L is small/negative, which is its
  //     primary purpose) ---
  if (
    state.hedgeStrikePrice > 0 &&
    state.hedgeEntryAtr > 0 &&
    currentPrice > 0 &&
    Date.now() - state.hedgeEntryTime >= DELTA_BLEED_EXIT.MIN_TIME_MS
  ) {
    const priceDistanceAtr = Math.abs(currentPrice - state.hedgeStrikePrice) / state.hedgeEntryAtr;
    const profitPct = state.hedgeEntryNotional > 0 ? totalUnrealizedPnl / state.hedgeEntryNotional : 0;
    if (
      priceDistanceAtr >= DELTA_BLEED_EXIT.ATR_MULTIPLIER &&
      profitPct < DELTA_BLEED_EXIT.PROFIT_CAP_PCT
    ) {
      return {
        shouldClose: true,
        reason: `Delta-bleed exit: spot ${currentPrice.toFixed(2)} is ${priceDistanceAtr.toFixed(2)}x ATR away from strike ${state.hedgeStrikePrice.toFixed(2)} (profit only ${(profitPct * 100).toFixed(1)}%)`,
        currentProfit: totalUnrealizedPnl,
        peakProfit: state.hedgePeakProfit,
      };
    }
  }

  // Guard: don't trigger profit exits on tiny P&L noise
  if (totalUnrealizedPnl < HEDGE_PROFIT_CONFIG.MIN_PROFIT_USD && state.hedgePeakProfit < HEDGE_PROFIT_CONFIG.MIN_PROFIT_USD) {
    return noAction;
  }

  // --- Condition 1: Fixed Profit Target ---
  if (state.hedgeEntryNotional > 0) {
    const profitPct = totalUnrealizedPnl / state.hedgeEntryNotional;
    if (profitPct >= HEDGE_PROFIT_CONFIG.PROFIT_TARGET_PCT) {
      return {
        shouldClose: true,
        reason: `Fixed target hit: profit ${(profitPct * 100).toFixed(1)}% >= ${(HEDGE_PROFIT_CONFIG.PROFIT_TARGET_PCT * 100).toFixed(0)}% of premium`,
        currentProfit: totalUnrealizedPnl,
        peakProfit: state.hedgePeakProfit,
      };
    }
  }

  // --- Condition 2: Trailing Peak Drawdown ---
  if (state.hedgePeakProfit > HEDGE_PROFIT_CONFIG.MIN_PROFIT_USD) {
    const drawdownFromPeak = 1 - (totalUnrealizedPnl / state.hedgePeakProfit);
    if (drawdownFromPeak >= HEDGE_PROFIT_CONFIG.TRAILING_DRAWDOWN_PCT) {
      return {
        shouldClose: true,
        reason: `Trailing peak exit: profit dropped ${(drawdownFromPeak * 100).toFixed(1)}% from peak $${state.hedgePeakProfit.toFixed(2)} (current: $${totalUnrealizedPnl.toFixed(2)})`,
        currentProfit: totalUnrealizedPnl,
        peakProfit: state.hedgePeakProfit,
      };
    }
  }

  // --- Condition 3: Time-Based Decay Capture ---
  if (state.hedgeExpiryTime > 0 && state.hedgeEntryTime > 0 && totalUnrealizedPnl > 0) {
    const totalDuration = state.hedgeExpiryTime - state.hedgeEntryTime;
    const elapsed = Date.now() - state.hedgeEntryTime;
    if (totalDuration > 0) {
      const timeElapsedPct = elapsed / totalDuration;
      if (timeElapsedPct >= HEDGE_PROFIT_CONFIG.TIME_DECAY_THRESHOLD) {
        return {
          shouldClose: true,
          reason: `Time-based exit: ${(timeElapsedPct * 100).toFixed(1)}% of time-to-expiry elapsed with $${totalUnrealizedPnl.toFixed(2)} profit`,
          currentProfit: totalUnrealizedPnl,
          peakProfit: state.hedgePeakProfit,
        };
      }
    }
  }

  return noAction;
}
