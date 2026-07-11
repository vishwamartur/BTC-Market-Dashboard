# Design: Pragmatic Signal-Quality Improvements

> **Disclaimer:** This is educational software. Nothing here guarantees trading profits or constitutes financial advice. Always use paper trading before deploying real capital.

## Goal
Reduce false-positive trading signals in the BTCUSD dashboard by adding (1) market-regime detection, (2) a confluence gate, and (3) a lightweight weight-optimization script.

## Background
The current signal engine (`app/lib/signals.ts`) combines 12 hand-tuned components into a single `STRONG BUY` / `BUY` / `NEUTRAL` / `SELL` / `STRONG SELL` signal. The v2 auto-trader (`v2/src/orchestrator.ts`) routes this signal to futures, hedge, or funding strategies. The goal is to make the signal more selective so the bot trades less often but with higher expected quality.

## Design

### 1. Market Regime Detection
- Add `detectMarketRegime(prices: number[]): 'trending' | 'ranging' | 'choppy'` in `app/lib/indicators.ts`.
- Use linear-regression slope and Bollinger bandwidth over the last N price points.
- In `generateTradingSignal()`:
  - Detect regime from `recentPrices`.
  - Down-weight components that are misaligned with the regime:
    - `trending`: reduce `Range Breakout` weight.
    - `ranging`: reduce `Price Momentum` and `Trend Drift` weights.
    - `choppy`: reduce `Price Momentum`, `Trend Drift`, and `Range Breakout` weights; raise threshold for `News Sentiment`.
- Persist regime in `SignalResult` so downstream consumers (v2 trader, UI) can use it.

### 2. Confluence Gate
- In `generateTradingSignal()`, after all components are computed, count how many components have `|score| >= MIN_COMPONENT_SCORE` (default 0.3).
- If the count is below `MIN_CONFLUENCE_COMPONENTS` (default 3), force the final signal to `NEUTRAL` and set `confidence = 0`.
- Expose `MIN_COMPONENT_SCORE` and `MIN_CONFLUENCE_COMPONENTS` as configurable constants at the top of `signals.ts`.
- Update `SignalResult` to include `confluenceCount` and the effective thresholds.
- Update `v2/src/riskManager.ts` so `shouldTrade()` rejects any signal whose `confluenceCount` is below the minimum.

### 3. Weight Optimization Script
- Create `scripts/optimizeSignalWeights.ts`.
- Reads the last 7 days of liquidation events from MongoDB (`liquidations` collection) plus current market data.
- Replays synthetic signal generation over a small grid of weight variations for the highest-impact components (`Price Momentum`, `Funding Rate`, `Liquidation Imbalance`, `Long/Short Ratio`, `OI Delta`, `Trend Drift`).
- For each weight set, computes a directional accuracy score: did the signal direction predict the next 1-hour price move correctly?
- Prints the best-performing weight set and a markdown report to stdout so the user can paste the values into `signals.ts`.
- Runs with `npx tsx scripts/optimizeSignalWeights.ts`.

## Files to Modify / Create
- `app/lib/indicators.ts` — add `detectMarketRegime()`.
- `app/lib/signals.ts` — integrate regime adjustment, confluence gate, new result fields.
- `app/lib/signalEngine.ts` — pass `recentPrices` into `SignalInputs` (already done), ensure regime is exposed in API response.
- `v2/src/riskManager.ts` — reject signals with insufficient confluence.
- `v2/src/types.ts` — add `confluenceCount` to signal-related types if needed.
- `app/api/signal/route.ts` — include `confluenceCount` and `regime` in JSON response.
- `scripts/optimizeSignalWeights.ts` — new optimization CLI.
- `app/lib/indicators.test.ts` — add regime detection tests.
- `app/lib/signals.test.ts` — add confluence gate tests.

## Acceptance Criteria
- `detectMarketRegime()` returns one of `trending`/`ranging`/`choppy` for valid price arrays.
- `generateTradingSignal()` forces `NEUTRAL` when fewer than 3 components exceed the score threshold.
- `shouldTrade()` returns `{ action: null, size: 0 }` for signals that fail the confluence gate.
- `scripts/optimizeSignalWeights.ts` runs without errors and prints a weight grid result.
- All existing tests pass; new tests cover regime detection and confluence gate.
