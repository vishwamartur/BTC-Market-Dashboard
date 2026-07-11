# Review: BTCUSD Drift & News Sentiment Implementation

## Verdict: NEEDS_FIXES

The implementation covers most of the plan and the v2 bot layer is well tested, but there are material deviations in the dashboard signal layer: component weights do not sum to 1.0, trend/sentiment scores are not exposed on `/api/signal` (so the v2 drift-enhanced hedge cannot receive them), the global debounce buffer makes the signal engine hard to test, and the required `newsSentiment.test.ts` unit tests are missing.

## Issues

### 1. Signal component weights sum to 1.10 instead of 1.00
**File:** `app/lib/signals.ts` (component weights at lines 31, 52, 75, 98, 123, 156, 170, 188, 205, 226, 254, 278)

The plan explicitly lists final weights that total 1.00:
- Liquidation 0.15, L/S Ratio 0.11, Price Momentum 0.15, Funding 0.11, OI Delta 0.08, Mempool 0.05, Fee 0.05, Whale 0.09, Hashrate 0.04, Trend Drift 0.11, Range Breakout 0.07, News Sentiment 0.09.

The implemented weights are:
- Liquidation 0.15, L/S Ratio 0.11, Price Momentum 0.15, Funding 0.11, OI Delta 0.08, Mempool 0.05, Fee 0.05, Whale 0.09, Hashrate 0.04, Trend Drift 0.11, Range Breakout 0.07, News Sentiment 0.09.

Sum = 1.10.

Because `signalCoverage = totalWeight` contributes 40% to confidence, the coverage term is inflated by 10%. The weighted score is normalized by `totalWeight`, so the directional score is correct, but the confidence formula does not match the spec and `confidence` can be pushed toward the 100 cap faster than intended.

**Suggested fix:** Rebalance weights so they total 1.00 per the plan (e.g., reduce each component proportionally or adopt the exact final values in the plan). Update `app/lib/signals.test.ts` to assert `sum === 1.0` instead of 1.10.

### 2. Dashboard `/api/signal` does not expose `trendDrift`, `rangeBreakout`, or `newsSentiment`
**File:** `app/api/signal/route.ts` (line 11 returns `...signal`)
**File:** `app/lib/signals.ts` (`SignalResult` interface does not include these fields)

`v2/src/signalFetcher.ts` parses `raw.trendDrift`, `raw.rangeBreakout`, and `raw.newsSentiment` from the dashboard response, but the dashboard endpoint only returns `SignalResult`, which contains `overallSignal`, `confidence`, `score`, `components`, and `timestamp`. As a result, the v2 bot always receives `undefined` for these fields.

This breaks the Chunk 4 drift-enhanced hedge: `riskManager.shouldTrade` checks `signal.trendDrift < -0.2`, but the field is never populated, so the 1.5× hedge multiplier never activates.

**Suggested fix:** Either add `trendDrift`, `rangeBreakout`, and `newsSentiment` to `SignalResult` in `app/lib/signals.ts` and populate them in `generateTradingSignal`, or have `app/api/signal/route.ts` extract them from the `components` array before returning JSON. Ensure backward compatibility by keeping the fields optional.

### 3. Missing unit tests for `app/lib/newsSentiment.ts`
**File:** `app/lib/newsSentiment.ts` (new)

The plan's Test Strategy table and Chunk 3 acceptance criteria require `app/lib/newsSentiment.test.ts` with mocked fetch responses covering bullish, bearish, mixed, and empty feeds. The file does not exist.

**Suggested fix:** Add `app/lib/newsSentiment.test.ts` that stubs `setFetcher`, calls `pollOnce()`, and asserts sentiment scores and snapshot shapes for:
- a bullish RSS feed,
- a bearish RSS feed,
- a mixed feed,
- an empty feed,
- items older than 30 minutes being ignored.

### 4. Module-level `signalHistory` causes cross-test contamination and non-determinism
**File:** `app/lib/signals.ts` (lines 37-38 and 303-322)

`signalHistory` is a module-level array shared across all calls to `generateTradingSignal`. The smoothing step means the returned `score` depends on the last 20 calls, so tests (and production callers) are not isolated. `signals.test.ts` attempts to "warm up" the buffer, but the buffer is global and tests can still influence each other depending on execution order.

**Suggested fix:** Move `signalHistory` into `SignalEngine` state (per instance) or make `generateTradingSignal` accept an optional history parameter. At minimum, expose a reset function for tests and call it in `beforeEach`.

### 5. DRY_RUN short-straddle entry does not record strike price or ATR
**File:** `v2/src/optionsManager.ts` (lines 194-198)
**File:** `v2/src/strategies/hedgeStrategy.ts` (lines 75-85)

`executeShortStraddle` returns `{ success: true, dryRun: true, entryNotional, expiryTime }` in DRY_RUN mode, omitting `callProduct`/`putProduct`. `hedgeStrategy.ts` then reads `hedgeRes.callProduct?.strike_price`, which is `undefined`, and records strike price as `0`. The code comment in `hedgeStrategy.ts` claims "dry-run result also has callProduct via straddle finder," which is incorrect.

With `hedgeStrikePrice = 0`, the delta-bleed exit is disabled for DRY_RUN entries. While DRY_RUN is safe (it logs "would close" and resets state), the delta-bleed logic cannot be exercised in simulation, and the recorded metadata does not match the live path.

**Suggested fix:** Include `callProduct` and `putProduct` in the DRY_RUN return value of `executeShortStraddle`, or compute the strike from the already-fetched `straddle.call` before returning.

### 6. `fetchAtr` fallback is a fixed 2% proxy rather than computed from OHLC
**File:** `v2/src/signalFetcher.ts` (lines 64-94)

The plan says: "compute a simple ATR proxy in signalFetcher.ts from the dashboard market cache if it exposes high/low/close; if not, fetch recent prices from /api/market and compute ATR from stored OHLC or return currentPrice * 0.02 as fallback." The implementation only checks for explicit `atr14`/`atr`/`ATR` fields and then falls back directly to `currentPrice * 0.02`. It does not attempt to read OHLC from `/api/market` or compute a proxy from highs/lows/closes.

**Suggested fix:** If the dashboard exposes OHLC history in `/api/market`, compute a simple average true range from it; otherwise document that the 2% proxy is intentional. This is lower priority than issues 1-5.

### 7. Strategy interface discourages direct state mutation, but hedge strategy mutates state
**File:** `v2/src/strategies/Strategy.ts` (line 15 comment)
**File:** `v2/src/strategies/hedgeStrategy.ts` (lines 80-85)

`Strategy.ts` states strategies should "NEVER mutate state directly," yet `hedgeStrategy.execute` calls `recordHedgeEntry(state, ...)` which mutates `state` directly. This is an architectural inconsistency introduced with the new hedge entry recording.

**Suggested fix:** Either update the strategy interface comment to permit state mutation for hedge metadata, or return the entry metadata in `StrategyResult` and let the orchestrator update state. This is lower priority than correctness issues 1-5.

## Verification Results

1. `cd /Users/vishwa/Desktop/BTC-Market-Dashboard/btcusd-dashboard/v2 && npm run build`
   - Result: PASS (`tsc` completed with no errors)

2. `cd /Users/vishwa/Desktop/BTC-Market-Dashboard/btcusd-dashboard/v2 && npm test`
   - Result: PASS (25 tests across 3 files)

3. `cd /Users/vishwa/Desktop/BTC-Market-Dashboard/btcusd-dashboard && npx tsc --noEmit`
   - Result: FAIL (5 errors, all in `app/hooks/usePriceArbitrage.ts`)
   - These errors are in a file not modified by this change and are documented as a pre-existing issue, so they are out of scope.

4. `cd /Users/vishwa/Desktop/BTC-Market-Dashboard/btcusd-dashboard && npx tsx --test app/lib/indicators.test.ts`
   - Result: PASS (25 tests)

5. `cd /Users/vishwa/Desktop/BTC-Market-Dashboard/btcusd-dashboard && npx tsx --test app/lib/signals.test.ts`
   - Result: PASS (15 tests), but note that the weight-sum test asserts the incorrect total of 1.10 instead of 1.00.

## Summary

- v2 bot changes (state, options manager, signal fetcher, risk manager, hedge strategy) are implemented and tested correctly.
- Dashboard indicator and signal tests pass.
- The main blockers are in the dashboard signal layer: incorrect weight normalization, missing API exposure of trend/sentiment fields, missing news sentiment unit tests, and the global signal history buffer.
