/**
 * Unit tests for the signal engine components added in Chunk 2/3.
 * Run with: npx tsx --test app/lib/signals.test.ts
 */
import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { generateTradingSignal, resetSignalHistory, type SignalInputs } from './signals';
import type { WhaleTransaction } from './blockchain';
import { buildSignalDataQuality } from './signalQuality';

/**
 * Helper: 50 prices declining linearly from 100 down to 80.
 * Produces a clear negative LR slope and a clearly negative EMA21 slope.
 */
function decliningPrices(): number[] {
  const n = 50;
  const arr: number[] = [];
  for (let i = 0; i < n; i++) {
    arr.push(100 - (20 * i) / (n - 1));
  }
  return arr;
}

/**
 * Helper: minimal SignalInputs with no active components except those the
 * caller chooses to set. `newsSentiment` defaults to null so a default
 * invocation produces no News Sentiment component.
 */
function baseInputs(overrides: Partial<SignalInputs> = {}): SignalInputs {
  return {
    liquidationStats: {
      totalLongLiquidations: 0,
      totalShortLiquidations: 0,
      totalLongUsd: 0,
      totalShortUsd: 0,
      largestLiquidation: null,
    },
    longShortRatio: null,
    mempoolTxCount: null,
    fastestFee: null,
    whaleTransactions: [],
    hashrateTrend: null,
    fundingRate: null,
    recentPrices: [],
    oiHistory: [],
    newsSentiment: null,
    ...overrides,
  };
}

/**
 * The signal engine keeps a module-level debounce/hysteresis buffer. Tests
 * that need a stable smoothed score warm it up by calling generateTradingSignal
 * repeatedly with the same input until the buffer is dominated by that input.
 *
 * `beforeEach` resets the buffer via `resetSignalHistory()` to avoid
 * cross-test contamination.
 */
const HISTORY_CAPACITY = 20;
function warmUp(inputs: SignalInputs, calls: number = HISTORY_CAPACITY + 5) {
  for (let i = 0; i < calls; i++) generateTradingSignal(inputs);
}

beforeEach(() => {
  resetSignalHistory();
});

function makeWhale(type: 'INFLOW' | 'OUTFLOW', amountBtc: number): WhaleTransaction {
  return {
    hash: `test-${type}-${amountBtc}-${Math.random().toString(36).slice(2)}`,
    time: Date.now(),
    amountBtc,
    usdValue: amountBtc * 50_000,
    feeBtc: 0.0001,
    type,
  };
}

// ---------------------------------------------------------------------------
// Trend Drift
// ---------------------------------------------------------------------------

describe('generateTradingSignal — Trend Drift', () => {
  it('produces a negative Trend Drift on a strong slow downtrend', () => {
    const inputs = baseInputs({ recentPrices: decliningPrices() });
    const result = generateTradingSignal(inputs);

    const drift = result.components.find((c) => c.name === 'Trend Drift');
    assert.ok(drift, 'Trend Drift component should be present when recentPrices.length >= 25');
    assert.equal(drift.weight, 0.11);
    assert.ok(
      drift.score < 0,
      `expected negative Trend Drift score on a downtrend, got ${drift.score}`
    );
    assert.equal(drift.reason, 'Slow downtrend detected (negative LR/EMA slope)');
  });

  it('produces a positive Trend Drift on a steady uptrend', () => {
    const rising: number[] = [];
    for (let i = 0; i < 50; i++) rising.push(100 + i * 0.4);
    const inputs = baseInputs({ recentPrices: rising });
    const result = generateTradingSignal(inputs);

    const drift = result.components.find((c) => c.name === 'Trend Drift');
    assert.ok(drift, 'Trend Drift component should be present on an uptrend');
    assert.ok(
      drift.score > 0,
      `expected positive Trend Drift score on an uptrend, got ${drift.score}`
    );
    assert.equal(drift.reason, 'Slow uptrend detected');
  });

  it('does not produce a Trend Drift component when recentPrices is too short', () => {
    const inputs = baseInputs({ recentPrices: [100, 99, 98, 97, 96] });
    const result = generateTradingSignal(inputs);
    const drift = result.components.find((c) => c.name === 'Trend Drift');
    assert.equal(drift, undefined, 'Trend Drift requires at least 25 prices');
  });

  it('yields SELL or STRONG SELL when many components agree on a downtrend', () => {
    const inputs: SignalInputs = {
      liquidationStats: {
        // Heavy short liquidations -> blow-off top -> bearish
        totalLongLiquidations: 0,
        totalShortLiquidations: 10,
        totalLongUsd: 0,
        totalShortUsd: 100_000,
        largestLiquidation: null,
      },
      longShortRatio: 1.8, // extreme long bias -> bearish contrarian
      mempoolTxCount: null,
      fastestFee: null,
      whaleTransactions: [makeWhale('INFLOW', 2000)], // whale distribution -> bearish
      hashrateTrend: 'DOWN', // bearish
      fundingRate: 0.008, // high positive funding -> bearish
      recentPrices: decliningPrices(),
      oiHistory: [100, 102, 105, 110, 115], // rising OI
      newsSentiment: -0.7, // negative news
    };

    warmUp(inputs);

    const result = generateTradingSignal(inputs);
    assert.ok(
      result.overallSignal === 'SELL' || result.overallSignal === 'STRONG SELL',
      `expected SELL or STRONG SELL, got ${result.overallSignal} (score=${result.score})`
    );
  });
});

// ---------------------------------------------------------------------------
// Range Breakout
// ---------------------------------------------------------------------------

describe('generateTradingSignal — Range Breakout', () => {
  it('produces negative Range Breakout on a squeeze near the lower band', () => {
    // 19 prices oscillating tightly around 100 (std dev < 0.5%), then a 20th
    // price that sits at the bottom of the recent range.
    const prices: number[] = [
      100.0, 100.1, 99.9, 100.05, 100.15, 99.95, 100.1, 99.9, 100.2, 99.85,
      100.1, 99.95, 100.05, 99.9, 100.15, 99.85, 100.1, 99.95, 100.0, 99.5,
    ];
    const inputs = baseInputs({ recentPrices: prices });
    const result = generateTradingSignal(inputs);

    const rb = result.components.find((c) => c.name === 'Range Breakout');
    assert.ok(rb, 'Range Breakout component should be present when recentPrices.length >= 20');
    assert.equal(rb.weight, 0.07);
    assert.equal(rb.score, -0.7, `expected -0.7, got ${rb.score}`);
    assert.equal(rb.reason, 'Downside range breakout building');
  });

  it('produces positive Range Breakout on a squeeze near the upper band', () => {
    const prices: number[] = [
      100.0, 99.9, 100.1, 99.95, 99.85, 100.05, 99.9, 100.1, 99.8, 100.15,
      99.9, 100.05, 99.85, 100.1, 99.9, 100.15, 99.85, 100.05, 100.0, 100.5,
    ];
    const inputs = baseInputs({ recentPrices: prices });
    const result = generateTradingSignal(inputs);

    const rb = result.components.find((c) => c.name === 'Range Breakout');
    assert.ok(rb, 'Range Breakout component should be present when recentPrices.length >= 20');
    assert.equal(rb.score, 0.7, `expected +0.7, got ${rb.score}`);
    assert.equal(rb.reason, 'Upside range breakout building');
  });

  it('reports "No clear range breakout" when no squeeze is present', () => {
    // Strongly trending series — bandwidth will be wider than 0.02.
    const trending = Array.from({ length: 25 }, (_, i) => 100 + i * 2);
    const inputs = baseInputs({ recentPrices: trending });
    const result = generateTradingSignal(inputs);

    const rb = result.components.find((c) => c.name === 'Range Breakout');
    assert.ok(rb);
    assert.equal(rb.score, 0);
    assert.equal(rb.reason, 'No clear range breakout');
  });

  it('does not produce Range Breakout when recentPrices is too short', () => {
    const inputs = baseInputs({ recentPrices: [100, 99, 98, 97, 96] });
    const result = generateTradingSignal(inputs);
    const rb = result.components.find((c) => c.name === 'Range Breakout');
    assert.equal(rb, undefined, 'Range Breakout requires at least 20 prices');
  });
});

// ---------------------------------------------------------------------------
// News Sentiment
// ---------------------------------------------------------------------------

describe('generateTradingSignal — News Sentiment', () => {
  it('produces a negative News Sentiment component when newsSentiment < -0.3', () => {
    const inputs = baseInputs({ newsSentiment: -0.6 });
    const result = generateTradingSignal(inputs);
    const ns = result.components.find((c) => c.name === 'News Sentiment');
    assert.ok(ns, 'News Sentiment component should be present when newsSentiment is set');
    assert.equal(ns.score, -0.6);
    // No recentPrices => choppy regime => News Sentiment weight is halved.
    assert.equal(ns.weight, 0.025);
    assert.equal(ns.reason, 'Negative news sentiment');
  });

  it('produces a positive News Sentiment component when newsSentiment > 0.3', () => {
    const inputs = baseInputs({ newsSentiment: 0.7 });
    const result = generateTradingSignal(inputs);
    const ns = result.components.find((c) => c.name === 'News Sentiment');
    assert.ok(ns);
    assert.equal(ns.score, 0.6);
    assert.equal(ns.reason, 'Positive news sentiment');
  });

  it('produces a neutral News Sentiment component when newsSentiment is in [-0.3, 0.3]', () => {
    const inputs = baseInputs({ newsSentiment: 0.1 });
    const result = generateTradingSignal(inputs);
    const ns = result.components.find((c) => c.name === 'News Sentiment');
    assert.ok(ns);
    assert.equal(ns.score, 0);
    assert.equal(ns.reason, 'Neutral news sentiment');
  });

  it('does not include a News Sentiment component when newsSentiment is null', () => {
    const inputs = baseInputs({ newsSentiment: null });
    const result = generateTradingSignal(inputs);
    const ns = result.components.find((c) => c.name === 'News Sentiment');
    assert.equal(ns, undefined);
  });

  it('reduces the score when newsSentiment is negative', () => {
    // Provide enough strong components so both inputs clear the confluence
    // gate. The only difference between the two is newsSentiment, so any
    // score gap must come from news sentiment.
    const shared = {
      recentPrices: decliningPrices(),
      fundingRate: -0.008,
      oiHistory: [100, 102, 105, 110, 115],
    };
    const neutral = baseInputs(shared);
    const negative = baseInputs({ ...shared, newsSentiment: -0.9 });

    // Warm up both to stabilize the debounce buffer for each input.
    for (let i = 0; i < 30; i++) {
      generateTradingSignal(neutral);
      generateTradingSignal(negative);
    }

    const neutralResult = generateTradingSignal(neutral);
    const negativeResult = generateTradingSignal(negative);

    assert.ok(
      negativeResult.score < neutralResult.score,
      `expected negative news to reduce score: neutral=${neutralResult.score}, negative=${negativeResult.score}`
    );
  });
});

// ---------------------------------------------------------------------------
// Regime Adjustment
// ---------------------------------------------------------------------------

describe('generateTradingSignal — Regime Adjustment', () => {
  it('reduces Range Breakout weight in a trending regime', () => {
    const prices: number[] = [];
    for (let i = 0; i < 30; i++) prices.push(100 + i * 0.5);
    const inputs = baseInputs({ recentPrices: prices });
    const result = generateTradingSignal(inputs);
    const rb = result.components.find((c) => c.name === 'Range Breakout');
    assert.ok(rb);
    assert.equal(rb!.weight, 0.07 * 0.5);
    assert.equal(result.regime, 'trending');
  });

  it('reduces momentum and drift weights in a ranging regime', () => {
    const prices: number[] = [];
    for (let i = 0; i < 30; i++) prices.push(100 + Math.sin(i) * 0.2);
    const inputs = baseInputs({ recentPrices: prices });
    const result = generateTradingSignal(inputs);
    const momentum = result.components.find((c) => c.name === 'Price Momentum');
    const drift = result.components.find((c) => c.name === 'Trend Drift');
    assert.ok(momentum);
    assert.ok(drift);
    assert.equal(momentum!.weight, 0.15 * 0.5);
    assert.equal(drift!.weight, 0.11 * 0.5);
    assert.equal(result.regime, 'ranging');
  });
});

// ---------------------------------------------------------------------------
// Confluence Gate
// ---------------------------------------------------------------------------

describe('generateTradingSignal — Confluence Gate', () => {
  it('forces NEUTRAL when fewer than 3 components are strong', () => {
    const inputs = baseInputs({
      recentPrices: decliningPrices(),
      newsSentiment: -0.1,
    });
    warmUp(inputs);
    const result = generateTradingSignal(inputs);
    assert.equal(result.overallSignal, 'NEUTRAL');
    assert.equal(result.confidence, 0);
    // Exactly two strong components (Price Momentum + Trend Drift) — below
    // the MIN_CONFLUENCE_COMPONENTS threshold of 3.
    assert.ok(
      (result.confluenceCount ?? 0) < 3,
      `expected confluenceCount < 3, got ${result.confluenceCount}`
    );
  });

  it('allows a directional signal when 3+ components are strong', () => {
    // Every component points bearish so the weighted score is unambiguously
    // negative (heavy short liquidations = blow-off top = bearish).
    const inputs: SignalInputs = {
      liquidationStats: {
        totalLongLiquidations: 0,
        totalShortLiquidations: 100,
        totalLongUsd: 0,
        totalShortUsd: 1_000_000,
        largestLiquidation: null,
      },
      longShortRatio: 1.8, // extreme long bias -> contrarian bearish
      mempoolTxCount: null,
      fastestFee: null,
      whaleTransactions: [],
      hashrateTrend: 'DOWN',
      fundingRate: 0.008, // high positive funding -> bearish
      recentPrices: decliningPrices(),
      oiHistory: [100, 102, 105, 110, 115],
      newsSentiment: -0.9,
    };
    warmUp(inputs);
    const result = generateTradingSignal(inputs);
    assert.ok(
      result.overallSignal === 'SELL' || result.overallSignal === 'STRONG SELL',
      `expected SELL/STRONG SELL, got ${result.overallSignal}`
    );
    assert.ok((result.confluenceCount ?? 0) >= 3);
  });

  it('returns NEUTRAL without adding stale critical data to a tradable signal', () => {
    const now = Date.now();
    const inputs = baseInputs({
      recentPrices: decliningPrices(),
      dataQuality: buildSignalDataQuality({
        price: now - 31_000,
        market: now,
        mempool: null,
        hashrate: null,
        whales: null,
        news: null,
      }, now),
    });
    const result = generateTradingSignal(inputs);
    assert.equal(result.overallSignal, 'NEUTRAL');
    assert.equal(result.confidence, 0);
    assert.equal(result.dataQuality?.isReady, false);
  });
});

// ---------------------------------------------------------------------------
// Weights and confidence
// ---------------------------------------------------------------------------

describe('generateTradingSignal — weights and confidence', () => {
  it('weight sum stays at or below 1.0 after regime adjustments', () => {
    // Build inputs that activate every component so the weight sum reflects
    // the full configured table. Components and weights:
    //   Liquidation 0.15 + L/S Ratio 0.11 + Price Momentum 0.15
    // + Funding 0.11 + OI Delta 0.08 + Mempool 0.05 + Fee 0.05
    // + Whale 0.05 + Hashrate 0.02 + Trend Drift 0.11
    // + Range Breakout 0.07 + News Sentiment 0.05 = 1.00
    // Regime adjustment may reduce some weights (but never below their
    // base value), so the sum should be in [0, 1.0].
    const prices = decliningPrices();
    const inputs = baseInputs({
      liquidationStats: {
        totalLongLiquidations: 5,
        totalShortLiquidations: 5,
        totalLongUsd: 500,
        totalShortUsd: 500,
        largestLiquidation: null,
      },
      longShortRatio: 1.0,
      mempoolTxCount: 50_000,
      fastestFee: 50,
      whaleTransactions: [makeWhale('INFLOW', 100), makeWhale('OUTFLOW', 100)],
      hashrateTrend: 'FLAT',
      fundingRate: 0.0,
      recentPrices: prices,
      oiHistory: [100, 101, 102, 103, 104],
      newsSentiment: 0.0,
    });

    const result = generateTradingSignal(inputs);
    const sum = result.components.reduce((s, c) => s + c.weight, 0);
    assert.ok(
      sum <= 1.0 + 1e-9,
      `expected weight sum <= 1.00, got ${sum}`
    );
    assert.ok(
      sum > 0.5,
      `expected weight sum > 0.5 (most components should still be active), got ${sum}`
    );
  });

  it('confidence stays between 0 and 100 across a range of inputs', () => {
    const cases: SignalInputs[] = [
      baseInputs(),
      baseInputs({ recentPrices: decliningPrices() }),
      baseInputs({ recentPrices: decliningPrices(), newsSentiment: -0.9 }),
      baseInputs({ recentPrices: decliningPrices(), newsSentiment: 0.9 }),
      baseInputs({
        liquidationStats: {
          totalLongLiquidations: 100,
          totalShortLiquidations: 0,
          totalLongUsd: 1_000_000,
          totalShortUsd: 0,
          largestLiquidation: null,
        },
        fundingRate: -0.008,
        longShortRatio: 0.5,
      }),
    ];

    for (const inputs of cases) {
      warmUp(inputs);
      const result = generateTradingSignal(inputs);
      assert.ok(
        result.confidence >= 0 && result.confidence <= 100,
        `confidence out of range for inputs: ${result.confidence}`
      );
    }
  });
});
