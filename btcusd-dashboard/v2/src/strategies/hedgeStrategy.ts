/**
 * Hedge (short straddle) strategy.
 *
 * Activates when the risk manager returns a HEDGE action (confidence 30-60).
 * Handles closing existing futures positions before entering the hedge,
 * and opening new short straddle positions.
 *
 * Profit-taking is handled separately by the orchestrator via
 * evaluateHedgeProfitTaking() — it runs on every tick, not just
 * when shouldActivate returns true.
 *
 * Extracted from the old index.ts "HEDGE mode" block (lines 178-209).
 */

import type { Strategy, StrategyContext } from './Strategy.js';
import type { StrategyResult } from '../types.js';
import { placeLimitOrderWithRetry } from '../delta.js';
import { executeShortStraddle } from '../optionsManager.js';
import { calculateBalanceBasedSize, BALANCE_RISK_CONFIG } from '../positionSizing.js';
import { BTCUSDT_PRODUCT_ID } from '../positionService.js';
import { recordHedgeEntry } from '../state.js';
import { fetchAtr } from '../signalFetcher.js';
import { logger } from '../logger.js';

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const hedgeStrategy: Strategy = {
  name: 'Hedge',

  shouldActivate(ctx: StrategyContext): boolean {
    return ctx.riskDecision.action === 'HEDGE';
  },

  async execute(ctx: StrategyContext): Promise<StrategyResult> {
    const { config, state, signal } = ctx;

    // 1. Close any open FUTURES position first — we're switching to hedge mode
    if (state.futuresPosition) {
      logger.info(
        { side: state.futuresPosition.side, size: state.futuresPosition.size },
        'Closing futures position before entering hedge mode',
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
        logger.info('[DRY RUN] Would close futures position before hedge');
      }
      await sleep(2000);
    }

    // 2. Open the hedge if we don't already have one
    if (state.isHedged) {
      logger.info('Already hedged, skipping new straddle entry');
      return { action: 'SKIPPED', reason: 'Already hedged' };
    }

    const baseSize = calculateBalanceBasedSize(
      state.availableBalance,
      state.currentPrice,
      BALANCE_RISK_CONFIG.hedgeRiskPct,
      BALANCE_RISK_CONFIG.minHedgeContracts,
      BALANCE_RISK_CONFIG.maxHedgeContracts,
      signal.confidence,
    );
    // riskDecision.size acts as a multiplier (e.g. 1.5 for drift-enhanced hedge)
    const hedgeSize = Math.round(baseSize * Math.max(1, ctx.riskDecision.size));

    if (ctx.riskDecision.size > 1) {
      logger.info(
        { baseSize, multiplier: ctx.riskDecision.size, hedgeSize },
        'Drift-enhanced hedge: applying risk multiplier',
      );
    }

    logger.info(
      { hedgeSize, availableBalance: state.availableBalance.toFixed(2) },
      'Confidence is low. Executing Options Hedge strategy.',
    );

    const hedgeRes = await executeShortStraddle(config, state.currentPrice, state.dailyPnl, hedgeSize);

    if (hedgeRes.success && hedgeRes.entryNotional !== undefined && hedgeRes.expiryTime !== undefined) {
      // Extract strike from the returned call product. executeShortStraddle now
      // includes callProduct/putProduct in DRY_RUN as well, so strike is recorded
      // for both live and simulated entries (enabling delta-bleed exit tests in DRY_RUN).
      const strikePriceRaw = hedgeRes.callProduct?.strike_price;
      const strikePrice = strikePriceRaw !== undefined ? Number(strikePriceRaw) : 0;

      // Fetch ATR for delta-bleed exit baseline
      const entryAtr = await fetchAtr(config);

      // Intentional state mutation: recordHedgeEntry writes entry metadata
      // (strike, ATR, notional, expiry, isHedged) directly onto the shared
      // BotState. This is the documented exception to the "strategies never
      // mutate state" rule in Strategy.ts — the orchestrator does not own
      // hedge-entry bookkeeping, so the strategy that performs the entry must.
      recordHedgeEntry(state, hedgeRes.entryNotional, hedgeRes.expiryTime, strikePrice, entryAtr);
    } else if (hedgeRes.success) {
      // Missing metadata fallback — keep isHedged flag consistent so the
      // orchestrator doesn't re-enter the hedge on the next tick.
      state.isHedged = true;
    }

    if (!hedgeRes.success) {
      return { action: 'ERROR', reason: 'Failed to execute short straddle' };
    }

    return { action: 'EXECUTED', reason: `Short straddle opened with ${hedgeSize} contracts` };
  },
};
