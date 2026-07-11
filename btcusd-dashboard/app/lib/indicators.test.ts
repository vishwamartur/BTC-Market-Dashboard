/**
 * Unit tests for the trend / drift indicators added in Chunk 1.
 * Run with: npx tsx --test app/lib/indicators.test.ts
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  calcLinearRegressionSlope,
  calcEMASlope,
  calcDonchianChannels,
  calcBollingerBandwidth,
  detectMarketRegime,
} from './indicators.js';

describe('calcLinearRegressionSlope', () => {
  it('returns 0 for empty array', () => {
    assert.equal(calcLinearRegressionSlope([]), 0);
  });

  it('returns 0 for a single point', () => {
    assert.equal(calcLinearRegressionSlope([42]), 0);
  });

  it('returns 0 for flat prices', () => {
    assert.equal(calcLinearRegressionSlope([100, 100, 100, 100, 100]), 0);
  });

  it('returns 1.0 for prices [100, 101, 102, 103]', () => {
    assert.equal(calcLinearRegressionSlope([100, 101, 102, 103]), 1.0);
  });

  it('returns -1.0 for a perfectly falling series', () => {
    assert.equal(
      calcLinearRegressionSlope([103, 102, 101, 100]),
      -1.0
    );
  });

  it('returns the correct slope for an arithmetic progression', () => {
    // Step of 2.5 starting at 100 -> y = 100, 102.5, 105, 107.5
    const slope = calcLinearRegressionSlope([100, 102.5, 105, 107.5]);
    assert.ok(Math.abs(slope - 2.5) < 1e-9, `expected 2.5, got ${slope}`);
  });

  it('returns 0 for a single point even when period is large', () => {
    assert.equal(calcLinearRegressionSlope([1]), 0);
  });
});

describe('calcEMASlope', () => {
  it('returns 0 for empty array', () => {
    assert.equal(calcEMASlope([], 21), 0);
  });

  it('returns 0 when there are fewer prices than the period', () => {
    assert.equal(calcEMASlope([100, 101, 102], 21), 0);
  });

  it('returns 0 for flat prices', () => {
    const flat = Array.from({ length: 50 }, () => 100);
    assert.equal(calcEMASlope(flat, 21), 0);
  });

  it('returns a positive value for steadily rising prices', () => {
    const rising: number[] = [];
    for (let i = 0; i < 60; i++) rising.push(100 + i); // +1 per candle
    const slope = calcEMASlope(rising, 21);
    assert.ok(slope > 0, `expected positive slope, got ${slope}`);
  });

  it('returns a negative value for steadily falling prices', () => {
    const falling: number[] = [];
    for (let i = 0; i < 60; i++) falling.push(200 - i); // -1 per candle
    const slope = calcEMASlope(falling, 21);
    assert.ok(slope < 0, `expected negative slope, got ${slope}`);
  });

  it('matches (ema[last] - ema[first]) / ema[first] using the last period points', () => {
    // Reproduce the formula directly and compare against the helper.
    const period = 21;
    const prices: number[] = [];
    for (let i = 0; i < 50; i++) prices.push(100 + i * 0.5);

    // Recompute EMA manually with the same k = 2 / (period + 1).
    const k = 2 / (period + 1);
    const ema: number[] = [prices[0]];
    for (let i = 1; i < prices.length; i++) {
      ema.push(prices[i] * k + ema[i - 1] * (1 - k));
    }

    const slice = ema.slice(ema.length - period);
    const expected = (slice[slice.length - 1] - slice[0]) / slice[0];

    const actual = calcEMASlope(prices, period);
    assert.ok(
      Math.abs(actual - expected) < 1e-12,
      `expected ${expected}, got ${actual}`
    );
  });

  it('returns 0 for period < 2', () => {
    assert.equal(calcEMASlope([100, 101, 102], 1), 0);
  });
});

describe('calcDonchianChannels', () => {
  it('returns empty arrays for empty input', () => {
    const { upper, lower } = calcDonchianChannels([], 20);
    assert.equal(upper.length, 0);
    assert.equal(lower.length, 0);
  });

  it('pads the first period-1 entries with NaN', () => {
    const { upper, lower } = calcDonchianChannels([1, 2, 3, 4, 5], 3);
    assert.equal(upper.length, 5);
    assert.equal(lower.length, 5);
    assert.ok(Number.isNaN(upper[0]));
    assert.ok(Number.isNaN(upper[1]));
    assert.ok(Number.isNaN(lower[0]));
    assert.ok(Number.isNaN(lower[1]));
  });

  it('computes rolling highs and lows over the window', () => {
    const prices = [10, 12, 14, 11, 13, 15, 9];
    const { upper, lower } = calcDonchianChannels(prices, 3);

    // index 2: window [10, 12, 14] -> upper 14, lower 10
    assert.equal(upper[2], 14);
    assert.equal(lower[2], 10);

    // index 3: window [12, 14, 11] -> upper 14, lower 11
    assert.equal(upper[3], 14);
    assert.equal(lower[3], 11);

    // index 6: window [13, 15, 9] -> upper 15, lower 9
    assert.equal(upper[6], 15);
    assert.equal(lower[6], 9);
  });

  it('returns upper == lower == price for a flat series', () => {
    const flat = [50, 50, 50, 50, 50];
    const { upper, lower } = calcDonchianChannels(flat, 3);
    for (let i = 2; i < flat.length; i++) {
      assert.equal(upper[i], 50);
      assert.equal(lower[i], 50);
    }
  });

  it('uses the full available window when prices.length == period', () => {
    const { upper, lower } = calcDonchianChannels([3, 1, 4, 1, 5], 5);
    assert.equal(upper[4], 5);
    assert.equal(lower[4], 1);
  });
});

describe('calcBollingerBandwidth', () => {
  it('returns an array the same length as the input', () => {
    const prices = Array.from({ length: 30 }, (_, i) => 100 + i);
    const bw = calcBollingerBandwidth(prices);
    assert.equal(bw.length, prices.length);
  });

  it('returns 0 for indices where there is not enough data', () => {
    const prices = Array.from({ length: 30 }, (_, i) => 100 + i);
    const bw = calcBollingerBandwidth(prices, 20, 2);
    // First 19 entries should be 0 (period - 1 = 19)
    for (let i = 0; i < 19; i++) {
      assert.equal(bw[i], 0, `index ${i} should be 0, got ${bw[i]}`);
    }
  });

  it('returns 0 for an empty array', () => {
    assert.deepEqual(calcBollingerBandwidth([]), []);
  });

  it('returns 0 for a flat series (std dev is 0, but ratio is well defined)', () => {
    // For a perfectly flat series, upper == middle == lower, so bandwidth is 0.
    const flat = Array.from({ length: 30 }, () => 100);
    const bw = calcBollingerBandwidth(flat);
    for (let i = 19; i < flat.length; i++) {
      assert.equal(bw[i], 0, `flat index ${i} should be 0, got ${bw[i]}`);
    }
  });

  it('produces a positive bandwidth for a volatile series', () => {
    const prices = [
      100, 102, 98, 104, 96, 103, 97, 105, 95, 106,
      94, 108, 93, 107, 95, 109, 92, 110, 91, 111,
      90, 112, 89, 113, 88, 114, 87, 115, 86, 116,
    ];
    const bw = calcBollingerBandwidth(prices, 20, 2);
    // From index 19 onwards the series should have a positive bandwidth.
    for (let i = 19; i < prices.length; i++) {
      assert.ok(bw[i] > 0, `index ${i} expected positive, got ${bw[i]}`);
    }
  });

  it('matches (upper - lower) / middle using the existing Bollinger helper', () => {
    const period = 10;
    const stddev = 2;
    const prices = Array.from({ length: 25 }, (_, i) =>
      100 + Math.sin(i / 2) * 5
    );
    const bw = calcBollingerBandwidth(prices, period, stddev);

    // Re-derive upper/lower/middle using the documented formulas and compare.
    // (We can't import calcBollingerBands into a sibling file easily, so we
    //  re-implement the expected ratio here for the validation check.)
    for (let i = period - 1; i < prices.length; i++) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += prices[j];
      const middle = sum / period;
      let sumSq = 0;
      for (let j = i - period + 1; j <= i; j++) {
        sumSq += (prices[j] - middle) ** 2;
      }
      const sd = Math.sqrt(sumSq / period);
      const expected = ((middle + stddev * sd) - (middle - stddev * sd)) / middle;
      assert.ok(
        Math.abs(bw[i] - expected) < 1e-12,
        `index ${i} expected ${expected}, got ${bw[i]}`
      );
    }
  });
});

describe('detectMarketRegime', () => {
  it('detects a steady uptrend as trending', () => {
    const prices: number[] = [];
    for (let i = 0; i < 25; i++) prices.push(100 + i * 0.5);
    assert.equal(detectMarketRegime(prices, 20), 'trending');
  });

  it('detects a tight range as ranging', () => {
    const prices: number[] = [];
    for (let i = 0; i < 25; i++) prices.push(100 + Math.sin(i) * 0.2);
    assert.equal(detectMarketRegime(prices, 20), 'ranging');
  });

  it('detects choppy prices with no clear direction', () => {
    const prices = [100, 102, 99, 103, 98, 104, 97, 105, 96, 106, 95, 107, 94, 108, 93, 109, 92, 110, 91, 111, 90, 112, 89, 113, 88];
    assert.equal(detectMarketRegime(prices, 20), 'choppy');
  });

  it('returns choppy for insufficient data', () => {
    assert.equal(detectMarketRegime([100, 101, 102], 20), 'choppy');
  });
});
