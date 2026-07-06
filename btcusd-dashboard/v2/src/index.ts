import { loadConfig } from './config/index.js';
import { fetchSignal, fetchMarketPrice } from './signalFetcher.js';
import { getAllPositions, placeLimitOrderWithRetry, getDeltaWalletBalances } from './delta.js';
import { shouldTrade, canTrade, DEFAULT_RISK_CONFIG } from './riskManager.js';
import { logger } from './logger.js';
import { executeShortStraddle, closeOptionsHedge } from './optionsManager.js';
import { manageFundingArbitrage } from './fundingArbitrage.js';

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
  minHedgeContracts: 10,
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
      // 4. FUNDING ARBITRAGE (CASH & CARRY) MODE
      // ---------------------------------------------------------------
      // We calculate a unified balance-based size for the legs of the cash and carry.
      // E.g. risk 10% of available balance per leg.
      const arbSize = calculateBalanceBasedSize(
        availableBalance, currentPrice,
        0.10, // 10% risk per leg
        BALANCE_RISK_CONFIG.minFuturesContracts,
        BALANCE_RISK_CONFIG.maxFuturesContracts,
        100 // Full confidence for arbitrage
      );

      await manageFundingArbitrage(config, currentPrice, arbSize);

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
