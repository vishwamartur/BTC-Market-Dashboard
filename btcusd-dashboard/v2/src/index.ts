import { loadConfig } from './config/index.js';
import { fetchSignal, fetchMarketPrice } from './signalFetcher.js';
import { getDeltaPositions, placeDeltaOrder } from './delta.js';
import { shouldTrade, canTrade, DEFAULT_RISK_CONFIG } from './riskManager.js';
import { logger } from './logger.js';
import { executeShortStraddle } from './optionsManager.js';

const BTCUSDT_PRODUCT_ID = 27;

// Internal state
let dailyPnl = 0;
let consecutiveSignalCount = 0;
let lastSignal = 'NEUTRAL';
let lastTradeTime = 0;
let isHedged = false;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePosition(rawResult: any, productId: number) {
  if (!Array.isArray(rawResult)) return null;
  const pos = rawResult.find((p: any) => p.product_id === productId);
  if (!pos || pos.size === 0) return null;
  
  return {
    side: pos.size > 0 ? 'LONG' : 'SHORT',
    size: Math.abs(pos.size),
    entryPrice: Number(pos.entry_price) || null,
    unrealizedPnl: Number(pos.unrealized_pnl) || null,
  };
}

async function closeActivePosition(config: any, position: any, reason: string) {
  logger.info({ reason, position }, 'Closing active position');
  const action = position.side === 'LONG' ? 'sell' : 'buy';
  const orderRes = await placeDeltaOrder(
    config.DELTA_API_KEY,
    config.DELTA_API_SECRET,
    BTCUSDT_PRODUCT_ID,
    position.size,
    action,
    'market',
    undefined,
    { reduceOnly: true }
  );
  if (!orderRes.success) {
    logger.error({ error: orderRes.error }, 'Failed to close position');
  } else {
    logger.info({ result: orderRes.result }, 'Position closed successfully');
  }
}

async function executeTrade(config: any, action: 'BUY' | 'SELL', size: number) {
  logger.info({ action, size }, 'Executing trade entry');
  const deltaSide = action === 'BUY' ? 'buy' : 'sell';
  const orderRes = await placeDeltaOrder(
    config.DELTA_API_KEY,
    config.DELTA_API_SECRET,
    BTCUSDT_PRODUCT_ID,
    size,
    deltaSide,
    'market'
  );
  if (!orderRes.success) {
    logger.error({ error: orderRes.error }, 'Failed to execute trade');
  } else {
    logger.info({ result: orderRes.result }, 'Trade executed successfully');
    lastTradeTime = Date.now();
  }
}

async function mainLoop() {
  const config = loadConfig(process.env);
  logger.info('v2 bot starting');

  if (config.BOT_DISABLED) {
    logger.info('Bot is disabled in config (BOT_DISABLED=true)');
    return;
  }

  while (true) {
    try {
      // 1. Fetch data
      const signal = await fetchSignal(config);
      const currentPrice = await fetchMarketPrice(config);
      
      const posRes = await getDeltaPositions(config.DELTA_API_KEY, config.DELTA_API_SECRET, BTCUSDT_PRODUCT_ID);
      const activePosition = posRes.success ? normalizePosition(posRes.result, BTCUSDT_PRODUCT_ID) : null;

      // 2. Hysteresis Check
      if (signal.overallSignal === lastSignal) {
        consecutiveSignalCount++;
      } else {
        consecutiveSignalCount = 1;
        lastSignal = signal.overallSignal;
      }

      logger.info({ signal: signal.overallSignal, score: signal.score, consecutive: consecutiveSignalCount, price: currentPrice }, 'Tick');

      if (consecutiveSignalCount < 3) {
        await sleep(15000);
        continue;
      }

      // 3. Evaluate Risk
      const decision = shouldTrade(signal, DEFAULT_RISK_CONFIG, currentPrice);

      // 4. Handle Open Position Exits
      if (activePosition) {
        const shouldCloseLong = activePosition.side === 'LONG' && decision.action === 'SELL';
        const shouldCloseShort = activePosition.side === 'SHORT' && decision.action === 'BUY';

        if (shouldCloseLong || shouldCloseShort) {
          if (!config.DRY_RUN) {
            await closeActivePosition(config, activePosition, `Opposite ${signal.overallSignal} signal`);
          } else {
            logger.info({ action: 'CLOSE', side: activePosition.side }, '[DRY RUN] Would close position');
          }
        }
        await sleep(15000);
        continue;
      }

      // 5. Handle New Entries
      const timeSinceLastTrade = Date.now() - lastTradeTime;
      if (timeSinceLastTrade < DEFAULT_RISK_CONFIG.cooldownMs) {
        await sleep(15000);
        continue;
      }

      if (!canTrade(dailyPnl, DEFAULT_RISK_CONFIG)) {
        logger.warn('Daily loss limit reached, trading halted');
        await sleep(60000); // Sleep longer if halted
        continue;
      }

      if (decision.action === 'HEDGE') {
        if (!isHedged) {
          logger.info('Confidence is low. Executing Options Hedge strategy.');
          if (!config.DRY_RUN) {
            const hedgeRes = await executeShortStraddle(config, currentPrice, dailyPnl);
            if (hedgeRes.success) isHedged = true;
          } else {
            // Also call it in dry run to trigger the greek logging
            await executeShortStraddle(config, currentPrice, dailyPnl);
            isHedged = true;
          }
        }
      } else if (decision.action && decision.size > 0) {
        // If we are currently hedged and we get a strong directional signal, we should probably close the hedge
        if (isHedged) {
          logger.info('Strong directional signal received. Closing previous options hedge (simulated for now)');
          isHedged = false;
        }

        if (!config.DRY_RUN) {
          await executeTrade(config, decision.action, decision.size);
        } else {
          logger.info({ action: decision.action, size: decision.size }, '[DRY RUN] Would execute entry');
        }
      }

    } catch (err: any) {
      logger.error({ error: err.message }, 'Error in main loop');
    }

    await sleep(15000);
  }
}

mainLoop().catch(err => {
  logger.fatal({ error: err }, 'Fatal error in bot');
  process.exit(1);
});
