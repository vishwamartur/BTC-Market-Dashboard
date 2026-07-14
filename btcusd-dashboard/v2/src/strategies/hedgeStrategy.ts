/**
 * Hedge (adaptive options) strategy.
 *
 * Activates when the risk manager returns a HEDGE action.
 * Selects the optimal hedge structure based on signal score:
 *   - Iron Condor (|score| < 0.10): symmetric, capped-loss
 *   - Skewed Iron Condor (0.10 ≤ |score| < 0.30): asymmetric condor
 *   - Credit Spread (|score| ≥ 0.30): one-sided defined-risk
 *
 * Handles closing existing futures positions before entering the hedge.
 *
 * Profit-taking is handled separately by the orchestrator via
 * evaluateHedgeProfitTaking() — it runs on every tick, not just
 * when shouldActivate returns true.
 */

import type { Strategy, StrategyContext } from './Strategy.js';
import type { StrategyResult } from '../types.js';
import { placeLimitOrderWithRetry } from '../delta.js';
import { executeIronCondor, executeCreditSpread, executeShortStrangle, closeOptionsHedge } from '../optionsManager.js';
import type { HedgeResult } from '../optionsManager.js';
import { calculateBalanceBasedSize, BALANCE_RISK_CONFIG } from '../positionSizing.js';
import { BTCUSDT_PRODUCT_ID } from '../positionService.js';
import { recordHedgeEntry, resetHedgeState } from '../state.js';
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

    const targetHedgeMode = ctx.riskDecision.hedgeMode ?? 'IRON_CONDOR';
    const scoreBias = ctx.riskDecision.scoreBias ?? 0;

    // 2. Manage existing hedges
    if (state.isHedged) {
      // If the market moved and the optimal hedge mode changed, automatically close the old one
      if (state.hedgeMode && state.hedgeMode !== targetHedgeMode) {
        logger.info(
          { oldMode: state.hedgeMode, newMode: targetHedgeMode },
          'Hedge mode changed due to new signal score. Closing old options positions.',
        );
        if (!config.DRY_RUN) {
          await closeOptionsHedge(config); // This automatically places limit orders to close
          resetHedgeState(state);
          await sleep(2000);
        } else {
          logger.info('[DRY RUN] Would close old options hedge via limit orders');
        }
      } else {
        logger.info({ currentMode: state.hedgeMode }, 'Already hedged with the correct mode, skipping new hedge entry');
        return { action: 'SKIPPED', reason: 'Already hedged' };
      }
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
      { hedgeSize, hedgeMode: targetHedgeMode, scoreBias, availableBalance: state.availableBalance.toFixed(2) },
      'Executing adaptive options hedge strategy',
    );

    // 3. Route to the correct execution function based on targetHedgeMode
    let hedgeRes: HedgeResult;
    try {
      switch (targetHedgeMode) {
        case 'CREDIT_SPREAD':
          // Credit spread needs a non-zero scoreBias
          hedgeRes = await executeCreditSpread(
            config, state.currentPrice,
            scoreBias as -1 | 1,
            state.dailyPnl, hedgeSize,
          );
          break;

        case 'SKEWED_IRON_CONDOR':
          hedgeRes = await executeIronCondor(
            config, state.currentPrice,
            scoreBias as -1 | 0 | 1,
            state.dailyPnl, hedgeSize,
          );
          break;

        case 'IRON_CONDOR':
        default:
          hedgeRes = await executeIronCondor(
            config, state.currentPrice,
            0, // symmetric
            state.dailyPnl, hedgeSize,
          );
          break;
      }
    } catch (err) {
      // If iron condor / credit spread fails (e.g. not enough strikes),
      // fall back to simple short strangle
      logger.warn({ error: err instanceof Error ? err.message : String(err), targetHedgeMode }, 'Adaptive hedge failed, falling back to short strangle');
      hedgeRes = await executeShortStrangle(config, state.currentPrice, state.dailyPnl, hedgeSize);
    }

    if (hedgeRes.success && hedgeRes.entryNotional !== undefined && hedgeRes.expiryTime !== undefined) {
      const strikePriceRaw = hedgeRes.callProduct?.strike_price;
      const strikePrice = strikePriceRaw !== undefined ? Number(strikePriceRaw) : 0;
      const entryAtr = await fetchAtr(config);
      recordHedgeEntry(state, hedgeRes.entryNotional, hedgeRes.expiryTime, strikePrice, entryAtr, targetHedgeMode);
    } else if (hedgeRes.success) {
      state.isHedged = true;
      state.hedgeMode = targetHedgeMode;
    }

    if (!hedgeRes.success) {
      return { action: 'ERROR', reason: `Failed to execute ${targetHedgeMode}` };
    }

    const modeName = hedgeRes.hedgeMode ?? targetHedgeMode;
    return { action: 'EXECUTED', reason: `${modeName} opened with ${hedgeSize} contracts` };
  },
};
