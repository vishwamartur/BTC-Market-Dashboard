/**
 * Strategy interface.
 *
 * Each trading strategy (futures, hedge, funding arbitrage) implements
 * this interface. The orchestrator calls shouldActivate() to decide
 * which strategy handles the current tick, then calls execute().
 *
 * Rules for strategy implementations:
 * - NEVER mutate state directly; return state updates via StrategyResult
 *   (intentional exception: hedgeStrategy.execute() may call recordHedgeEntry()
 *    to record entry metadata such as strike price and ATR — no other state
 *    mutations are permitted from inside strategies)
 * - ALWAYS respect config.DRY_RUN before placing any orders
 * - Log all decisions with structured pino fields
 */

import type { Config } from '../config/index.js';
import type { BotState } from '../state.js';
import type { RiskDecision, StrategyResult, SignalData } from '../types.js';

export interface StrategyContext {
  config: Config;
  state: BotState;
  signal: SignalData;
  riskDecision: RiskDecision;
}

export interface Strategy {
  /** Human-readable name (used in logs) */
  readonly name: string;

  /** Should this strategy handle the current tick? */
  shouldActivate(ctx: StrategyContext): boolean;

  /** Execute the strategy. Returns what happened + any state mutations. */
  execute(ctx: StrategyContext): Promise<StrategyResult>;
}
