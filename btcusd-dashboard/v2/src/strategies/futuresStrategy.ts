/**
 * Futures (directional) trading strategy.
 *
 * Activates when the risk manager returns a BUY or SELL action with
 * size > 0. Handles closing opposing positions, cooldown checks,
 * daily loss limits, and entering new trades.
 *
 * Extracted from the old index.ts "DIRECTIONAL mode" block (lines 212-279).
 */

import type { Strategy, StrategyContext } from './Strategy.js';
import type { StrategyResult } from '../types.js';
import { placeLimitOrderWithRetry } from '../delta.js';
import { closeOptionsHedge } from '../optionsManager.js';
import { canTrade } from '../riskManager.js';
import { calculateBalanceBasedSize, BALANCE_RISK_CONFIG } from '../positionSizing.js';
import { BTCUSDT_PRODUCT_ID } from '../positionService.js';
import { resetHedgeState } from '../state.js';
import { logger } from '../logger.js';

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const futuresStrategy: Strategy = {
  name: 'Futures',

  shouldActivate(ctx: StrategyContext): boolean {
    const { action, size } = ctx.riskDecision;
    return (action === 'BUY' || action === 'SELL') && size > 0;
  },

  async execute(ctx: StrategyContext): Promise<StrategyResult> {
    const { config, state, riskDecision } = ctx;
    const action = riskDecision.action as 'BUY' | 'SELL';

    // 1. Close any open OPTIONS hedge first
    if (state.isHedged || state.hasOpenOptions) {
      logger.info('Strong directional signal received. Closing options hedge before entering futures trade.');
      if (!config.DRY_RUN) {
        await closeOptionsHedge(config);
      } else {
        logger.info('[DRY RUN] Would close options hedge');
      }
      resetHedgeState(state);
      await sleep(2000);
    }

    // 2. Close any opposing FUTURES position
    if (state.futuresPosition) {
      const isOpposite =
        (state.futuresPosition.side === 'LONG' && action === 'SELL') ||
        (state.futuresPosition.side === 'SHORT' && action === 'BUY');
      const isSameDirection =
        (state.futuresPosition.side === 'LONG' && action === 'BUY') ||
        (state.futuresPosition.side === 'SHORT' && action === 'SELL');

      if (isOpposite) {
        logger.info(
          { currentSide: state.futuresPosition.side, newAction: action },
          'Closing opposing futures position before new entry',
        );
        if (!config.DRY_RUN) {
          const closeSide = state.futuresPosition.side === 'LONG' ? 'sell' : 'buy';
          await placeLimitOrderWithRetry(
            config.DELTA_API_KEY,
            config.DELTA_API_SECRET,
            BTCUSDT_PRODUCT_ID,
            state.futuresPosition.size,
            closeSide,
            'BTCUSD',
            { reduceOnly: true },
          );
        } else {
          logger.info('[DRY RUN] Would close opposing futures position');
        }
        await sleep(2000);
      } else if (isSameDirection) {
        logger.info({ side: state.futuresPosition.side }, 'Already have a position in the same direction, skipping');
        return { action: 'SKIPPED', reason: 'Same-direction position already open' };
      }
    }

    // 3. Cooldown check
    const timeSinceLastTrade = Date.now() - state.lastTradeTime;
    const cooldownMs = 15 * 60 * 1000; // 15 min
    if (timeSinceLastTrade < cooldownMs) {
      return { action: 'SKIPPED', reason: `Cooldown: ${Math.round((cooldownMs - timeSinceLastTrade) / 1000)}s remaining` };
    }

    // 4. Daily loss check
    if (!canTrade(state.dailyPnl)) {
      logger.warn('Daily loss limit reached, trading halted');
      return { action: 'SKIPPED', reason: 'Daily loss limit reached' };
    }

    // 5. Calculate size and execute
    const futuresSize = calculateBalanceBasedSize(
      state.availableBalance,
      state.currentPrice,
      BALANCE_RISK_CONFIG.futuresRiskPct,
      BALANCE_RISK_CONFIG.minFuturesContracts,
      BALANCE_RISK_CONFIG.maxFuturesContracts,
      ctx.signal.confidence,
    );

    if (!config.DRY_RUN) {
      logger.info({ action, size: futuresSize }, 'Executing futures trade entry');
      const deltaSide = action === 'BUY' ? 'buy' : 'sell';
      const orderRes = await placeLimitOrderWithRetry(
        config.DELTA_API_KEY,
        config.DELTA_API_SECRET,
        BTCUSDT_PRODUCT_ID,
        futuresSize,
        deltaSide,
        'BTCUSD',
      );
      if (!orderRes.success) {
        logger.error({ error: orderRes.error }, 'Failed to execute futures trade');
        return { action: 'ERROR', reason: `Order failed: ${JSON.stringify(orderRes.error)}` };
      }
      logger.info({ result: orderRes.result }, 'Futures trade executed successfully');
      state.lastTradeTime = Date.now();
    } else {
      logger.info(
        { action, size: futuresSize, availableBalance: state.availableBalance.toFixed(2) },
        '[DRY RUN] Would execute futures entry',
      );
      state.lastTradeTime = Date.now();
    }

    return { action: 'EXECUTED', reason: `${action} ${futuresSize} contracts` };
  },
};
