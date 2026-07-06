import { getProducts, getTickers, placeLimitOrderWithRetry, getAllPositions, setDeltaLeverage } from './delta.js';
import { logger } from './logger.js';
import type { Config } from './config/index.js';

interface OptionProduct {
  id: number;
  symbol: string;
  contract_type: 'call_options' | 'put_options';
  strike_price: string;
  settlement_time: string;
  underlying_asset: { symbol: string };
  state: string;
}

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

export async function executeShortStraddle(config: Config, currentPrice: number, dailyPnl: number = 0, overrideSize?: number) {
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
  // With higher leverage and risk allocation, we allow the override size to be used directly
  const dynamicSize = overrideSize ? Math.min(overrideSize, 2000) : greekSize;
  logger.info({ dailyPnl, greekSize, overrideSize, finalSize: dynamicSize, callTheta: callTicker?.greeks?.theta, putTheta: putTicker?.greeks?.theta }, 'Calculated dynamic position size');

  if (config.DRY_RUN) {
    logger.info({ action: 'SELL', size: dynamicSize }, '[DRY RUN] Would SELL ATM Call and SELL ATM Put to collect premium.');
    return { success: true, dryRun: true };
  }

  // Set Leverage to 10x for options to allow much larger quantities
  logger.info('Increasing leverage to 10x for options products');
  await Promise.all([
    setDeltaLeverage(config.DELTA_API_KEY, config.DELTA_API_SECRET, straddle.call.id, 10),
    setDeltaLeverage(config.DELTA_API_KEY, config.DELTA_API_SECRET, straddle.put.id, 10)
  ]).catch(err => logger.warn({ error: err }, 'Failed to set leverage, continuing anyway'));

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
  return { success: true, callRes, putRes, callProduct: straddle.call, putProduct: straddle.put };
}

/**
 * Closes all open BTC option positions by placing reduce-only LIMIT orders.
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
