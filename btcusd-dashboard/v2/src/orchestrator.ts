/**
 * Orchestrator — runs one tick of the trading loop.
 *
 * This is the "brain" of the bot. Each tick it:
 *  1. Fetches fresh market data (signal, price, positions, balance)
 *  2. Syncs position state (detects expired options, etc.)
 *  3. Checks hedge profit-taking (every tick while hedged)
 *  4. Evaluates risk (shouldTrade)
 *  5. Routes to the appropriate strategy
 *  6. Returns updated state
 *
 * The main loop in index.ts just calls runTick() in a while(true) loop.
 */

import type { Config } from './config/index.js';
import type { BotState } from './state.js';
import type { DeltaPosition } from './types.js';
import { fetchSignal, fetchMarketPrice } from './signalFetcher.js';
import { getAllPositions } from './delta.js';
import { fetchAvailableBalance } from './positionSizing.js';
import { normalizePositions, getFuturesPosition, getOptionPositions, hasOpenOptions } from './positionService.js';
import { shouldTrade, DEFAULT_RISK_CONFIG } from './riskManager.js';
import { evaluateHedgeProfitTaking, closeOptionsHedge } from './optionsManager.js';
import { resetHedgeState, logStateSummary } from './state.js';
import { logger } from './logger.js';
import type { Strategy } from './strategies/Strategy.js';
import { futuresStrategy } from './strategies/futuresStrategy.js';
import { hedgeStrategy } from './strategies/hedgeStrategy.js';
import { fundingStrategy } from './strategies/fundingStrategy.js';

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Ordered list of strategies. First match wins. */
const STRATEGIES: Strategy[] = [
  hedgeStrategy,
  futuresStrategy,
  fundingStrategy,
];

/**
 * Run one tick of the trading loop.
 * Pure function of (config, currentState) → updatedState.
 */
export async function runTick(config: Config, state: BotState): Promise<BotState> {
  // -----------------------------------------------------------------
  // 1. FETCH FRESH DATA
  // -----------------------------------------------------------------
  const signal = await fetchSignal(config);
  const currentPrice = await fetchMarketPrice(config);
  const availableBalance = await fetchAvailableBalance(config);

  const allPosRes = await getAllPositions(config.DELTA_API_KEY, config.DELTA_API_SECRET);
  const rawPositions = (allPosRes.success && Array.isArray(allPosRes.result))
    ? allPosRes.result as DeltaPosition[]
    : [];
  const normalized = normalizePositions(rawPositions);

  // -----------------------------------------------------------------
  // 2. SYNC STATE from live exchange data
  // -----------------------------------------------------------------
  state.signal = signal;
  state.currentPrice = currentPrice;
  state.availableBalance = availableBalance;
  state.futuresPosition = getFuturesPosition(normalized);
  state.optionPositions = getOptionPositions(normalized);
  state.hasOpenOptions = hasOpenOptions(normalized);

  // Sync isHedged from live data — never rely on stale memory
  if (state.hasOpenOptions) {
    state.isHedged = true;
  } else if (state.isHedged) {
    logger.info('Options positions expired or were closed externally. Resetting hedge state.');
    resetHedgeState(state);
  }

  // -----------------------------------------------------------------
  // 3. HEDGE PROFIT-TAKING (every tick while hedged)
  // -----------------------------------------------------------------
  if (state.isHedged && state.hasOpenOptions) {
    const profitAction = evaluateHedgeProfitTaking(state, state.optionPositions, currentPrice);
    if (profitAction.shouldClose) {
      logger.info(
        { reason: profitAction.reason, currentProfit: profitAction.currentProfit.toFixed(4), peakProfit: profitAction.peakProfit.toFixed(4) },
        '💰 Booking profits on hedge position',
      );
      if (!config.DRY_RUN) {
        await closeOptionsHedge(config);
      } else {
        logger.info('[DRY RUN] Would close hedge to book profits');
      }
      resetHedgeState(state);
      await sleep(2000);
      return state; // Skip rest of tick — just took profit
    }
  }

  // -----------------------------------------------------------------
  // 4. HYSTERESIS CHECK
  // -----------------------------------------------------------------
  if (signal.overallSignal === state.lastSignal) {
    state.consecutiveSignalCount++;
  } else {
    state.consecutiveSignalCount = 1;
    state.lastSignal = signal.overallSignal;
  }

  logStateSummary(state);

  if (state.consecutiveSignalCount < 3) {
    return state; // Not enough consecutive signals yet
  }

  // -----------------------------------------------------------------
  // 5. EVALUATE RISK
  // -----------------------------------------------------------------
  const riskDecision = shouldTrade(signal, DEFAULT_RISK_CONFIG, currentPrice);

  // -----------------------------------------------------------------
  // 6. ROUTE TO STRATEGY
  // -----------------------------------------------------------------
  const ctx = { config, state, signal, riskDecision };

  for (const strategy of STRATEGIES) {
    if (strategy.shouldActivate(ctx)) {
      logger.info({ strategy: strategy.name, action: riskDecision.action }, 'Strategy activated');
      const result = await strategy.execute(ctx);
      logger.info({ strategy: strategy.name, result: result.action, reason: result.reason }, 'Strategy result');
      break;
    }
  }

  return state;
}
