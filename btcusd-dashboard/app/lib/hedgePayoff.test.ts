/**
 * Unit tests for hedge payoff calculations.
 * Run with: npx tsx --test app/lib/hedgePayoff.test.ts
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  parseOptionStrike,
  isOptionSymbol,
  buildPayoffCurve,
  buildPnlHistory,
  type OptionPosition,
  type RawFill,
} from './hedgePayoff.js';

describe('parseOptionStrike', () => {
  it('extracts strike from C-108000-250711', () => {
    assert.equal(parseOptionStrike('C-108000-250711'), 108000);
  });

  it('extracts strike from P-95000-250711', () => {
    assert.equal(parseOptionStrike('P-95000-250711'), 95000);
  });

  it('returns null for non-option symbols', () => {
    assert.equal(parseOptionStrike('BTCUSDT'), null);
  });

  it('returns null for malformed option symbols', () => {
    assert.equal(parseOptionStrike('C-'), null);
  });
});

describe('isOptionSymbol', () => {
  it('returns true for call symbol', () => {
    assert.equal(isOptionSymbol('C-108000-250711'), true);
  });

  it('returns true for put symbol', () => {
    assert.equal(isOptionSymbol('P-95000-250711'), true);
  });

  it('returns false for futures symbol', () => {
    assert.equal(isOptionSymbol('BTCUSDT'), false);
  });
});

describe('buildPayoffCurve', () => {
  it('produces max profit at strike and correct breakevens', () => {
    const call: OptionPosition = {
      symbol: 'C-100000-250711',
      side: 'SHORT',
      size: 10,
      entryPrice: 500,
      unrealizedPnl: 0,
    };
    const put: OptionPosition = {
      symbol: 'P-100000-250711',
      side: 'SHORT',
      size: 10,
      entryPrice: 500,
      unrealizedPnl: 0,
    };

    const { curve, maxProfit, breakevens, strike } = buildPayoffCurve({
      call,
      put,
      _currentPrice: 100000,
      gridPoints: 101,
    });

    assert.equal(strike, 100000);
    assert.equal(maxProfit, 10000); // 10 * (500 + 500)
    assert.ok(breakevens);
    assert.equal(breakevens!.lower, 99000);
    assert.equal(breakevens!.upper, 101000);

    const atStrike = curve.find(p => p.price === 100000);
    assert.ok(atStrike);
    assert.equal(atStrike!.pnl, 10000);

    const atLower = curve.find(p => p.price === 99000);
    assert.ok(atLower);
    assert.equal(atLower!.pnl, 0);

    const atUpper = curve.find(p => p.price === 101000);
    assert.ok(atUpper);
    assert.equal(atUpper!.pnl, 0);
  });

  it('returns empty result when call/put are missing', () => {
    const result = buildPayoffCurve({
      call: null,
      put: null,
      _currentPrice: 100000,
      gridPoints: 101,
    });
    assert.equal(result.curve.length, 0);
    assert.equal(result.maxProfit, null);
    assert.equal(result.breakevens, null);
    assert.equal(result.strike, null);
  });

  it('returns empty result when call and put strikes do not match', () => {
    const call: OptionPosition = {
      symbol: 'C-100000-250711',
      side: 'SHORT',
      size: 10,
      entryPrice: 500,
      unrealizedPnl: 0,
    };
    const put: OptionPosition = {
      symbol: 'P-95000-250711',
      side: 'SHORT',
      size: 10,
      entryPrice: 500,
      unrealizedPnl: 0,
    };

    const result = buildPayoffCurve({
      call,
      put,
      _currentPrice: 100000,
      gridPoints: 101,
    });

    assert.equal(result.curve.length, 0);
    assert.equal(result.strike, null);
    assert.equal(result.maxProfit, null);
    assert.equal(result.breakevens, null);
  });

  it('returns empty result when either leg is LONG', () => {
    const longCall: OptionPosition = {
      symbol: 'C-100000-250711',
      side: 'LONG',
      size: 10,
      entryPrice: 500,
      unrealizedPnl: 0,
    };
    const shortPut: OptionPosition = {
      symbol: 'P-100000-250711',
      side: 'SHORT',
      size: 10,
      entryPrice: 500,
      unrealizedPnl: 0,
    };

    const resultLongCall = buildPayoffCurve({
      call: longCall,
      put: shortPut,
      _currentPrice: 100000,
      gridPoints: 101,
    });
    assert.equal(resultLongCall.curve.length, 0);
    assert.equal(resultLongCall.maxProfit, null);

    const resultLongPut = buildPayoffCurve({
      call: { ...shortPut, symbol: 'C-100000-250711', side: 'SHORT' },
      put: { ...shortPut, side: 'LONG' },
      _currentPrice: 100000,
      gridPoints: 101,
    });
    assert.equal(resultLongPut.curve.length, 0);
    assert.equal(resultLongPut.maxProfit, null);
  });

  it('returns empty result when size is zero or negative', () => {
    const zeroSize: OptionPosition = {
      symbol: 'C-100000-250711',
      side: 'SHORT',
      size: 0,
      entryPrice: 500,
      unrealizedPnl: 0,
    };
    const put: OptionPosition = {
      symbol: 'P-100000-250711',
      side: 'SHORT',
      size: 0,
      entryPrice: 500,
      unrealizedPnl: 0,
    };

    const zeroResult = buildPayoffCurve({
      call: zeroSize,
      put,
      _currentPrice: 100000,
      gridPoints: 101,
    });
    assert.equal(zeroResult.curve.length, 0);
    assert.equal(zeroResult.maxProfit, null);

    const negativeSize: OptionPosition = {
      symbol: 'C-100000-250711',
      side: 'SHORT',
      size: -5,
      entryPrice: 500,
      unrealizedPnl: 0,
    };
    const negativePut: OptionPosition = {
      symbol: 'P-100000-250711',
      side: 'SHORT',
      size: -3,
      entryPrice: 500,
      unrealizedPnl: 0,
    };

    const negativeResult = buildPayoffCurve({
      call: negativeSize,
      put: negativePut,
      _currentPrice: 100000,
      gridPoints: 101,
    });
    assert.equal(negativeResult.curve.length, 0);
    assert.equal(negativeResult.maxProfit, null);
  });

  it('returns empty result when entry prices are non-finite', () => {
    const callNan: OptionPosition = {
      symbol: 'C-100000-250711',
      side: 'SHORT',
      size: 10,
      entryPrice: Number.NaN,
      unrealizedPnl: 0,
    };
    const put: OptionPosition = {
      symbol: 'P-100000-250711',
      side: 'SHORT',
      size: 10,
      entryPrice: 500,
      unrealizedPnl: 0,
    };

    const nanResult = buildPayoffCurve({
      call: callNan,
      put,
      _currentPrice: 100000,
      gridPoints: 101,
    });
    assert.equal(nanResult.curve.length, 0);
    assert.equal(nanResult.maxProfit, null);

    const infiniteResult = buildPayoffCurve({
      call: { ...put, symbol: 'C-100000-250711', entryPrice: Number.POSITIVE_INFINITY },
      put,
      _currentPrice: 100000,
      gridPoints: 101,
    });
    assert.equal(infiniteResult.curve.length, 0);
    assert.equal(infiniteResult.maxProfit, null);
  });
});

describe('buildPnlHistory', () => {
  it('builds cumulative realized P&L from option fills', () => {
    const fills = [
      { symbol: 'C-100000-250711', realized_pnl: '100', created_at: '2025-07-09T10:00:00Z' },
      { symbol: 'P-100000-250711', realized_pnl: '-50', created_at: '2025-07-09T10:05:00Z' },
    ];

    const result = buildPnlHistory(fills, []);

    assert.equal(result.totalRealizedPnl, 50);
    assert.equal(result.history.length, 3);
    assert.equal(result.history[0].cumulativePnl, 0);
    assert.equal(result.history[1].cumulativePnl, 100);
    assert.equal(result.history[2].cumulativePnl, 50);
  });

  it('adds a final point for current unrealized P&L', () => {
    const fills: RawFill[] = [];
    const positions: OptionPosition[] = [
      { symbol: 'C-100000-250711', side: 'SHORT', size: 1, entryPrice: 500, unrealizedPnl: 200 },
    ];

    const result = buildPnlHistory(fills, positions);

    assert.equal(result.totalRealizedPnl, 0);
    assert.equal(result.history.length, 1);
    assert.equal(result.history[0].cumulativePnl, 200);
  });

  it('ignores non-option fills', () => {
    const fills = [
      { symbol: 'BTCUSDT', realized_pnl: '1000', created_at: '2025-07-09T10:00:00Z' },
    ];

    const result = buildPnlHistory(fills, []);

    assert.equal(result.totalRealizedPnl, 0);
    assert.equal(result.history.length, 0);
  });

  it('handles a mix of option and non-option fills', () => {
    const fills = [
      { symbol: 'BTCUSDT', realized_pnl: '1000', created_at: '2025-07-09T09:00:00Z' },
      { symbol: 'C-100000-250711', realized_pnl: '100', created_at: '2025-07-09T10:00:00Z' },
      { symbol: 'BTCUSD', realized_pnl: '500', created_at: '2025-07-09T10:30:00Z' },
      { symbol: 'P-100000-250711', realized_pnl: '-50', created_at: '2025-07-09T11:00:00Z' },
    ];

    const result = buildPnlHistory(fills, []);

    assert.equal(result.totalRealizedPnl, 50);
    // Start + 2 option fills + (no current unrealized since no positions)
    assert.equal(result.history.length, 3);
    assert.equal(result.history[0].cumulativePnl, 0);
    assert.equal(result.history[1].cumulativePnl, 100);
    assert.equal(result.history[2].cumulativePnl, 50);
    for (const point of result.history) {
      assert.ok(point.timestamp.startsWith('2025-07-09'));
    }
  });
});
