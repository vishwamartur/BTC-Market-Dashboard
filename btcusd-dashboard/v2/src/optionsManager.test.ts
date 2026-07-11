/**
 * Tests for evaluateHedgeProfitTaking in optionsManager.ts.
 *
 * Focus: the new delta-bleed exit rule (Chunk 4), plus regression tests
 * confirming existing profit-target / trailing-peak / time-decay exits still work.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { evaluateHedgeProfitTaking } from './optionsManager.js';
import { createInitialState, recordHedgeEntry, resetHedgeState } from './state.js';
import type { BotState } from './state.js';
import type { NormalizedPosition } from './types.js';

const SIX_MIN_MS = 6 * 60 * 1000;     // > 5 min minimum for delta-bleed
const FOUR_MIN_MS = 4 * 60 * 1000;     // < 5 min minimum
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function makeOptionPos(unrealizedPnl: number): NormalizedPosition {
  return {
    productId: 1,
    symbol: 'C-BTC-100000',
    side: 'SHORT',
    size: 10,
    entryPrice: 1000,
    unrealizedPnl,
    type: 'call_option',
  };
}

function setupHedgeEntry(opts: {
  strikePrice?: number;
  entryAtr?: number;
  entryNotional?: number;
  entryTimeAgoMs?: number;
  peakProfit?: number;
}): BotState {
  const state = createInitialState();
  state.hedgeEntryTime = Date.now() - (opts.entryTimeAgoMs ?? SIX_MIN_MS);
  state.hedgeExpiryTime = state.hedgeEntryTime + ONE_DAY_MS;
  state.hedgeEntryNotional = opts.entryNotional ?? 100;
  state.hedgeStrikePrice = opts.strikePrice ?? 0;
  state.hedgeEntryAtr = opts.entryAtr ?? 0;
  state.hedgePeakProfit = opts.peakProfit ?? 0;
  state.isHedged = true;
  state.hasOpenOptions = true;
  return state;
}

describe('evaluateHedgeProfitTaking — delta-bleed exit (Chunk 4)', () => {
  it('triggers when spot is >= 2× ATR from strike, >= 5 min elapsed, profit < 30%', () => {
    const state = setupHedgeEntry({
      strikePrice: 100000,
      entryAtr: 500, // 2% of price
      entryNotional: 100,
      entryTimeAgoMs: SIX_MIN_MS,
    });
    // Spot moved 1100 from strike -> 1100/500 = 2.2 ATR
    // Unrealized P&L: 5% of premium (well below 30% cap)
    const positions = [makeOptionPos(5)];
    const result = evaluateHedgeProfitTaking(state, positions, 101100);
    expect(result.shouldClose).toBe(true);
    expect(result.reason).toMatch(/Delta-bleed exit/);
    expect(result.reason).toMatch(/2\.2[0-9]?x ATR/);
  });

  it('does NOT trigger within 5 minutes of entry even if 2× ATR away', () => {
    const state = setupHedgeEntry({
      strikePrice: 100000,
      entryAtr: 500,
      entryNotional: 100,
      entryTimeAgoMs: FOUR_MIN_MS, // < 5 min
    });
    const positions = [makeOptionPos(5)];
    const result = evaluateHedgeProfitTaking(state, positions, 101100);
    // Delta-bleed skipped. P&L is 5/100=5% which is < 30%, so none of the
    // profit exits trigger either. Final result: no close.
    expect(result.shouldClose).toBe(false);
  });

  it('does NOT trigger when profit already >= 30% of premium (profit-taking wins)', () => {
    const state = setupHedgeEntry({
      strikePrice: 100000,
      entryAtr: 500,
      entryNotional: 100,
      entryTimeAgoMs: SIX_MIN_MS,
    });
    // Spot 2× ATR away AND unrealized P&L = 70% of premium (>= 60% fixed target)
    const positions = [makeOptionPos(70)];
    const result = evaluateHedgeProfitTaking(state, positions, 101100);
    // Should still close — but via fixed profit target (Condition 1), not delta-bleed.
    expect(result.shouldClose).toBe(true);
    expect(result.reason).toMatch(/Fixed target hit/);
  });

  it('does NOT trigger when spot is within 2× ATR of strike', () => {
    const state = setupHedgeEntry({
      strikePrice: 100000,
      entryAtr: 500,
      entryNotional: 100,
      entryTimeAgoMs: SIX_MIN_MS,
    });
    // Only 1.5 ATR away
    const positions = [makeOptionPos(5)];
    const result = evaluateHedgeProfitTaking(state, positions, 100750);
    expect(result.shouldClose).toBe(false);
  });

  it('does NOT trigger when hedgeStrikePrice is 0 (legacy state without strike)', () => {
    const state = setupHedgeEntry({
      strikePrice: 0,
      entryAtr: 500,
      entryNotional: 100,
      entryTimeAgoMs: SIX_MIN_MS,
    });
    const positions = [makeOptionPos(5)];
    const result = evaluateHedgeProfitTaking(state, positions, 101100);
    expect(result.shouldClose).toBe(false);
  });

  it('does NOT trigger when hedgeEntryAtr is 0 (legacy state without ATR)', () => {
    const state = setupHedgeEntry({
      strikePrice: 100000,
      entryAtr: 0,
      entryNotional: 100,
      entryTimeAgoMs: SIX_MIN_MS,
    });
    const positions = [makeOptionPos(5)];
    const result = evaluateHedgeProfitTaking(state, positions, 101100);
    expect(result.shouldClose).toBe(false);
  });

  it('does NOT trigger when currentPrice is 0', () => {
    const state = setupHedgeEntry({
      strikePrice: 100000,
      entryAtr: 500,
      entryNotional: 100,
      entryTimeAgoMs: SIX_MIN_MS,
    });
    const positions = [makeOptionPos(5)];
    const result = evaluateHedgeProfitTaking(state, positions, 0);
    expect(result.shouldClose).toBe(false);
  });

  it('triggers on downward drift as well as upward', () => {
    const state = setupHedgeEntry({
      strikePrice: 100000,
      entryAtr: 500,
      entryNotional: 100,
      entryTimeAgoMs: SIX_MIN_MS,
    });
    // Spot dropped 1100 below strike (BTC falling)
    const positions = [makeOptionPos(5)];
    const result = evaluateHedgeProfitTaking(state, positions, 98900);
    expect(result.shouldClose).toBe(true);
    expect(result.reason).toMatch(/Delta-bleed exit/);
  });
});

describe('evaluateHedgeProfitTaking — existing exit rules still work', () => {
  it('fixed profit target still triggers at 60%', () => {
    const state = setupHedgeEntry({
      strikePrice: 0,    // disable delta-bleed
      entryAtr: 0,
      entryNotional: 100,
      entryTimeAgoMs: SIX_MIN_MS,
      peakProfit: 70,
    });
    // No delta-bleed (strike=0), 70% profit -> fixed target
    const positions = [makeOptionPos(70)];
    const result = evaluateHedgeProfitTaking(state, positions, 100000);
    expect(result.shouldClose).toBe(true);
    expect(result.reason).toMatch(/Fixed target hit/);
  });

  it('trailing drawdown still triggers at 30% drawdown from peak', () => {
    const state = setupHedgeEntry({
      strikePrice: 0,
      entryAtr: 0,
      entryNotional: 100,
      entryTimeAgoMs: SIX_MIN_MS,
      peakProfit: 100,
    });
    // Profit dropped 50% from peak (50 / 100 = 0.5 >= 0.3)
    const positions = [makeOptionPos(50)];
    const result = evaluateHedgeProfitTaking(state, positions, 100000);
    expect(result.shouldClose).toBe(true);
    expect(result.reason).toMatch(/Trailing peak exit/);
  });

  it('time-decay exit triggers when >75% of time elapsed and profit > 0', () => {
    const state = setupHedgeEntry({
      strikePrice: 0,
      entryAtr: 0,
      entryNotional: 100,
      // 80% of a 1-day window has elapsed
      entryTimeAgoMs: 0.8 * ONE_DAY_MS,
    });
    const positions = [makeOptionPos(10)]; // small profit but > MIN_PROFIT_USD
    const result = evaluateHedgeProfitTaking(state, positions, 100000);
    expect(result.shouldClose).toBe(true);
    expect(result.reason).toMatch(/Time-based exit/);
  });

  it('does nothing when no positions are open', () => {
    const state = setupHedgeEntry({});
    const result = evaluateHedgeProfitTaking(state, [], 100000);
    expect(result.shouldClose).toBe(false);
    expect(result.reason).toBe('');
  });

  it('does nothing when P&L is tiny noise', () => {
    const state = setupHedgeEntry({
      strikePrice: 0,
      entryAtr: 0,
      entryNotional: 100,
      entryTimeAgoMs: SIX_MIN_MS,
    });
    const positions = [makeOptionPos(0.10)]; // < MIN_PROFIT_USD (0.50)
    const result = evaluateHedgeProfitTaking(state, positions, 100000);
    expect(result.shouldClose).toBe(false);
  });

  it('records peak profit correctly across calls', () => {
    const state = setupHedgeEntry({
      strikePrice: 0,
      entryAtr: 0,
      entryNotional: 100,
      entryTimeAgoMs: SIX_MIN_MS,
    });
    // First call: profit = 10
    evaluateHedgeProfitTaking(state, [makeOptionPos(10)], 100000);
    expect(state.hedgePeakProfit).toBe(10);
    // Second call: profit drops to 5 -> peak stays at 10
    evaluateHedgeProfitTaking(state, [makeOptionPos(5)], 100000);
    expect(state.hedgePeakProfit).toBe(10);
    // Third call: profit climbs to 20 -> peak moves up
    evaluateHedgeProfitTaking(state, [makeOptionPos(20)], 100000);
    expect(state.hedgePeakProfit).toBe(20);
  });
});

describe('recordHedgeEntry / resetHedgeState integration with delta-bleed fields', () => {
  it('recordHedgeEntry stores strike and ATR', () => {
    const state = createInitialState();
    recordHedgeEntry(state, 250, Date.now() + ONE_DAY_MS, 100000, 500);
    expect(state.hedgeStrikePrice).toBe(100000);
    expect(state.hedgeEntryAtr).toBe(500);
    expect(state.isHedged).toBe(true);
  });

  it('resetHedgeState clears strike and ATR', () => {
    const state = createInitialState();
    recordHedgeEntry(state, 250, Date.now() + ONE_DAY_MS, 100000, 500);
    expect(state.hedgeStrikePrice).toBe(100000);
    resetHedgeState(state);
    expect(state.hedgeStrikePrice).toBe(0);
    expect(state.hedgeEntryAtr).toBe(0);
    expect(state.isHedged).toBe(false);
  });
});
