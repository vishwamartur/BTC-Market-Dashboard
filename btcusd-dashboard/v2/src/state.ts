/**
 * Centralized bot state.
 *
 * All mutable runtime state lives in a single BotState object instead
 * of scattered module-level `let` variables. This makes the state
 * snapshotable, testable, and debuggable.
 *
 * Rule: never add module-level `let` variables in other files.
 * Always extend BotState and pass it through function parameters.
 */

import type { NormalizedPosition, SignalData } from './types.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// BotState definition
// ---------------------------------------------------------------------------

export interface BotState {
  // --- Core trading state ---
  dailyPnl: number;
  consecutiveSignalCount: number;
  lastSignal: string;
  lastTradeTime: number;

  // --- Hedge (options) state ---
  isHedged: boolean;
  hedgePeakProfit: number;
  hedgeEntryTime: number;
  hedgeEntryNotional: number;
  hedgeExpiryTime: number;
  /** Strike price of the short straddle at entry (used for delta-bleed exit) */
  hedgeStrikePrice: number;
  /** ATR at the time of hedge entry (used for delta-bleed exit) */
  hedgeEntryAtr: number;

  // --- Per-tick market snapshot (refreshed each tick) ---
  currentPrice: number;
  availableBalance: number;
  futuresPosition: NormalizedPosition | null;
  optionPositions: NormalizedPosition[];
  hasOpenOptions: boolean;

  // --- Latest signal (refreshed each tick) ---
  signal: SignalData | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInitialState(): BotState {
  return {
    dailyPnl: 0,
    consecutiveSignalCount: 0,
    lastSignal: 'NEUTRAL',
    lastTradeTime: 0,

    isHedged: false,
    hedgePeakProfit: 0,
    hedgeEntryTime: 0,
    hedgeEntryNotional: 0,
    hedgeExpiryTime: 0,
    hedgeStrikePrice: 0,
    hedgeEntryAtr: 0,

    currentPrice: 0,
    availableBalance: 0,
    futuresPosition: null,
    optionPositions: [],
    hasOpenOptions: false,

    signal: null,
  };
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

/** Reset hedge profit-tracking fields. Call when hedge is closed or expires. */
export function resetHedgeState(state: BotState): void {
  const prev = {
    hedgePeakProfit: state.hedgePeakProfit,
    hedgeEntryTime: state.hedgeEntryTime,
    hedgeEntryNotional: state.hedgeEntryNotional,
    hedgeStrikePrice: state.hedgeStrikePrice,
    hedgeEntryAtr: state.hedgeEntryAtr,
  };
  state.isHedged = false;
  state.hedgePeakProfit = 0;
  state.hedgeEntryTime = 0;
  state.hedgeEntryNotional = 0;
  state.hedgeExpiryTime = 0;
  state.hedgeStrikePrice = 0;
  state.hedgeEntryAtr = 0;
  logger.info(prev, 'Reset hedge profit-tracking state');
}

/** Record entry metadata when a new hedge (short straddle) is opened. */
export function recordHedgeEntry(
  state: BotState,
  entryNotional: number,
  expiryTime: number,
  strikePrice: number = 0,
  entryAtr: number = 0,
): void {
  state.isHedged = true;
  state.hedgePeakProfit = 0;
  state.hedgeEntryTime = Date.now();
  state.hedgeEntryNotional = entryNotional;
  state.hedgeExpiryTime = expiryTime;
  state.hedgeStrikePrice = strikePrice;
  state.hedgeEntryAtr = entryAtr;
  logger.info({
    hedgeEntryNotional: entryNotional.toFixed(2),
    hedgeExpiryTime: new Date(expiryTime).toISOString(),
    hedgeStrikePrice: strikePrice > 0 ? strikePrice.toFixed(2) : 'N/A',
    hedgeEntryAtr: entryAtr > 0 ? entryAtr.toFixed(2) : 'N/A',
  }, 'Recorded hedge entry metadata');
}

/** Log a compact summary of current state for observability. */
export function logStateSummary(state: BotState): void {
  logger.info({
    signal: state.signal?.overallSignal,
    confidence: state.signal?.confidence,
    score: state.signal?.score,
    consecutive: state.consecutiveSignalCount,
    price: state.currentPrice,
    hasFutures: !!state.futuresPosition,
    hasOptions: state.hasOpenOptions,
    isHedged: state.isHedged,
    availableBalance: state.availableBalance.toFixed(2),
  }, 'Tick');
}
