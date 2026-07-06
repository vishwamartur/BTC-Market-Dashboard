import { loadConfig } from './config/index.js';
import { fetchSignal, fetchMarketPrice } from './signalFetcher.js';
import { getAllPositions, placeLimitOrderWithRetry, getDeltaWalletBalances } from './delta.js';
import { shouldTrade, canTrade, DEFAULT_RISK_CONFIG } from './riskManager.js';
import { logger } from './logger.js';
import { executeShortStraddle, closeOptionsHedge } from './optionsManager.js';

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

// ---------------------------------------------------------------------------
// Balance-Aware Dynamic Position Sizing
// ---------------------------------------------------------------------------

const BALANCE_RISK_CONFIG = {
  futuresRiskPct: 0.05,    // Risk 5% of available balance per futures trade
  hedgeRiskPct: 0.15,      // Use 15% of available balance for options hedge
  contractSizeBtc: 0.001,  // 1 contract = 0.001 BTC on Delta
  minFuturesContracts: 10,
  maxFuturesContracts: 100,
  minHedgeContracts: 30,
  maxHedgeContracts: 500,
};

async function fetchAvailableBalance(config: any): Promise<number> {
  const res = await getDeltaWalletBalances(config.DELTA_API_KEY, config.DELTA_API_SECRET);
  if (!res.success || !Array.isArray(res.result)) return 0;
  const usdWallet = (res.result as any[]).find((b: any) => 
    (b.asset_symbol === 'USD' || b.asset_symbol === 'USDT') && Number(b.available_balance) > 0
  );
  return usdWallet ? Number(usdWallet.available_balance) : 0;
}

function calculateBalanceBasedSize(
  availableBalance: number,
  currentPrice: number,
  riskPct: number,
  minContracts: number,
  maxContracts: number,
  confidence: number = 60
): number {
  if (availableBalance <= 0 || currentPrice <= 0) return minContracts;

  // How much USD to risk on this trade
  const riskUsd = availableBalance * riskPct;

  // Scale by confidence (higher confidence → closer to full risk allocation)
  const confidenceScale = Math.max(0.5, confidence / 100);
  const adjustedRiskUsd = riskUsd * confidenceScale;

  // Convert USD to contracts: riskUsd / (contractSize * price)
  const contractValueUsd = BALANCE_RISK_CONFIG.contractSizeBtc * currentPrice;
  const contracts = Math.round(adjustedRiskUsd / contractValueUsd);

  return Math.max(minContracts, Math.min(contracts, maxContracts));
}



async function closeActivePosition(config: any, position: any, reason: string) {
  logger.info({ reason, position }, 'Closing active position via LIMIT order');
  const action = position.side === 'LONG' ? 'sell' : 'buy';
  const orderRes = await placeLimitOrderWithRetry(
    config.DELTA_API_KEY,
    config.DELTA_API_SECRET,
    BTCUSDT_PRODUCT_ID,
    position.size,
    action,
    'BTCUSD',
    { reduceOnly: true }
  );
  if (!orderRes.success) {
    logger.error({ error: orderRes.error }, 'Failed to close position');
  } else {
    logger.info({ result: orderRes.result }, 'Position closed successfully');
  }
}

async function executeTrade(config: any, action: 'BUY' | 'SELL', size: number) {
  logger.info({ action, size }, 'Executing trade entry via LIMIT order');
  const deltaSide = action === 'BUY' ? 'buy' : 'sell';
  const orderRes = await placeLimitOrderWithRetry(
    config.DELTA_API_KEY,
    config.DELTA_API_SECRET,
    BTCUSDT_PRODUCT_ID,
    size,
    deltaSide,
    'BTCUSD'
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
      const availableBalance = await fetchAvailableBalance(config);
      
      // Fetch ALL BTC positions (futures + options)
      const allPosRes = await getAllPositions(config.DELTA_API_KEY, config.DELTA_API_SECRET);
      const allPositions = (allPosRes.success && Array.isArray(allPosRes.result)) ? allPosRes.result as any[] : [];

      // Separate futures vs options positions
      const futuresPosition = allPositions.find((p: any) => p.product_id === BTCUSDT_PRODUCT_ID && p.size !== 0);
      const activePosition = futuresPosition ? {
        side: futuresPosition.size > 0 ? 'LONG' : 'SHORT',
        size: Math.abs(futuresPosition.size),
        entryPrice: Number(futuresPosition.entry_price) || null,
        unrealizedPnl: Number(futuresPosition.unrealized_pnl) || null,
      } : null;

      // Detect option positions by symbol prefix (C- = call, P- = put)
      // The positions API does NOT return contract_type, so we can't rely on it
      const hasOpenOptions = allPositions.some((p: any) => {
        const sym = (p.product_symbol || p.symbol || '') as string;
        return (sym.startsWith('C-') || sym.startsWith('P-')) && p.size !== 0;
      });

      // ALWAYS sync isHedged from live exchange data — never rely on stale memory
      if (hasOpenOptions) {
        isHedged = true;
      } else {
        if (isHedged) {
          logger.info('Options positions expired or were closed externally. Resetting hedge state.');
        }
        isHedged = false;
      }

      // 2. Hysteresis Check
      if (signal.overallSignal === lastSignal) {
        consecutiveSignalCount++;
      } else {
        consecutiveSignalCount = 1;
        lastSignal = signal.overallSignal;
      }

      logger.info({
        signal: signal.overallSignal, score: signal.score,
        consecutive: consecutiveSignalCount, price: currentPrice,
        hasFutures: !!activePosition, hasOptions: hasOpenOptions, isHedged,
        availableBalance: availableBalance.toFixed(2),
      }, 'Tick');

      if (consecutiveSignalCount < 3) {
        await sleep(15000);
        continue;
      }

      // 3. Evaluate Risk
      const decision = shouldTrade(signal, DEFAULT_RISK_CONFIG, currentPrice);

      // ---------------------------------------------------------------
      // 4. HEDGE mode (confidence < 60)
      // ---------------------------------------------------------------
      if (decision.action === 'HEDGE') {
        // If we have an open FUTURES position, close it first — we're switching to hedge mode
        if (activePosition) {
          logger.info({ side: activePosition.side, size: activePosition.size }, 'Closing futures position before entering hedge mode');
          if (!config.DRY_RUN) {
            await closeActivePosition(config, activePosition, 'Switching to options hedge — closing futures');
          } else {
            logger.info('[DRY RUN] Would close futures position before hedge');
          }
          await sleep(2000); // Brief pause after closing
        }

        // Now open the hedge if we don't already have one
        if (!isHedged) {
          const hedgeSize = calculateBalanceBasedSize(
            availableBalance, currentPrice,
            BALANCE_RISK_CONFIG.hedgeRiskPct,
            BALANCE_RISK_CONFIG.minHedgeContracts,
            BALANCE_RISK_CONFIG.maxHedgeContracts,
            signal.confidence
          );
          logger.info({ hedgeSize, availableBalance: availableBalance.toFixed(2) }, 'Confidence is low. Executing Options Hedge strategy.');
          if (!config.DRY_RUN) {
            const hedgeRes = await executeShortStraddle(config, currentPrice, dailyPnl, hedgeSize);
            if (hedgeRes.success) isHedged = true;
          } else {
            await executeShortStraddle(config, currentPrice, dailyPnl, hedgeSize);
            isHedged = true;
          }
        }

      // ---------------------------------------------------------------
      // 5. DIRECTIONAL mode (BUY / SELL)
      // ---------------------------------------------------------------
      } else if (decision.action && decision.size > 0) {

        // 5a. Close any open OPTIONS hedge first
        if (isHedged || hasOpenOptions) {
          logger.info('Strong directional signal received. Closing options hedge before entering futures trade.');
          if (!config.DRY_RUN) {
            await closeOptionsHedge(config);
          } else {
            logger.info('[DRY RUN] Would close options hedge');
          }
          isHedged = false;
          await sleep(2000); // Brief pause after closing
        }

        // 5b. Close any opposing FUTURES position first
        if (activePosition) {
          const isOpposite =
            (activePosition.side === 'LONG' && decision.action === 'SELL') ||
            (activePosition.side === 'SHORT' && decision.action === 'BUY');
          const isSameDirection =
            (activePosition.side === 'LONG' && decision.action === 'BUY') ||
            (activePosition.side === 'SHORT' && decision.action === 'SELL');

          if (isOpposite) {
            logger.info({ currentSide: activePosition.side, newAction: decision.action }, 'Closing opposing futures position before new entry');
            if (!config.DRY_RUN) {
              await closeActivePosition(config, activePosition, `Opposite signal: ${decision.action}`);
            } else {
              logger.info('[DRY RUN] Would close opposing futures position');
            }
            await sleep(2000);
          } else if (isSameDirection) {
            logger.info({ side: activePosition.side }, 'Already have a position in the same direction, skipping new entry');
            await sleep(15000);
            continue;
          }
        }

        // 5c. Cooldown check
        const timeSinceLastTrade = Date.now() - lastTradeTime;
        if (timeSinceLastTrade < DEFAULT_RISK_CONFIG.cooldownMs) {
          await sleep(15000);
          continue;
        }

        // 5d. Daily loss check
        if (!canTrade(dailyPnl, DEFAULT_RISK_CONFIG)) {
          logger.warn('Daily loss limit reached, trading halted');
          await sleep(60000);
          continue;
        }

        // 5e. Execute the new futures trade with balance-based sizing
        const futuresSize = calculateBalanceBasedSize(
          availableBalance, currentPrice,
          BALANCE_RISK_CONFIG.futuresRiskPct,
          BALANCE_RISK_CONFIG.minFuturesContracts,
          BALANCE_RISK_CONFIG.maxFuturesContracts,
          signal.confidence
        );
        if (!config.DRY_RUN) {
          await executeTrade(config, decision.action, futuresSize);
        } else {
          logger.info({ action: decision.action, size: futuresSize, availableBalance: availableBalance.toFixed(2) }, '[DRY RUN] Would execute entry');
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
