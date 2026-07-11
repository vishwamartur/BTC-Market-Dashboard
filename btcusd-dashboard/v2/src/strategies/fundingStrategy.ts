/**
 * Funding rate arbitrage strategy.
 *
 * Activates when the funding rate is elevated (longs paying shorts).
 * Enters a synthetic cash & carry: Buy Call + Sell Put + Short Perp.
 * Net delta exposure ≈ 0, but we collect the funding rate.
 *
 * Wrapped from the existing fundingArbitrage.ts module into the
 * Strategy interface pattern.
 *
 * NOTE: This strategy currently runs independently of the risk
 * manager's decision. It checks funding rate thresholds internally.
 */

import type { Strategy, StrategyContext } from './Strategy.js';
import type { StrategyResult } from '../types.js';
import { manageFundingArbitrage } from '../fundingArbitrage.js';
import { logger } from '../logger.js';

/**
 * Minimum confidence to consider running funding arbitrage.
 * We only run this when the market is choppy (low confidence),
 * similar to the hedge strategy.
 */
const MIN_CONFIDENCE_FOR_FUNDING = 50;

export const fundingStrategy: Strategy = {
  name: 'FundingArbitrage',

  shouldActivate(ctx: StrategyContext): boolean {
    // Only activate during low-confidence periods when we'd otherwise hedge.
    // Also skip if we already have a hedge running.
    return (
      ctx.signal.confidence < MIN_CONFIDENCE_FOR_FUNDING &&
      !ctx.state.isHedged &&
      !ctx.state.futuresPosition
    );
  },

  async execute(ctx: StrategyContext): Promise<StrategyResult> {
    const { config, state } = ctx;

    logger.info('Evaluating funding rate arbitrage opportunity');

    try {
      await manageFundingArbitrage(config, state.currentPrice, 10);
      return { action: 'EXECUTED', reason: 'Funding arbitrage check completed' };
    } catch (err: any) {
      logger.error({ error: err.message }, 'Funding arbitrage error');
      return { action: 'ERROR', reason: err.message };
    }
  },
};
