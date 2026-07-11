/**
 * Tests for state.ts — focused on Chunk 4 additions:
 *   - hedgeStrikePrice / hedgeEntryAtr fields on BotState
 *   - recordHedgeEntry accepting (strikePrice, entryAtr)
 *   - resetHedgeState clearing the new fields
 */

import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  recordHedgeEntry,
  resetHedgeState,
} from './state.js';

describe('createInitialState', () => {
  it('initializes delta-bleed fields to 0', () => {
    const state = createInitialState();
    expect(state.hedgeStrikePrice).toBe(0);
    expect(state.hedgeEntryAtr).toBe(0);
    expect(state.isHedged).toBe(false);
    expect(state.hedgeEntryNotional).toBe(0);
    expect(state.hedgeEntryTime).toBe(0);
    expect(state.hedgeExpiryTime).toBe(0);
    expect(state.hedgePeakProfit).toBe(0);
  });
});

describe('recordHedgeEntry (Chunk 4 signature)', () => {
  it('stores strike price and ATR when provided', () => {
    const state = createInitialState();
    const expiry = Date.now() + 24 * 60 * 60 * 1000;
    recordHedgeEntry(state, 250.5, expiry, 100000, 500);
    expect(state.isHedged).toBe(true);
    expect(state.hedgeEntryNotional).toBe(250.5);
    expect(state.hedgeExpiryTime).toBe(expiry);
    expect(state.hedgeStrikePrice).toBe(100000);
    expect(state.hedgeEntryAtr).toBe(500);
    expect(state.hedgePeakProfit).toBe(0);
    expect(state.hedgeEntryTime).toBeGreaterThan(0);
  });

  it('accepts backward-compatible call without strike/ATR', () => {
    const state = createInitialState();
    const expiry = Date.now() + 24 * 60 * 60 * 1000;
    // Old-style call with only 2 required args (defaults are 0)
    recordHedgeEntry(state, 100, expiry);
    expect(state.hedgeStrikePrice).toBe(0);
    expect(state.hedgeEntryAtr).toBe(0);
    expect(state.isHedged).toBe(true);
  });

  it('resets peak profit on new entry', () => {
    const state = createInitialState();
    const expiry = Date.now() + 24 * 60 * 60 * 1000;
    recordHedgeEntry(state, 100, expiry, 100000, 500);
    state.hedgePeakProfit = 25;
    recordHedgeEntry(state, 200, expiry, 101000, 510);
    expect(state.hedgePeakProfit).toBe(0);
    expect(state.hedgeEntryNotional).toBe(200);
    expect(state.hedgeStrikePrice).toBe(101000);
  });
});

describe('resetHedgeState (Chunk 4)', () => {
  it('clears all hedge fields including new strike/ATR', () => {
    const state = createInitialState();
    const expiry = Date.now() + 24 * 60 * 60 * 1000;
    recordHedgeEntry(state, 250, expiry, 100000, 500);
    state.hedgePeakProfit = 42;

    resetHedgeState(state);

    expect(state.isHedged).toBe(false);
    expect(state.hedgePeakProfit).toBe(0);
    expect(state.hedgeEntryTime).toBe(0);
    expect(state.hedgeEntryNotional).toBe(0);
    expect(state.hedgeExpiryTime).toBe(0);
    expect(state.hedgeStrikePrice).toBe(0);
    expect(state.hedgeEntryAtr).toBe(0);
  });

  it('does not touch non-hedge state', () => {
    const state = createInitialState();
    state.dailyPnl = 12.5;
    state.currentPrice = 99000;
    state.signal = { overallSignal: 'BUY', confidence: 80, score: 0.6 };

    resetHedgeState(state);

    expect(state.dailyPnl).toBe(12.5);
    expect(state.currentPrice).toBe(99000);
    expect(state.signal).not.toBeNull();
  });
});
