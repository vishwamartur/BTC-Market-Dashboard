import { getProducts, getTickers, placeDeltaOrder } from './delta.js';
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

export async function executeShortStraddle(config: Config, currentPrice: number, dailyPnl: number = 0) {
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

  const dynamicSize = calculateDynamicSize(dailyPnl, callTicker, putTicker);
  logger.info({ dailyPnl, dynamicSize, callTheta: callTicker?.greeks?.theta, putTheta: putTicker?.greeks?.theta }, 'Calculated dynamic position size');

  if (config.DRY_RUN) {
    logger.info({ action: 'SELL', size: dynamicSize }, '[DRY RUN] Would SELL ATM Call and SELL ATM Put to collect premium.');
    return { success: true, dryRun: true };
  }

  // Sell Call
  const callRes = await placeDeltaOrder(
    config.DELTA_API_KEY,
    config.DELTA_API_SECRET,
    straddle.call.id,
    dynamicSize,
    'sell',
    'market'
  );

  // Sell Put
  const putRes = await placeDeltaOrder(
    config.DELTA_API_KEY,
    config.DELTA_API_SECRET,
    straddle.put.id,
    dynamicSize,
    'sell',
    'market'
  );

  if (!callRes.success || !putRes.success) {
    logger.error({ callRes, putRes }, 'Failed to execute Short Straddle');
    return { success: false, callRes, putRes };
  }

  logger.info('Successfully opened Delta-Neutral Short Straddle');
  return { success: true, callRes, putRes, callProduct: straddle.call, putProduct: straddle.put };
}
