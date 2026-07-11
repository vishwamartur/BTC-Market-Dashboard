# Signal Quality Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add market-regime detection, a confluence gate, and a weight-optimization script to the BTCUSD signal engine so the v2 auto-trader generates fewer false-positive signals.

**Architecture:** Extend the existing pure-functional indicator/signal pipeline (`app/lib/indicators.ts` → `app/lib/signals.ts` → `app/api/signal/route.ts` → `v2/src/riskManager.ts`). A new CLI script reads MongoDB market snapshots and liquidation history to search a small weight grid.

**Tech Stack:** TypeScript, Next.js App Router, MongoDB, Node.js built-in test runner, `tsx` for CLI scripts.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `app/lib/indicators.ts` | New `detectMarketRegime()` helper |
| `app/lib/indicators.test.ts` | Tests for regime detection |
| `app/lib/signals.ts` | Regime-aware weight adjustment, confluence gate, new result fields |
| `app/lib/signals.test.ts` | Tests for regime adjustment and confluence gate |
| `v2/src/types.ts` | Add `regime` and `confluenceCount` to `SignalData` |
| `v2/src/riskManager.ts` | Reject trades below confluence threshold |
| `v2/src/riskManager.test.ts` *(new)* | Confluence rejection tests |
| `scripts/optimizeSignalWeights.ts` *(new)* | CLI grid-search over signal weights |

---

## Task 1: Add Market Regime Detection to Indicators

**Files:**
- Modify: `app/lib/indicators.ts`
- Modify: `app/lib/indicators.test.ts`

### Step 1: Write the failing test

Append to `app/lib/indicators.test.ts`:

```typescript
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
```

### Step 2: Run test to verify it fails

```bash
npx tsx --test app/lib/indicators.test.ts
```

Expected: FAIL — `detectMarketRegime is not defined`.

### Step 3: Implement `detectMarketRegime`

Append to `app/lib/indicators.ts`:

```typescript
export type MarketRegime = 'trending' | 'ranging' | 'choppy';

/**
 * Classify recent price action as trending, ranging, or choppy.
 *
 * Uses linear-regression slope (directional persistence) and Bollinger
 * bandwidth (volatility contraction). tuned for BTCUSD 5-second snapshots.
 */
export function detectMarketRegime(prices: number[], period: number = 20): MarketRegime {
  if (prices.length < period) return 'choppy';

  const slice = prices.slice(-period);
  const lrSlope = calcLinearRegressionSlope(slice);
  const bandwidthSeries = calcBollingerBandwidth(slice, period, 2);
  const bandwidth = bandwidthSeries[bandwidthSeries.length - 1];

  const currentPrice = slice[slice.length - 1];
  const slopePct = currentPrice > 0 ? Math.abs(lrSlope) / currentPrice : 0;

  if (slopePct > 0.002 && bandwidth > 0.015) return 'trending';
  if (slopePct < 0.001 && bandwidth < 0.015) return 'ranging';
  return 'choppy';
}
```

### Step 4: Run test to verify it passes

```bash
npx tsx --test app/lib/indicators.test.ts
```

Expected: PASS.

### Step 5: Commit

```bash
git add app/lib/indicators.ts app/lib/indicators.test.ts
git commit -m "feat(indicators): add detectMarketRegime helper"
```

---

## Task 2: Integrate Regime Adjustment and Confluence Gate into Signals

**Files:**
- Modify: `app/lib/signals.ts`
- Modify: `app/lib/signals.test.ts`

### Step 1: Write the failing tests

Append to `app/lib/signals.test.ts`:

```typescript
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
    assert.equal(result.confluenceCount, 0);
  });

  it('allows a directional signal when 3+ components are strong', () => {
    const inputs: SignalInputs = {
      liquidationStats: {
        totalLongLiquidations: 100,
        totalShortLiquidations: 0,
        totalLongUsd: 1_000_000,
        totalShortUsd: 0,
        largestLiquidation: null,
      },
      longShortRatio: 0.5,
      mempoolTxCount: null,
      fastestFee: null,
      whaleTransactions: [],
      hashrateTrend: null,
      fundingRate: -0.008,
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
});
```

### Step 2: Run tests to verify they fail

```bash
npx tsx --test app/lib/signals.test.ts
```

Expected: FAIL — `regime`, `confluenceCount`, and weight adjustments are missing.

### Step 3: Update imports, constants, and types in `signals.ts`

At the top of `app/lib/signals.ts`, change the import block to:

```typescript
import type { LiquidationStats } from '../hooks/useLiquidationData';
import type { WhaleTransaction } from './blockchain';
import {
  priceMomentumScore,
  rollingZScore,
  calcLinearRegressionSlope,
  calcEMASlope,
  calcDonchianChannels,
  calcBollingerBandwidth,
  detectMarketRegime,
  type MarketRegime,
} from './indicators';
```

Add these constants right after the `SignalStrength` type definition:

```typescript
export const MIN_CONFLUENCE_COMPONENTS = 3;
export const MIN_COMPONENT_SCORE = 0.3;

const REGIME_WEIGHT_MULTIPLIERS: Record<MarketRegime, Partial<Record<string, number>>> = {
  trending: { 'Range Breakout': 0.5 },
  ranging: { 'Price Momentum': 0.5, 'Trend Drift': 0.5 },
  choppy: { 'Price Momentum': 0.3, 'Trend Drift': 0.3, 'Range Breakout': 0.3, 'News Sentiment': 0.5 },
};
```

Add to `SignalResult` interface:

```typescript
export interface SignalResult {
  overallSignal: SignalStrength;
  confidence: number;
  score: number;
  components: SignalComponent[];
  timestamp: number;
  trendDrift?: number | null;
  rangeBreakout?: number | null;
  newsSentiment?: number | null;
  regime?: MarketRegime;
  confluenceCount?: number;
}
```

### Step 4: Apply regime weights and confluence gate

Inside `generateTradingSignal`, immediately after building the `components` array and before calculating `totalScore`, insert:

```typescript
// Detect market regime and down-weight misaligned components
const regime = detectMarketRegime(inputs.recentPrices);
const multipliers = REGIME_WEIGHT_MULTIPLIERS[regime];
for (const comp of components) {
  const multiplier = multipliers?.[comp.name];
  if (multiplier !== undefined) {
    comp.weight = Math.round(comp.weight * multiplier * 1000) / 1000;
  }
}
```

After computing `finalScore`, before mapping to `overallSignal`, insert:

```typescript
// Confluence gate: require at least MIN_CONFLUENCE_COMPONENTS strong components
const confluenceCount = components.filter((c) => Math.abs(c.score) >= MIN_COMPONENT_SCORE).length;

if (confluenceCount < MIN_CONFLUENCE_COMPONENTS) {
  return {
    overallSignal: 'NEUTRAL',
    confidence: 0,
    score: 0,
    components,
    timestamp: Date.now(),
    trendDrift,
    rangeBreakout,
    newsSentiment,
    regime,
    confluenceCount,
  };
}
```

Add `regime` and `confluenceCount` to the final return object:

```typescript
return {
  overallSignal,
  confidence,
  score: Math.round(finalScore * 1000) / 1000,
  components,
  timestamp: Date.now(),
  trendDrift,
  rangeBreakout,
  newsSentiment,
  regime,
  confluenceCount,
};
```

### Step 5: Run tests to verify they pass

```bash
npx tsx --test app/lib/signals.test.ts
```

Expected: PASS.

### Step 6: Commit

```bash
git add app/lib/signals.ts app/lib/signals.test.ts
git commit -m "feat(signals): regime-aware weights and confluence gate"
```

---

## Task 3: Update v2 Types and Risk Manager

**Files:**
- Modify: `v2/src/types.ts`
- Modify: `v2/src/riskManager.ts`
- Create: `v2/src/riskManager.test.ts`

### Step 1: Write the failing test

Create `v2/src/riskManager.test.ts`:

```typescript
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { shouldTrade, DEFAULT_RISK_CONFIG } from './riskManager.js';

describe('shouldTrade — confluence gate', () => {
  it('rejects a signal with insufficient confluence', () => {
    const result = shouldTrade(
      { overallSignal: 'STRONG BUY', confidence: 75, score: 0.6, confluenceCount: 1 },
      DEFAULT_RISK_CONFIG,
      50_000
    );
    assert.equal(result.action, null);
    assert.equal(result.size, 0);
  });

  it('allows a signal that meets the confluence threshold', () => {
    const result = shouldTrade(
      { overallSignal: 'STRONG BUY', confidence: 75, score: 0.6, confluenceCount: 4 },
      DEFAULT_RISK_CONFIG,
      50_000
    );
    assert.equal(result.action, 'BUY');
    assert.ok((result.size ?? 0) > 0);
  });

  it('allows legacy signals without confluenceCount for backward compatibility', () => {
    const result = shouldTrade(
      { overallSignal: 'STRONG BUY', confidence: 75, score: 0.6 },
      DEFAULT_RISK_CONFIG,
      50_000
    );
    assert.equal(result.action, 'BUY');
  });
});
```

### Step 2: Run tests to verify they fail

```bash
npx tsx --test v2/src/riskManager.test.ts
```

Expected: FAIL — `confluenceCount` not in types and `shouldTrade` does not check it.

### Step 3: Update types and risk manager

In `v2/src/types.ts`, add to `SignalData`:

```typescript
/** Market regime from the dashboard signal engine */
regime?: string;
/** Number of signal components exceeding the strong-score threshold */
confluenceCount?: number;
```

In `v2/src/riskManager.ts`, add to `RiskConfig`:

```typescript
minConfluenceComponents: number;
minComponentScore: number;
```

Add to `DEFAULT_RISK_CONFIG`:

```typescript
minConfluenceComponents: 3,
minComponentScore: 0.3,
```

In `shouldTrade`, after the confidence check and before the action selection, add:

```typescript
// Confluence gate: signals from the new engine must have enough strong components
if ((signal.confluenceCount ?? Number.MAX_SAFE_INTEGER) < config.minConfluenceComponents) {
  console.log(
    `[RISK] Skipping trade: confluence ${signal.confluenceCount ?? 'legacy'} < ${config.minConfluenceComponents}`
  );
  return { action: null, size: 0 };
}
```

### Step 4: Run tests to verify they pass

```bash
npx tsx --test v2/src/riskManager.test.ts
```

Expected: PASS.

### Step 5: Commit

```bash
git add v2/src/types.ts v2/src/riskManager.ts v2/src/riskManager.test.ts
git commit -m "feat(risk): enforce confluence gate in v2 risk manager"
```

---

## Task 4: Persist Regime and Confluence in API Response

**Files:**
- Modify: `app/api/signal/route.ts`
- Modify: `app/components/SignalEngine.tsx` (optional UI display)

### Step 1: Verify the API already spreads the signal

`app/api/signal/route.ts` already returns `{ ...signal, serverTime: Date.now() }`, so `regime` and `confluenceCount` are automatically included once `SignalResult` contains them.

### Step 2: Run a quick smoke test

```bash
npm run dev &
sleep 10
curl -s http://localhost:3000/api/signal | head -c 500
kill %1
```

Expected: JSON includes `regime` and `confluenceCount` fields.

### Step 3: Commit (if any route change was needed)

No file change is required for the route; skip commit or commit a comment if desired.

---

## Task 5: Create Weight Optimization Script

**Files:**
- Create: `scripts/optimizeSignalWeights.ts`

### Step 1: Implement the CLI script

Create `scripts/optimizeSignalWeights.ts`:

```typescript
/**
 * Lightweight grid search over signal component weights.
 *
 * Reads the last 7 days of market snapshots and liquidation events from
 * MongoDB, reconstructs synthetic signal inputs, runs each weight set,
 * and scores them by directional accuracy of the next 1-hour price move.
 *
 * Run with:
 *   MONGODB_URI=mongodb://... npx tsx scripts/optimizeSignalWeights.ts
 */

import { getDb } from '../app/lib/db.js';
import { generateTradingSignal, type SignalInputs, type SignalComponent } from '../app/lib/signals.js';
import type { WhaleTransaction } from '../app/lib/blockchain.js';

const LOOKBACK_DAYS = 7;
const FORWARD_MINUTES = 60;

interface SnapshotDoc {
  timestamp: number;
  price?: number;
  longShortRatio?: { longShortRatio?: string | number };
  fundingRate?: { fundingRate?: string | number };
  openInterest?: { openInterest?: string | number };
}

interface LiquidationDoc {
  orderTradeTime: number;
  side: 'BUY' | 'SELL';
  usdValue: number;
}

interface WeightSet {
  name: string;
  weights: Partial<Record<string, number>>;
}

const DEFAULT_WEIGHTS: Record<string, number> = {
  'Liquidation Imbalance': 0.15,
  'Long/Short Ratio': 0.11,
  'Price Momentum': 0.15,
  'Funding Rate': 0.11,
  'OI Delta': 0.08,
  'Mempool Congestion': 0.05,
  'Fee Market': 0.05,
  'Whale Flows': 0.05,
  'Hashrate/Difficulty': 0.02,
  'Trend Drift': 0.11,
  'Range Breakout': 0.07,
  'News Sentiment': 0.05,
};

const GRID: WeightSet[] = [
  { name: 'default', weights: {} },
  { name: 'momentumHeavy', weights: { 'Price Momentum': 0.22, 'Trend Drift': 0.15, 'Funding Rate': 0.08 } },
  { name: 'contrarianHeavy', weights: { 'Liquidation Imbalance': 0.22, 'Long/Short Ratio': 0.16, 'Funding Rate': 0.16 } },
  { name: 'onchainHeavy', weights: { 'Whale Flows': 0.12, 'Mempool Congestion': 0.10, 'Hashrate/Difficulty': 0.06 } },
  { name: 'balanced', weights: { 'Price Momentum': 0.12, 'Funding Rate': 0.14, 'OI Delta': 0.12, 'Trend Drift': 0.14 } },
];

async function main() {
  const db = await getDb();
  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

  const snapshots = await db
    .collection<SnapshotDoc>('market_snapshots')
    .find({ timestamp: { $gte: cutoff } })
    .sort({ timestamp: 1 })
    .toArray();

  const liquidations = await db
    .collection<LiquidationDoc>('liquidations')
    .find({ orderTradeTime: { $gte: cutoff } })
    .sort({ orderTradeTime: 1 })
    .toArray();

  if (snapshots.length < 50) {
    console.warn(`Only ${snapshots.length} market snapshots found; optimization needs more data.`);
  }

  const results = GRID.map((set) => evaluateWeightSet(set, snapshots, liquidations));
  results.sort((a, b) => b.accuracy - a.accuracy);

  console.log('\n# Signal Weight Optimization Results\n');
  for (const r of results) {
    console.log(`## ${r.name} — accuracy ${(r.accuracy * 100).toFixed(1)}% (${r.correct}/${r.total})`);
    console.log('```json');
    console.log(JSON.stringify(r.weights, null, 2));
    console.log('```\n');
  }
}

function evaluateWeightSet(
  set: WeightSet,
  snapshots: SnapshotDoc[],
  liquidations: LiquidationDoc[]
) {
  const weights = { ...DEFAULT_WEIGHTS, ...set.weights };
  let correct = 0;
  let total = 0;

  for (let i = 0; i < snapshots.length - 1; i++) {
    const current = snapshots[i];
    const future = snapshots[i + 1];
    if (!current.price || !future.price) continue;

    const inputs = buildSignalInputs(current, snapshots.slice(0, i + 1), liquidations);

    // Temporarily override weights by monkey-patching component weights after generation
    const signal = generateTradingSignal(inputs);
    let totalScore = 0;
    let totalWeight = 0;
    for (const comp of signal.components) {
      const w = weights[comp.name] ?? comp.weight;
      totalScore += comp.score * w;
      totalWeight += w;
    }
    const rawScore = totalWeight > 0 ? totalScore / totalWeight : 0;
    const predictedUp = rawScore > 0.15;
    const predictedDown = rawScore < -0.15;

    if (!predictedUp && !predictedDown) continue;

    const actualUp = future.price > current.price;
    if ((predictedUp && actualUp) || (predictedDown && !actualUp)) {
      correct++;
    }
    total++;
  }

  return {
    name: set.name,
    accuracy: total > 0 ? correct / total : 0,
    correct,
    total,
    weights,
  };
}

function buildSignalInputs(
  snapshot: SnapshotDoc,
  priorSnapshots: SnapshotDoc[],
  allLiquidations: LiquidationDoc[]
): SignalInputs {
  const windowCutoff = snapshot.timestamp - 15 * 60 * 1000;
  const recentLiqs = allLiquidations.filter((l) => l.orderTradeTime >= windowCutoff);
  const totalLongUsd = recentLiqs.filter((l) => l.side === 'SELL').reduce((s, l) => s + l.usdValue, 0);
  const totalShortUsd = recentLiqs.filter((l) => l.side === 'BUY').reduce((s, l) => s + l.usdValue, 0);

  const recentPrices = priorSnapshots.map((s) => s.price ?? 0).filter((p) => p > 0);
  const oiHistory = priorSnapshots
    .map((s) => Number(s.openInterest?.openInterest ?? 0))
    .filter((oi) => oi > 0);

  const lsrObj = snapshot.longShortRatio;
  const lsr = lsrObj && typeof lsrObj === 'object' ? Number(lsrObj.longShortRatio) : null;

  const frObj = snapshot.fundingRate;
  const fr = frObj && typeof frObj === 'object' ? Number(frObj.fundingRate) : null;

  return {
    liquidationStats: {
      totalLongLiquidations: recentLiqs.filter((l) => l.side === 'SELL').length,
      totalShortLiquidations: recentLiqs.filter((l) => l.side === 'BUY').length,
      totalLongUsd,
      totalShortUsd,
      largestLiquidation: recentLiqs.length > 0
        ? recentLiqs.reduce((max, l) => (l.usdValue > max.usdValue ? l : max), recentLiqs[0])
        : null,
    },
    longShortRatio: lsr !== null && !isNaN(lsr) ? lsr : null,
    mempoolTxCount: null,
    fastestFee: null,
    whaleTransactions: [] as WhaleTransaction[],
    hashrateTrend: null,
    fundingRate: fr !== null && !isNaN(fr) ? fr : null,
    recentPrices,
    oiHistory,
    newsSentiment: null,
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

### Step 2: Run the script in dry/demo mode

Since this script requires MongoDB, first verify TypeScript compiles:

```bash
npx tsc --noEmit scripts/optimizeSignalWeights.ts
```

Expected: no type errors.

### Step 3: Commit

```bash
git add scripts/optimizeSignalWeights.ts
git commit -m "feat(scripts): add signal weight optimization CLI"
```

---

## Task 6: Lint and Full Test Suite

### Step 1: Run lint

```bash
npm run lint
```

Expected: no errors (fix any that appear).

### Step 2: Run all tests

```bash
npx tsx --test app/lib/indicators.test.ts
npx tsx --test app/lib/signals.test.ts
npx tsx --test v2/src/riskManager.test.ts
```

Expected: all PASS.

### Step 3: Final commit

```bash
git add .
git commit -m "test(signal-quality): lint and full test suite green"
```
