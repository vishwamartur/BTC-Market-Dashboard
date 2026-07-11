# Plan: BTCUSD Slow-Downtrend & Real-Time News Awareness

## Problem Statement

The current system does not detect BTCUSD **slowly drifting down out of the hedge position's range**. The signal engine's only price component is `priceMomentumScore` (EMA8 vs EMA21), which is insensitive to gradual, low-volatility declines where both EMAs move together. The options hedge (short ATM straddle) is delta-neutral at entry, but becomes increasingly directional as spot moves away from the strike; the bot has no exit rule based on price distance from the hedge strike.

There is also **no news/sentiment input**. Real-time news can precede or accelerate slow trends, and the signal engine currently ignores it.

## Goals

1. Detect slow BTCUSD downtrends / drift and range breakouts in the signal engine.
2. Add a delta-bleed / range exit to the v2 options hedge so the bot closes or rolls when spot moves too far from the hedge strike.
3. Add a real-time news-sentiment feed and integrate it as a signal component.
4. Keep changes backward-compatible and well-tested.

## Architecture

```
Dashboard (Next.js)                              v2 Bot
─────────────────────────────────────            ──────────────────────────
app/lib/wsManager.ts (price WS)                  src/signalFetcher.ts
  │                                                  │
  ▼                                                  ▼
app/lib/signalEngine.ts ──computeSignal()──►  GET /api/signal
  │                                               (SignalData)
  ├─ app/lib/indicators.ts (new trend fns)          │
  ├─ app/lib/signals.ts (new components)            ▼
  ├─ app/lib/newsSentiment.ts (new)              src/riskManager.ts
  │                                               src/optionsManager.ts
  ▼                                               (delta-bleed exit)
app/api/signal/route.ts
app/api/news/route.ts (new)
```

## Chunk 1 — Trend / Drift Indicators (simple)

**Files**
- `app/lib/indicators.ts` (modify)
- `app/lib/indicators.test.ts` (new)

**Add pure functions**
- `calcLinearRegressionSlope(prices: number[]): number` — least-squares slope of the full price array. Returns 0 if < 2 points.
- `calcEMASlope(prices: number[], period: number): number` — slope of the EMA line over the last `period` points, expressed as fractional change per candle: `(ema[last] - ema[first]) / ema[first]`.
- `calcDonchianChannels(prices: number[], period: number): { upper: number[]; lower: number[] }` — rolling high/low over `period`.
- `calcBollingerBandwidth(prices: number[], period?: number, stddev?: number): number[]` — `(upper - lower) / middle`, returns 0 when not enough data.

**Acceptance criteria**
- All four functions have unit tests covering: empty/small arrays, flat prices, rising prices, falling prices.
- `calcLinearRegressionSlope` of `[100, 101, 102, 103]` returns `1.0`.
- Existing `calcEMA`, `calcRSI`, `calcBollingerBands`, `calcATR`, `rollingZScore`, `priceMomentumScore` remain unchanged and all existing dashboard tests still pass.

## Chunk 2 — Drift / Breakout Signal Components (simple)

**Files**
- `app/lib/signals.ts` (modify)
- `app/lib/signals.test.ts` (new)

**Add to `SignalInputs`**
```ts
newsSentiment: number | null; // -1 to +1, null if unavailable
```
(Other new inputs come from existing `recentPrices` / `oiHistory`.)

**Add two new components in `generateTradingSignal`**
1. **Trend Drift** (weight 0.12)
   - Use `calcLinearRegressionSlope(recentPrices)` and `calcEMASlope(recentPrices, 21)`.
   - `driftScore = clamp((lrSlopePerPoint * 5) + (ema21Slope * 10), -1, 1)`
   - Reason text: e.g. "Slow downtrend detected (negative LR/EMA slope)" or "Slow uptrend detected" or "Price drifting sideways".
2. **Range Breakout** (weight 0.08)
   - Use `calcBollingerBandwidth` and `calcDonchianChannels`.
   - If bandwidth < 0.02 (squeeze) AND current price is within 0.5% of the Donchian lower band → score `-0.7` (downside breakout building).
   - If bandwidth < 0.02 AND price within 0.5% of upper band → `+0.7`.
   - Otherwise score `0` with reason "No clear range breakout".

**Weight rebalance**
Reduce existing components so total weight = 1.0:
- Liquidation Imbalance: 0.20 → 0.16
- Long/Short Ratio: 0.15 → 0.12
- Price Momentum: 0.20 → 0.16
- Funding Rate: 0.15 → 0.12
- OI Delta: 0.10 → 0.09
- Mempool: 0.05 → 0.05
- Fee Market: 0.05 → 0.05
- Whale Flows: 0.15 → 0.10
- Hashrate: 0.10 → 0.05
- **Trend Drift:** 0.12
- **Range Breakout:** 0.08
- **News Sentiment:** 0.10 (added in Chunk 3)
Total = 1.08 → adjust so total = 1.0. Use the final weights:
- Liquidation: 0.15
- L/S Ratio: 0.11
- Price Momentum: 0.15
- Funding: 0.11
- OI Delta: 0.08
- Mempool: 0.05
- Fee: 0.05
- Whale: 0.09
- Hashrate: 0.04
- Trend Drift: 0.11
- Range Breakout: 0.07
- News Sentiment: 0.09
Total = 1.00.

**Acceptance criteria**
- `generateTradingSignal` tests pass with mocked inputs covering strong downtrend, range squeeze/breakout, neutral conditions.
- News sentiment field is accepted as `null` without affecting output (actual scoring added in Chunk 3).
- Confidence calculation still uses `signalCoverage` and stays 0–100.

## Chunk 3 — Real-Time News Sentiment Module & API (simple)

**Files**
- `app/lib/newsSentiment.ts` (new)
- `app/lib/newsSentiment.test.ts` (new)
- `app/api/news/route.ts` (new)
- `app/lib/signalEngine.ts` (modify)
- `app/lib/signals.ts` (already modified in Chunk 2)

**Design**
- `NewsSentimentManager` singleton (similar pattern to `SignalEngine`).
- Fetches RSS/Atom from two public, CORS-friendly crypto news sources:
  - `https://cointelegraph.com/rss`
  - `https://coindesk.com/arc/outboundfeeds/rss/` (fallback)
- Poll interval: 60 seconds.
- Parses XML with native DOMParser (Node 20+) or regex fallback.
- For each item in the last 30 minutes:
  - Title + description lowercased.
  - Count bullish keywords (`rally`, `surge`, `bull`, `adoption`, `etf approval`, `breakthrough`) and bearish keywords (`crash`, `dump`, `bear`, `sec`, `lawsuit`, `hack`, `liquidation`, `recession`).
  - Sentiment per item = `(bullish - bearish) / max(bullish + bearish, 1)` in `[-1, 1]`.
- Aggregate sentiment = weighted average of recent items, more recent = higher weight.
- Expose `getLatestSentiment(): { score: number; timestamp: number; headline: string }`.
- `GET /api/news` returns the latest sentiment JSON.

**SignalEngine integration**
- In `computeSignal()`, call the news manager and inject `newsSentiment` into `SignalInputs`.
- Add new **News Sentiment** component in `generateTradingSignal` (weight 0.09):
  - If `score < -0.3` → score `-0.6`, reason "Negative news sentiment".
  - If `score > 0.3` → score `+0.6`, reason "Positive news sentiment".
  - Else score `0`.

**Acceptance criteria**
- Unit tests for `newsSentiment.ts` with mocked fetch responses covering bullish, bearish, mixed, and empty feeds.
- `/api/news` route returns JSON with `score`, `timestamp`, `headline`.
- `/api/signal` response now includes a `News Sentiment` component when sentiment is available.
- No new npm dependencies (use native fetch + DOMParser or regex fallback).

## Chunk 4 — v2 Hedge Range / Delta-Bleed Exit (complex)

**Files**
- `v2/src/types.ts` (modify)
- `v2/src/state.ts` (modify)
- `v2/src/strategies/hedgeStrategy.ts` (modify)
- `v2/src/optionsManager.ts` (modify)
- `v2/src/orchestrator.ts` (modify)
- `v2/src/signalFetcher.ts` (modify)
- `v2/src/optionsManager.test.ts` (new)

**Changes**
1. **Extend `SignalData`** in `v2/src/types.ts` to include optional trend/sentiment fields from the dashboard:
   ```ts
   export interface SignalData {
     overallSignal: string;
     confidence: number;
     score: number;
     components?: Array<{ name: string; score: number; weight: number; reason: string }>;
     trendDrift?: number;       // -1 to 1
     rangeBreakout?: number;    // -1 to 1
     newsSentiment?: number;    // -1 to 1
   }
   ```
2. **Extend `BotState`** in `v2/src/state.ts`:
   ```ts
   hedgeStrikePrice: number;
   hedgeEntryAtr: number;
   ```
   Update `createInitialState` to default both to `0`.
   Update `recordHedgeEntry` signature to accept `strikePrice` and `entryAtr` and store them.
   Update `resetHedgeState` to clear them.
3. **Record strike & ATR on hedge entry** in `v2/src/strategies/hedgeStrategy.ts`:
   - `executeShortStraddle` already returns `callProduct`/`putProduct`.
   - Extract `strikePrice = Number(hedgeRes.callProduct.strike_price)`.
   - Fetch ATR: add a new helper `fetchAtr(config): Promise<number>` in `signalFetcher.ts` that reads `/api/market` and returns `atr14` if present, else `0`.
   - For now, compute a simple ATR proxy in `signalFetcher.ts` from the dashboard market cache if it exposes high/low/close; if not, fetch recent prices from `/api/market` and compute ATR from stored OHLC or return `currentPrice * 0.02` as fallback.
   - Call `recordHedgeEntry(state, entryNotional, expiryTime, strikePrice, entryAtr)`.
4. **Delta-bleed exit in `v2/src/optionsManager.ts`**:
   - Add config:
     ```ts
     DELTA_BLEED_EXIT: {
       ATR_MULTIPLIER: 2.0,     // close if spot moved > 2× ATR from strike
       MIN_TIME_MS: 5 * 60 * 1000, // don't trigger within 5 min of entry
       PROFIT_CAP_PCT: 0.30,    // if profit already ≥ 30% of premium, skip delta exit (let profit-taking handle it)
     }
     ```
   - In `evaluateHedgeProfitTaking`, after existing conditions, add:
     ```ts
     if (
       state.hedgeStrikePrice > 0 &&
       state.hedgeEntryAtr > 0 &&
       Date.now() - state.hedgeEntryTime >= DELTA_BLEED_EXIT.MIN_TIME_MS
     ) {
       const priceDistanceAtr = Math.abs(currentPrice - state.hedgeStrikePrice) / state.hedgeEntryAtr;
       const profitPct = state.hedgeEntryNotional > 0 ? totalUnrealizedPnl / state.hedgeEntryNotional : 0;
       if (
         priceDistanceAtr >= DELTA_BLEED_EXIT.ATR_MULTIPLIER &&
         profitPct < DELTA_BLEED_EXIT.PROFIT_CAP_PCT
       ) {
         return { shouldClose: true, reason: `Delta-bleed exit: spot ${currentPrice} is ${priceDistanceAtr.toFixed(2)}× ATR away from strike ${state.hedgeStrikePrice}`, ... };
       }
     }
     ```
   - To get `currentPrice` into `evaluateHedgeProfitTaking`, change the function signature to accept `currentPrice: number` as the third parameter. Update the orchestrator call.
5. **Orchestrator update** in `v2/src/orchestrator.ts`:
   - Pass `currentPrice` to `evaluateHedgeProfitTaking(state, state.optionPositions, currentPrice)`.
6. **Risk manager hedge trigger enhancement** in `v2/src/riskManager.ts`:
   - In `shouldTrade`, when `signal.confidence` is 30–60 and action is `HEDGE`, if `signal.trendDrift !== undefined && signal.trendDrift < -0.2`, increase hedge size by 50% (capped at max) and log "Drift-enhanced hedge".
   - Use existing `calculateBalanceBasedSize` in `hedgeStrategy.ts`? No — `shouldTrade` returns only `size: 1` today. Keep `shouldTrade` returning `size` as a multiplier; `hedgeStrategy.ts` will apply the multiplier to the balance-based size. This requires changing `hedgeStrategy.ts` to read `riskDecision.size` as a multiplier:
     - `const baseSize = calculateBalanceBasedSize(...)`
     - `const hedgeSize = Math.round(baseSize * Math.max(1, ctx.riskDecision.size))`.

**Acceptance criteria**
- `optionsManager.test.ts` tests cover:
  - Delta-bleed exit triggers when price is 2× ATR from strike and profit < 30%.
  - Delta-bleed exit does NOT trigger within 5 minutes of entry.
  - Delta-bleed exit does NOT trigger when profit already ≥ 30%.
  - Existing profit-target/trailing/time-decay exits still work.
- `state.ts` tests (if none exist, add `state.test.ts`) verify `recordHedgeEntry` and `resetHedgeState` handle new fields.
- `npm run build` in `v2/` passes (`tsc` with no errors).
- `npm test` in `v2/` passes.

## Cross-Cutting Concerns

- **No new dependencies.** Use native fetch, `DOMParser` (Node 20), and existing `ws`/`mongodb` packages.
- **Backward compatibility.** Dashboard `/api/signal` continues to return the same top-level fields; new fields are additions. v2 bot can consume the extra fields if present but works without them.
- **DRY_RUN safety.** All new exit logic logs its decision; in DRY_RUN the bot logs "would close" and still resets state to simulate the close.
- **Type safety.** All new state and API fields are typed; update `SignalData` and `SignalInputs` interfaces.

## Test Strategy

| Layer | Test file | Coverage |
|-------|-----------|----------|
| Indicators | `app/lib/indicators.test.ts` | LR slope, EMA slope, Donchian, bandwidth |
| Signals | `app/lib/signals.test.ts` | drift, breakout, news component, weight normalization |
| News | `app/lib/newsSentiment.test.ts` | mocked RSS parse, sentiment scoring |
| v2 Options | `v2/src/optionsManager.test.ts` | delta-bleed exit rules |
| v2 State | `v2/src/state.test.ts` | hedge entry/reset with strike/ATR |

## Verification

1. `cd /Users/vishwa/Desktop/BTC-Market-Dashboard/btcusd-dashboard && npm run lint` passes.
2. `cd /Users/vishwa/Desktop/BTC-Market-Dashboard/btcusd-dashboard/v2 && npm run build` passes.
3. `cd /Users/vishwa/Desktop/BTC-Market-Dashboard/btcusd-dashboard/v2 && npm test` passes.
4. `cd /Users/vishwa/Desktop/BTC-Market-Dashboard/btcusd-dashboard && npx tsc --noEmit` passes.
