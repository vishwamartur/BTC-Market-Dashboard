import { getTickers, placeLimitOrderWithRetry, getAllPositions } from './delta.js';
import { logger } from './logger.js';
import { findAtTheMoneyStraddle } from './optionsManager.js';
import type { Config } from './config/index.js';

// Entry: When funding rate > 0.02% per 8hrs (Longs pay Shorts highly)
const FUNDING_ENTRY_THRESHOLD = 0.02; 
// Exit: When funding rate drops below 0.005% (No longer worth holding)
const FUNDING_EXIT_THRESHOLD = 0.005;

export async function manageFundingArbitrage(config: Config, currentPrice: number, size: number) {
  // 1. Fetch live funding rate
  const tRes = await getTickers(config.DELTA_API_KEY, config.DELTA_API_SECRET, 'BTCUSD');
  if (!tRes.success || !Array.isArray(tRes.result)) return;
  
  const btcTicker = tRes.result.find((t: any) => t.product_id === 27);
  if (!btcTicker) return;

  const fundingRateStr = btcTicker.funding_rate || '0';
  const fundingRate = Number(fundingRateStr) * 100; // convert to percentage

  // 2. Fetch all current positions
  const posRes = await getAllPositions(config.DELTA_API_KEY, config.DELTA_API_SECRET);
  if (!posRes.success || !Array.isArray(posRes.result)) return;
  
  const allPositions = posRes.result;

  // Identify Funding Arb legs: Short Perp, Long Call, Short Put
  const perpPos = allPositions.find((p: any) => p.product_id === 27 && p.size !== 0);
  
  const optionsPos = allPositions.filter((p: any) => {
    const sym = (p.product_symbol || p.symbol || '') as string;
    return (sym.startsWith('C-') || sym.startsWith('P-')) && p.size !== 0;
  });

  const hasLongCall = optionsPos.some((p: any) => (p.product_symbol || p.symbol || '').startsWith('C-') && p.size > 0);
  const hasShortPut = optionsPos.some((p: any) => (p.product_symbol || p.symbol || '').startsWith('P-') && p.size < 0);
  const hasShortPerp = perpPos && perpPos.size < 0;

  const isFundingArbActive = hasLongCall && hasShortPut && hasShortPerp;

  logger.info({ 
    fundingRate: fundingRate.toFixed(4) + '%', 
    isFundingArbActive, 
    perpSize: perpPos?.size || 0,
    optionsCount: optionsPos.length 
  }, 'Funding Arbitrage Check');

  // 3. Logic: Exit or Entry
  if (isFundingArbActive) {
    if (fundingRate < FUNDING_EXIT_THRESHOLD) {
      logger.info(`Funding rate dropped to ${fundingRate.toFixed(4)}%. Closing Synthetic Cash & Carry.`);
      if (!config.DRY_RUN) {
        // Close Perp
        await placeLimitOrderWithRetry(config.DELTA_API_KEY, config.DELTA_API_SECRET, 27, Math.abs(perpPos.size), 'buy', 'BTCUSD', { reduceOnly: true });
        // Close Options
        for (const opt of optionsPos) {
          const closeSide = opt.size > 0 ? 'sell' : 'buy';
          await placeLimitOrderWithRetry(config.DELTA_API_KEY, config.DELTA_API_SECRET, opt.product_id, Math.abs(opt.size), closeSide, opt.product_symbol || opt.symbol, { reduceOnly: true });
        }
      }
    } else {
      logger.info('Funding Arbitrage active and profitable. Holding position.');
    }
  } else {
    // We are NOT in a funding arb. Check if we should enter.
    if (fundingRate > FUNDING_ENTRY_THRESHOLD) {
      // Clean up any stray positions before entering a complex 3-leg trade
      if (perpPos || optionsPos.length > 0) {
        logger.warn('Cannot enter Funding Arb because there are existing stray positions. Please close them manually or wait for the bot to clear them.');
        return;
      }

      logger.info(`Funding rate ${fundingRate.toFixed(4)}% > threshold ${FUNDING_ENTRY_THRESHOLD}%. Executing Synthetic Cash & Carry.`);
      
      if (!config.DRY_RUN) {
        const straddle = await findAtTheMoneyStraddle(config, currentPrice);
        
        // Enter Synthetic Long (Buy Call, Sell Put)
        await placeLimitOrderWithRetry(config.DELTA_API_KEY, config.DELTA_API_SECRET, straddle.call.id, size, 'buy', straddle.call.symbol);
        await placeLimitOrderWithRetry(config.DELTA_API_KEY, config.DELTA_API_SECRET, straddle.put.id, size, 'sell', straddle.put.symbol);
        
        // Enter Short Perp
        await placeLimitOrderWithRetry(config.DELTA_API_KEY, config.DELTA_API_SECRET, 27, size, 'sell', 'BTCUSD');
      } else {
        logger.info('[DRY RUN] Would execute Synthetic Cash & Carry (Buy Call, Sell Put, Short Perp).');
      }
    }
  }
}
