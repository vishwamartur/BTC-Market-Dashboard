/**
 * Options Manager — pure operations for BTC options on Delta Exchange.
 *
 * This module provides functions for:
 *  - Finding ATM options for strangle construction
 *  - Executing short strangle entries
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
 * The short strangle is delta-neutral at entry but becomes increasingly
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

export interface HedgeResult {
  success: boolean;
  dryRun?: boolean;
  callRes?: any;
  putRes?: any;
  /** Long call wing (iron condor buy leg) */
  callWingRes?: any;
  /** Long put wing (iron condor buy leg) */
  putWingRes?: any;
  callProduct?: OptionProduct;
  putProduct?: OptionProduct;
  callWingProduct?: OptionProduct;
  putWingProduct?: OptionProduct;
  /** Estimated net premium collected (for state tracking) */
  entryNotional?: number;
  /** Expiry timestamp (for state tracking) */
  expiryTime?: number;
  /** Which hedge structure was used */
  hedgeMode?: string;
}

// ---------------------------------------------------------------------------
// ATM Strangle Finder
// ---------------------------------------------------------------------------

export async function findOutTheMoneyStrangle(config: Config, currentPrice: number) {
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
  
  const strikes = [...new Set(optionsForExpiry.map(o => Number(o.strike_price)))].sort((a, b) => a - b);
  
  // Call should be above current price (OTM)
  let callStrike = strikes.find(strike => strike > currentPrice);
  // Put should be below current price (OTM)
  let putStrike = [...strikes].reverse().find(strike => strike < currentPrice);
  
  // Fallback to highest/lowest if price is outside the available strikes
  if (!callStrike) callStrike = strikes[strikes.length - 1];
  if (!putStrike) putStrike = strikes[0];

  const otmCall = optionsForExpiry.find(o => o.contract_type === 'call_options' && Number(o.strike_price) === callStrike);
  const otmPut = optionsForExpiry.find(o => o.contract_type === 'put_options' && Number(o.strike_price) === putStrike);

  if (!otmCall || !otmPut) {
    throw new Error(`Failed to find Call (strike ${callStrike}) and Put (strike ${putStrike})`);
  }

  return { call: otmCall, put: otmPut };
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
// Execute Short Strangle
// ---------------------------------------------------------------------------

export async function executeShortStrangle(
  config: Config,
  currentPrice: number,
  dailyPnl: number = 0,
  overrideSize?: number,
): Promise<HedgeResult> {
  logger.info({ price: currentPrice }, 'Setting up Delta-Neutral Short Strangle');
  
  const strangle = await findOutTheMoneyStrangle(config, currentPrice);
  logger.info({ call: strangle.call.symbol, put: strangle.put.symbol, callStrike: strangle.call.strike_price, putStrike: strangle.put.strike_price }, 'Found OTM options');

  // Fetch Greeks
  const [callTickerRes, putTickerRes] = await Promise.all([
    getTickers(config.DELTA_API_KEY, config.DELTA_API_SECRET, strangle.call.symbol),
    getTickers(config.DELTA_API_KEY, config.DELTA_API_SECRET, strangle.put.symbol)
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
  const expiryTime = new Date(strangle.call.settlement_time).getTime();

  if (config.DRY_RUN) {
    logger.info({ action: 'SELL', size: dynamicSize, estimatedPremium: estimatedPremium.toFixed(2) }, '[DRY RUN] Would SELL OTM Call and SELL OTM Put to collect premium.');
    return { success: true, dryRun: true, entryNotional: estimatedPremium, expiryTime, callProduct: strangle.call, putProduct: strangle.put };
  }

  // Sell Call via LIMIT order
  const callRes = await placeLimitOrderWithRetry(
    config.DELTA_API_KEY,
    config.DELTA_API_SECRET,
    strangle.call.id,
    dynamicSize,
    'sell',
    strangle.call.symbol,
  );

  // Sell Put via LIMIT order
  const putRes = await placeLimitOrderWithRetry(
    config.DELTA_API_KEY,
    config.DELTA_API_SECRET,
    strangle.put.id,
    dynamicSize,
    'sell',
    strangle.put.symbol,
  );

  if (!callRes.success || !putRes.success) {
    logger.error({ callRes, putRes }, 'Failed to execute Short Strangle');
    return { success: false, callRes, putRes };
  }

  logger.info('Successfully opened Delta-Neutral Short Strangle');
  return {
    success: true,
    callRes,
    putRes,
    callProduct: strangle.call,
    putProduct: strangle.put,
    entryNotional: estimatedPremium,
    expiryTime,
  };
}

// ---------------------------------------------------------------------------
// Iron Condor Leg Finder
// ---------------------------------------------------------------------------

/**
 * Find 4 legs for an iron condor (or skewed iron condor).
 *
 * Structure:
 *   - Sell OTM Call (inner) + Buy further OTM Call (wing)
 *   - Sell OTM Put (inner) + Buy further OTM Put (wing)
 *
 * Skew (scoreBias):
 *   - 0 = symmetric: both sides 1 strike OTM
 *   - 1 = bullish: put side tight (1 strike OTM), call side wide (2 strikes OTM)
 *   - -1 = bearish: call side tight (1 strike OTM), put side wide (2 strikes OTM)
 */
export async function findIronCondorLegs(
  config: Config,
  currentPrice: number,
  scoreBias: -1 | 0 | 1 = 0,
) {
  const productsRes = await getProducts(config.DELTA_API_KEY, config.DELTA_API_SECRET);
  if (!productsRes.success || !Array.isArray(productsRes.result)) {
    throw new Error('Failed to fetch Delta products for iron condor');
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

  const expiries = [...new Set(btcOptions.map(o => o.settlement_time))].sort();
  const closestExpiry = expiries[0];
  const optionsForExpiry = btcOptions.filter(o => o.settlement_time === closestExpiry);
  const strikes = [...new Set(optionsForExpiry.map(o => Number(o.strike_price)))].sort((a, b) => a - b);

  // Find strikes above and below current price
  const strikesAbove = strikes.filter(s => s > currentPrice);
  const strikesBelow = strikes.filter(s => s < currentPrice).reverse(); // descending

  if (strikesAbove.length < 2 || strikesBelow.length < 2) {
    throw new Error('Not enough strikes available for iron condor');
  }

  // Skew determines how far OTM each side is:
  //   Bullish (+1): call side 2 strikes away (more room), put side 1 strike (tight)
  //   Bearish (-1): put side 2 strikes away (more room), call side 1 strike (tight)
  //   Neutral (0):  both sides 1 strike away
  const callInnerIdx = scoreBias === 1 ? 1 : 0;   // bullish → wider call side
  const putInnerIdx  = scoreBias === -1 ? 1 : 0;   // bearish → wider put side

  const sellCallStrike = strikesAbove[callInnerIdx];
  const buyCallStrike  = strikesAbove[Math.min(callInnerIdx + 1, strikesAbove.length - 1)];
  const sellPutStrike  = strikesBelow[putInnerIdx];
  const buyPutStrike   = strikesBelow[Math.min(putInnerIdx + 1, strikesBelow.length - 1)];

  const sellCall = optionsForExpiry.find(o => o.contract_type === 'call_options' && Number(o.strike_price) === sellCallStrike);
  const buyCall  = optionsForExpiry.find(o => o.contract_type === 'call_options' && Number(o.strike_price) === buyCallStrike);
  const sellPut  = optionsForExpiry.find(o => o.contract_type === 'put_options' && Number(o.strike_price) === sellPutStrike);
  const buyPut   = optionsForExpiry.find(o => o.contract_type === 'put_options' && Number(o.strike_price) === buyPutStrike);

  if (!sellCall || !buyCall || !sellPut || !buyPut) {
    throw new Error(`Failed to find all 4 iron condor legs (sell call ${sellCallStrike}, buy call ${buyCallStrike}, sell put ${sellPutStrike}, buy put ${buyPutStrike})`);
  }

  return { sellCall, buyCall, sellPut, buyPut };
}

// ---------------------------------------------------------------------------
// Execute Iron Condor
// ---------------------------------------------------------------------------

/**
 * Execute an iron condor (or skewed iron condor).
 * Places 4 orders: 2 sells (inner legs) + 2 buys (protective wings).
 *
 * scoreBias:
 *   0 = symmetric iron condor
 *   1 = bullish skew (wider call spread, tighter put spread)
 *  -1 = bearish skew (wider put spread, tighter call spread)
 */
export async function executeIronCondor(
  config: Config,
  currentPrice: number,
  scoreBias: -1 | 0 | 1 = 0,
  dailyPnl: number = 0,
  overrideSize?: number,
): Promise<HedgeResult> {
  const modeName = scoreBias === 0 ? 'Iron Condor' : `Skewed Iron Condor (${scoreBias === 1 ? 'bullish' : 'bearish'})`;
  logger.info({ price: currentPrice, scoreBias, mode: modeName }, `Setting up ${modeName}`);

  const legs = await findIronCondorLegs(config, currentPrice, scoreBias);
  logger.info({
    sellCall: legs.sellCall.strike_price,
    buyCall: legs.buyCall.strike_price,
    sellPut: legs.sellPut.strike_price,
    buyPut: legs.buyPut.strike_price,
  }, 'Found iron condor legs');

  // Fetch tickers for the sell legs to calculate Greeks-based sizing
  const [callTickerRes, putTickerRes] = await Promise.all([
    getTickers(config.DELTA_API_KEY, config.DELTA_API_SECRET, legs.sellCall.symbol),
    getTickers(config.DELTA_API_KEY, config.DELTA_API_SECRET, legs.sellPut.symbol),
  ]);
  const callTicker = callTickerRes.success && Array.isArray(callTickerRes.result) ? callTickerRes.result[0] : null;
  const putTicker = putTickerRes.success && Array.isArray(putTickerRes.result) ? putTickerRes.result[0] : null;

  // Fetch wing prices for net premium calculation
  const [callWingTickerRes, putWingTickerRes] = await Promise.all([
    getTickers(config.DELTA_API_KEY, config.DELTA_API_SECRET, legs.buyCall.symbol),
    getTickers(config.DELTA_API_KEY, config.DELTA_API_SECRET, legs.buyPut.symbol),
  ]);
  const callWingTicker = callWingTickerRes.success && Array.isArray(callWingTickerRes.result) ? callWingTickerRes.result[0] : null;
  const putWingTicker = putWingTickerRes.success && Array.isArray(putWingTickerRes.result) ? putWingTickerRes.result[0] : null;

  const greekSize = calculateDynamicSize(dailyPnl, callTicker, putTicker);
  const dynamicSize = overrideSize ? Math.min(overrideSize, greekSize * 3) : greekSize;

  // Net premium = (sell call + sell put) - (buy call + buy put)
  const sellCallMark = Number(callTicker?.mark_price || 0);
  const sellPutMark = Number(putTicker?.mark_price || 0);
  const buyCallMark = Number(callWingTicker?.mark_price || 0);
  const buyPutMark = Number(putWingTicker?.mark_price || 0);
  const netPremium = ((sellCallMark + sellPutMark) - (buyCallMark + buyPutMark)) * dynamicSize;
  const expiryTime = new Date(legs.sellCall.settlement_time).getTime();

  logger.info({
    dynamicSize,
    sellCallMark, sellPutMark, buyCallMark, buyPutMark,
    netPremium: netPremium.toFixed(2),
  }, 'Iron condor pricing');

  if (config.DRY_RUN) {
    logger.info({ action: modeName, size: dynamicSize, netPremium: netPremium.toFixed(2) }, `[DRY RUN] Would execute ${modeName}`);
    return {
      success: true, dryRun: true,
      entryNotional: netPremium, expiryTime,
      callProduct: legs.sellCall, putProduct: legs.sellPut,
      callWingProduct: legs.buyCall, putWingProduct: legs.buyPut,
      hedgeMode: modeName,
    };
  }

  // Place all 4 orders: sell inner legs, buy outer wings
  const [sellCallRes, sellPutRes, buyCallRes, buyPutRes] = await Promise.all([
    placeLimitOrderWithRetry(config.DELTA_API_KEY, config.DELTA_API_SECRET, legs.sellCall.id, dynamicSize, 'sell', legs.sellCall.symbol),
    placeLimitOrderWithRetry(config.DELTA_API_KEY, config.DELTA_API_SECRET, legs.sellPut.id, dynamicSize, 'sell', legs.sellPut.symbol),
    placeLimitOrderWithRetry(config.DELTA_API_KEY, config.DELTA_API_SECRET, legs.buyCall.id, dynamicSize, 'buy', legs.buyCall.symbol),
    placeLimitOrderWithRetry(config.DELTA_API_KEY, config.DELTA_API_SECRET, legs.buyPut.id, dynamicSize, 'buy', legs.buyPut.symbol),
  ]);

  const allSuccess = sellCallRes.success && sellPutRes.success && buyCallRes.success && buyPutRes.success;
  if (!allSuccess) {
    logger.error({ sellCallRes, sellPutRes, buyCallRes, buyPutRes }, `Failed to execute ${modeName}`);
    return { success: false, callRes: sellCallRes, putRes: sellPutRes, callWingRes: buyCallRes, putWingRes: buyPutRes };
  }

  logger.info(`Successfully opened ${modeName}`);
  return {
    success: true,
    callRes: sellCallRes, putRes: sellPutRes,
    callWingRes: buyCallRes, putWingRes: buyPutRes,
    callProduct: legs.sellCall, putProduct: legs.sellPut,
    callWingProduct: legs.buyCall, putWingProduct: legs.buyPut,
    entryNotional: netPremium, expiryTime,
    hedgeMode: modeName,
  };
}

// ---------------------------------------------------------------------------
// Execute Credit Spread
// ---------------------------------------------------------------------------

/**
 * Execute a one-sided credit spread for clear directional bias.
 *
 * scoreBias:
 *   -1 = bearish → Bear Call Spread (sell OTM call, buy further OTM call)
 *    1 = bullish → Bull Put Spread (sell OTM put, buy further OTM put)
 *
 * Profits if market moves in the expected direction OR stays flat.
 * Max loss is capped by the bought wing.
 */
export async function executeCreditSpread(
  config: Config,
  currentPrice: number,
  scoreBias: -1 | 1,
  dailyPnl: number = 0,
  overrideSize?: number,
): Promise<HedgeResult> {
  const direction = scoreBias === 1 ? 'bullish' : 'bearish';
  logger.info({ price: currentPrice, direction }, `Setting up Credit Spread (${direction})`);

  const productsRes = await getProducts(config.DELTA_API_KEY, config.DELTA_API_SECRET);
  if (!productsRes.success || !Array.isArray(productsRes.result)) {
    throw new Error('Failed to fetch Delta products for credit spread');
  }

  const allProducts = productsRes.result as any[];
  const btcOptions = allProducts.filter(p =>
    (p.contract_type === 'call_options' || p.contract_type === 'put_options') &&
    p.underlying_asset?.symbol === 'BTC' &&
    p.state === 'live'
  ) as OptionProduct[];

  const expiries = [...new Set(btcOptions.map(o => o.settlement_time))].sort();
  const closestExpiry = expiries[0];
  const optionsForExpiry = btcOptions.filter(o => o.settlement_time === closestExpiry);
  const strikes = [...new Set(optionsForExpiry.map(o => Number(o.strike_price)))].sort((a, b) => a - b);

  let sellLeg: OptionProduct | undefined;
  let buyLeg: OptionProduct | undefined;

  if (scoreBias === -1) {
    // Bear Call Spread: sell nearest OTM call, buy next OTM call
    const strikesAbove = strikes.filter(s => s > currentPrice);
    if (strikesAbove.length < 2) throw new Error('Not enough call strikes for bear call spread');
    sellLeg = optionsForExpiry.find(o => o.contract_type === 'call_options' && Number(o.strike_price) === strikesAbove[0]);
    buyLeg  = optionsForExpiry.find(o => o.contract_type === 'call_options' && Number(o.strike_price) === strikesAbove[1]);
  } else {
    // Bull Put Spread: sell nearest OTM put, buy next OTM put
    const strikesBelow = strikes.filter(s => s < currentPrice).reverse();
    if (strikesBelow.length < 2) throw new Error('Not enough put strikes for bull put spread');
    sellLeg = optionsForExpiry.find(o => o.contract_type === 'put_options' && Number(o.strike_price) === strikesBelow[0]);
    buyLeg  = optionsForExpiry.find(o => o.contract_type === 'put_options' && Number(o.strike_price) === strikesBelow[1]);
  }

  if (!sellLeg || !buyLeg) {
    throw new Error(`Failed to find credit spread legs for ${direction} bias`);
  }

  logger.info({ sellStrike: sellLeg.strike_price, buyStrike: buyLeg.strike_price, type: scoreBias === -1 ? 'Bear Call' : 'Bull Put' }, 'Found credit spread legs');

  // Fetch tickers for pricing
  const [sellTickerRes, buyTickerRes] = await Promise.all([
    getTickers(config.DELTA_API_KEY, config.DELTA_API_SECRET, sellLeg.symbol),
    getTickers(config.DELTA_API_KEY, config.DELTA_API_SECRET, buyLeg.symbol),
  ]);
  const sellTicker = sellTickerRes.success && Array.isArray(sellTickerRes.result) ? sellTickerRes.result[0] : null;
  const buyTicker = buyTickerRes.success && Array.isArray(buyTickerRes.result) ? buyTickerRes.result[0] : null;

  const greekSize = calculateDynamicSize(dailyPnl, sellTicker, null);
  const dynamicSize = overrideSize ? Math.min(overrideSize, greekSize * 3) : greekSize;

  const sellMark = Number(sellTicker?.mark_price || 0);
  const buyMark = Number(buyTicker?.mark_price || 0);
  const netPremium = (sellMark - buyMark) * dynamicSize;
  const expiryTime = new Date(sellLeg.settlement_time).getTime();

  const spreadName = scoreBias === -1 ? 'Bear Call Spread' : 'Bull Put Spread';

  logger.info({ dynamicSize, sellMark, buyMark, netPremium: netPremium.toFixed(2) }, `${spreadName} pricing`);

  if (config.DRY_RUN) {
    logger.info({ action: spreadName, size: dynamicSize, netPremium: netPremium.toFixed(2) }, `[DRY RUN] Would execute ${spreadName}`);
    const dryResult: HedgeResult = {
      success: true, dryRun: true,
      entryNotional: netPremium, expiryTime,
      hedgeMode: spreadName,
    };
    if (scoreBias === -1) {
      dryResult.callProduct = sellLeg;
      dryResult.callWingProduct = buyLeg;
    } else {
      dryResult.putProduct = sellLeg;
      dryResult.putWingProduct = buyLeg;
    }
    return dryResult;
  }

  // Place 2 orders: sell inner, buy wing
  const [sellRes, buyRes] = await Promise.all([
    placeLimitOrderWithRetry(config.DELTA_API_KEY, config.DELTA_API_SECRET, sellLeg.id, dynamicSize, 'sell', sellLeg.symbol),
    placeLimitOrderWithRetry(config.DELTA_API_KEY, config.DELTA_API_SECRET, buyLeg.id, dynamicSize, 'buy', buyLeg.symbol),
  ]);

  if (!sellRes.success || !buyRes.success) {
    logger.error({ sellRes, buyRes }, `Failed to execute ${spreadName}`);
    return { success: false, callRes: sellRes, putRes: buyRes };
  }

  logger.info(`Successfully opened ${spreadName}`);
  const result: HedgeResult = {
    success: true,
    entryNotional: netPremium, expiryTime,
    hedgeMode: spreadName,
  };
  if (scoreBias === -1) {
    result.callRes = sellRes;
    result.callWingRes = buyRes;
    result.callProduct = sellLeg;
    result.callWingProduct = buyLeg;
  } else {
    result.putRes = sellRes;
    result.putWingRes = buyRes;
    result.putProduct = sellLeg;
    result.putWingProduct = buyLeg;
  }
  return result;
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
