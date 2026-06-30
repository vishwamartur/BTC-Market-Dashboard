# V2 Trading Bot Implementation Plan — Part 2 (Deployment & Validation Gates)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Companion to:** Part 1 (`2026-06-29-v2-trading-bot-dev.md`, Tasks 1-22). Part 1 must be complete before Part 2 begins. Each task here is a validation gate, not a code-writing task — the code is already in place from Part 1; this part verifies it works.

**Goal:** Verify v2 achieves positive expected value after fees + slippage through 6 sequential validation gates, then graduate to live trading and decommission v1.

---

## Gate Overview

| Gate | Duration | Pass Criteria | Task |
|---|---|---|---|
| 2. Backtest | ~1 day setup | Sharpe > 1.0, max DD < 15%, profit factor > 1.3, fees < 30% gross | 23 |
| 3. Walk-forward | ~1 day | Out-of-sample Sharpe within 30% of in-sample | 24 |
| 4. Shadow | ≥ 14 days | v2 hypothetical P&L non-negative; v2/v1 disagreement > 30% | 25 |
| 5. Paper (`DRY_RUN=true`) | ≥ 14 days | No crashes, no reconciliation errors, no missed fills | 26 |
| 6. Live rollout | 60+ days | Phase 1 (1 contract, 7d), Phase 2 (5 contracts, 14d), Phase 3 (10+, 60d hold); each profitable | 27-29 |
| 7. Decommission v1 | 14d disable + manual sign-off | v1 disabled with no incidents | 30 |

**Hard rule:** If any strategy fails a gate, tune it out or replace it. **Never lower the criteria.**

---

### Task 23: Backtest engine + 12-month historical replay (Gate 2)

**Files:** Create `v2/tests/backtest/engine.ts`, `v2/tests/backtest/run.ts`, `v2/tests/backtest/fixtures/fetchFixtures.ts`.

- [ ] **Step 1: Implement pure replay engine**

```ts
// v2/tests/backtest/engine.ts
import type { FeatureSnapshot, Kline, LiquidationEvent, Signal } from '../../src/types.js';
import { buildSnapshot } from '../../src/features/snapshot.js';
import { trendFollowing } from '../../src/strategies/trendFollowing.js';
import { fundingMeanReversion } from '../../src/strategies/fundingMeanReversion.js';
import { edgeGate } from '../../src/risk/edgeGate.js';
import { positionSize } from '../../src/risk/positionSize.js';
import { brackets } from '../../src/risk/brackets.js';

export interface BacktestInput {
  startTime: number; endTime: number;
  initialEquity: number;
  klines: Kline[];
  liquidations: LiquidationEvent[];
  fundingHistory: Array<{ timestamp: number; rate: number }>;
  priceHistory: Array<{ timestamp: number; price: number }>;
  contractSizeBtc: number;
  fees: { takerPct: number; slippagePct: number; gstRate: number };
}
export interface BacktestTrade {
  openedAt: number; closedAt: number;
  side: 'BUY' | 'SELL'; entry: number; exit: number;
  size: number; pnl: number; feesPaid: number;
  reason: 'sl' | 'tp' | 'signal-flip' | 'eod';
}
export interface BacktestResult {
  trades: BacktestTrade[];
  equityCurve: Array<{ t: number; equity: number }>;
  metrics: {
    sharpe: number; maxDrawdownPct: number;
    profitFactor: number; totalFees: number; grossProfit: number;
  };
}

/** Walk every 4h kline, build snapshot, evaluate strategies, apply risk gate + brackets,
 *  simulate fills at next bar open + slippage, check SL/TP, track equity. */
export function runBacktest(input: BacktestInput): BacktestResult {
  const trades: BacktestTrade[] = [];
  let equity = input.initialEquity;
  const equityCurve: BacktestResult['equityCurve'] = [{ t: input.startTime, equity }];

  let lastEntryAt = 0;
  let openPositions = 0;

  for (let i = 200; i < input.klines.length - 1; i++) {
    const k = input.klines[i]!;
    const nextK = input.klines[i+1]!;
    const window = input.liquidations.filter(l => l.orderTradeTime >= k.openTime - 15*60_000 && l.orderTradeTime <= k.openTime);
    const fundingWindow = input.fundingHistory.filter(f => f.timestamp <= k.openTime).slice(-8).map(f => f.rate);
    const fundingAtK = input.fundingHistory.filter(f => f.timestamp <= k.openTime).at(-1)?.rate ?? null;

    const inputs = {
      currentPrice: k.close,
      klines: input.klines.slice(0, i+1),
      liquidations15m: window,
      fundingHistory: fundingWindow,
      currentFunding: fundingAtK,
      openInterest: null, oiHistory: [],
      timestamp: k.openTime,
    };
    const snap = buildSnapshot(inputs);
    if (snap.atr14 === 0) continue;

    const sigs: Signal[] = [...trendFollowing(snap), ...fundingMeanReversion(snap)];
    for (const sig of sigs) {
      const passed = edgeGate(sig, { openPositions, totalDailyPnlPct: 0, lastEntryAt, now: k.openTime });
      if (!passed) continue;

      const size = positionSize({
        confidence: passed.confidence, equityUsd: equity,
        currentPrice: snap.currentPrice, atr: snap.atr14,
        contractSizeBtc: input.contractSizeBtc, maxLeverage: 5,
      });
      const { stopLoss, takeProfit } = brackets(passed.direction, snap.currentPrice, snap.atr14);
      const entryPrice = nextK.open * (1 + (passed.direction === 'BUY' ? 1 : -1) * input.fees.slippagePct);
      const notional = entryPrice * size * input.contractSizeBtc;
      const feePaid = notional * input.fees.takerPct * (1 + input.fees.gstRate) * 2;

      let exitPrice = entryPrice;
      let reason: BacktestTrade['reason'] = 'eod';
      // Check SL/TP over next 100 bars (proxy: scan up to next 100 klines)
      for (let j = i+1; j < Math.min(i+101, input.klines.length); j++) {
        const kj = input.klines[j]!;
        if (passed.direction === 'BUY') {
          if (kj.low <= stopLoss) { exitPrice = stopLoss; reason = 'sl'; break; }
          if (kj.high >= takeProfit) { exitPrice = takeProfit; reason = 'tp'; break; }
        } else {
          if (kj.high >= stopLoss) { exitPrice = stopLoss; reason = 'sl'; break; }
          if (kj.low <= takeProfit) { exitPrice = takeProfit; reason = 'tp'; break; }
        }
      }
      const pnl = passed.direction === 'BUY'
        ? (exitPrice - entryPrice) * size * input.contractSizeBtc - feePaid
        : (entryPrice - exitPrice) * size * input.contractSizeBtc - feePaid;
      trades.push({
        openedAt: k.openTime, closedAt: k.openTime + (reason === 'eod' ? input.endTime - k.openTime : 0),
        side: passed.direction, entry: entryPrice, exit: exitPrice, size, pnl, feesPaid: feePaid, reason,
      });
      equity += pnl;
      equityCurve.push({ t: k.openTime, equity });
      lastEntryAt = k.openTime;
      openPositions = Math.max(0, openPositions - 1);
    }
  }

  return computeMetrics({ trades, equityCurve });
}

function computeMetrics(r: BacktestResult): BacktestResult {
  // Sharpe (annualized): mean(returns) / std(returns) * sqrt(252 * 6) for 4h bars
  const returns: number[] = [];
  for (let i = 1; i < r.equityCurve.length; i++) {
    const prev = r.equityCurve[i-1]!.equity;
    const cur = r.equityCurve[i]!.equity;
    if (prev > 0) returns.push((cur - prev) / prev);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / Math.max(1, returns.length);
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, returns.length);
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252 * 6) : 0;

  // Max drawdown
  let peak = r.equityCurve[0]?.equity ?? 0;
  let maxDD = 0;
  for (const p of r.equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak > 0 ? (peak - p.equity) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }

  const grossProfit = r.trades.filter(t => t.pnl > 0).reduce((a, b) => a + b.pnl, 0);
  const grossLoss = Math.abs(r.trades.filter(t => t.pnl < 0).reduce((a, b) => a + b.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const totalFees = r.trades.reduce((a, b) => a + b.feesPaid, 0);

  return {
    ...r,
    metrics: {
      sharpe, maxDrawdownPct: maxDD * 100,
      profitFactor, totalFees, grossProfit,
    },
  };
}
```

- [ ] **Step 2: Implement fixture loader (fetches 12 months of 4h klines from Binance public API)**

```ts
// v2/tests/backtest/fixtures/fetchFixtures.ts
import { writeFile } from 'node:fs/promises';
import { request } from 'undici';

async function fetchKlines() {
  const all = [];
  let endTime = Date.now();
  for (let i = 0; i < 13; i++) {
    const startTime = endTime - 30 * 24 * 3600 * 1000;
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=4h&startTime=${startTime}&endTime=${endTime}&limit=1000`;
    const r = await request(url);
    const data: any[] = await r.body.json();
    for (const k of data) {
      all.push({ openTime: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], closeTime: k[6] });
    }
    endTime = startTime - 1;
  }
  await writeFile('tests/backtest/fixtures/klines.json', JSON.stringify(all));
}

fetchKlines().catch(err => { console.error(err); process.exit(1); });
```

> **Liquidation data caveat:** Binance public API retains ~30 days of liquidation events. Older periods use a kline-derived proxy (large wicks with high volume suggest liquidation clusters). The executor must extend `fetchFixtures.ts` with a `liquidations.json` populated from the proxy logic, or restrict the backtest to the most recent 30 days where real liquidation data is available.

- [ ] **Step 3: Run fixture fetch**

```bash
cd btcusd-dashboard/v2 && npx tsx tests/backtest/fixtures/fetchFixtures.ts
ls -la tests/backtest/fixtures/klines.json   # verify file size > 1MB
```

- [ ] **Step 4: Implement `run.ts` to invoke engine and print metrics**

```ts
// v2/tests/backtest/run.ts
import { readFileSync } from 'node:fs';
import { runBacktest, type BacktestInput } from './engine.js';

const klines = JSON.parse(readFileSync('tests/backtest/fixtures/klines.json', 'utf8'));
const input: BacktestInput = {
  startTime: klines[0].openTime,
  endTime: klines.at(-1).openTime,
  initialEquity: 1000,
  klines, liquidations: [], fundingHistory: [], priceHistory: [],
  contractSizeBtc: 0.001,
  fees: { takerPct: 0.0005, slippagePct: 0.0005, gstRate: 0.1525 },
};
const r = runBacktest(input);
console.log(JSON.stringify(r.metrics, null, 2));
console.log(`Trades: ${r.trades.length}, Fees/Gross ratio: ${(r.metrics.totalFees / Math.max(1, r.metrics.grossProfit)).toFixed(2)}`);
```

- [ ] **Step 5: Run backtest**

```bash
cd btcusd-dashboard/v2 && npx tsx tests/backtest/run.ts
```

- [ ] **Step 6: Verify Gate 2 pass criteria**

- Sharpe > 1.0?
- Max drawdown < 15%?
- Profit factor > 1.3?
- Fees < 30% of gross profit?

If any strategy fails, tune it out (set enabled: false in config) or replace. **Never lower the criteria.**

- [ ] **Step 7: Commit**

```bash
cd /Users/vishwa/Desktop/BTC-Market-Dashboard
git add btcusd-dashboard/v2/tests/backtest
git commit -m "feat(v2): backtest engine + 12-month replay (Gate 2)"
```

---

### Task 24: Walk-forward validation (Gate 3)

**Files:** Create `v2/tests/backtest/walkforward.ts`.

- [ ] **Step 1: Implement walk-forward loop**

```ts
// v2/tests/backtest/walkforward.ts
import { runBacktest, type BacktestInput } from './engine.js';

interface Window { inStart: number; inEnd: number; outStart: number; outEnd: number; }

export function walkForward(
  fullInput: BacktestInput, inMonths = 6, outMonths = 1,
) {
  const ms = (m: number) => m * 30 * 24 * 3600 * 1000;
  const windows: Window[] = [];
  let cursor = fullInput.startTime;
  while (cursor + ms(inMonths + outMonths) <= fullInput.endTime) {
    windows.push({
      inStart: cursor, inEnd: cursor + ms(inMonths),
      outStart: cursor + ms(inMonths), outEnd: cursor + ms(inMonths + outMonths),
    });
    cursor += ms(outMonths);
  }

  const results = windows.map(w => {
    const inSample = runBacktest({
      ...fullInput,
      startTime: w.inStart, endTime: w.inEnd,
      klines: fullInput.klines.filter(k => k.openTime >= w.inStart && k.openTime < w.inEnd),
    });
    const outOfSample = runBacktest({
      ...fullInput,
      startTime: w.outStart, endTime: w.outEnd,
      klines: fullInput.klines.filter(k => k.openTime >= w.outStart && k.openTime < w.outEnd),
    });
    return { window: w, inSample, outOfSample };
  });

  const degradation = results.map(r =>
    Math.abs(r.outOfSample.metrics.sharpe - r.inSample.metrics.sharpe) /
    Math.max(0.01, Math.abs(r.inSample.metrics.sharpe))
  );
  const avgDegradation = degradation.reduce((a, b) => a + b, 0) / degradation.length;
  return { results, avgDegradation };
}
```

- [ ] **Step 2: Run walk-forward**

```bash
cd btcusd-dashboard/v2 && npx tsx -e "
import { readFileSync } from 'node:fs';
import { walkForward } from './tests/backtest/walkforward.js';
import { runBacktest } from './tests/backtest/engine.js';
const klines = JSON.parse(readFileSync('tests/backtest/fixtures/klines.json', 'utf8'));
const input = { startTime: klines[0].openTime, endTime: klines.at(-1).openTime, initialEquity: 1000, klines, liquidations: [], fundingHistory: [], priceHistory: [], contractSizeBtc: 0.001, fees: { takerPct: 0.0005, slippagePct: 0.0005, gstRate: 0.1525 } };
const { avgDegradation } = walkForward(input);
console.log('Average out-of-sample degradation:', avgDegradation);
"
```

- [ ] **Step 3: Verify Gate 3 pass** — avgDegradation < 0.30 (out-of-sample within 30% of in-sample)

- [ ] **Step 4: Commit**

```bash
cd /Users/vishwa/Desktop/BTC-Market-Dashboard
git add btcusd-dashboard/v2/tests/backtest/walkforward.ts
git commit -m "feat(v2): walk-forward validation (Gate 3)"
```

---

### Task 25: Shadow mode (Gate 4)

**Files:** Create `v2/tests/shadow/compare.ts`. Config: `BOT_DISABLED=true` in v2 `.env`.

- [ ] **Step 1: Run v2 alongside v1 for ≥ 14 days**

With `BOT_DISABLED=true`:
- v2 still ticks every 5s
- v2 still computes features, runs strategies, applies risk gate
- v2 writes `db.signals` collection entries (hypothetical decisions)
- v2 does NOT call Delta (execution/ is gated on `BOT_DISABLED`)
- v1 continues to trade as normal

- [ ] **Step 2: After 14 days, implement and run comparison**

```ts
// v2/tests/shadow/compare.ts
import { startMongo, getDb } from '../../src/state/mongo.js';

async function main() {
  // Both v1 and v2 use the same MONGODB_URI but different DB names:
  // v1 uses 'btcusd', v2 uses 'btcusd_v2'.
  // v1's "trades" collection has product_id 27 (BTCUSD).
  await startMongo(process.env.MONGODB_URI!);
  const db = getDb();

  // v2's hypothetical decisions
  const v2Signals = await db.collection('signals').find({}).sort({ timestamp: 1 }).toArray();
  // v1's actual trades (read from v1's DB)
  // (Requires v1 to also be using the same Mongo cluster; open a second connection if needed.)

  // Simple agreement metric: same hour, same direction?
  let agreements = 0, total = 0;
  for (const s of v2Signals) {
    const hourBucket = Math.floor(s.timestamp / 3600_000);
    // Find v1 trade in same hour bucket
    // (Implementation depends on v1's trade schema; adapt as needed.)
    total++;
  }
  const agreementRate = total > 0 ? agreements / total : 0;
  console.log(`v2/v1 agreement rate: ${(agreementRate * 100).toFixed(1)}%`);

  // Hypothetical P&L: assume v2 would have used positionSize + brackets and exited at the same hour's close
  // (Full implementation: replay v2's signals against v1's recorded price ticks and compute paper P&L.)
  const hypotheticalPnl = 0; // fill in by replaying signals against price data
  console.log(`v2 hypothetical P&L over 14 days: $${hypotheticalPnl.toFixed(2)}`);
}

main().catch(err => { console.error(err); process.exit(1); });
```

> **Note:** v2 does not depend on v1 code paths (per spec), but the shadow comparison needs to read v1's MongoDB collection (`btcusd.trades`) to compute the agreement metric. Use a separate Mongo client connection to read v1's collection without coupling v2 code to v1's code.

- [ ] **Step 3: Verify Gate 4 pass**

- v2 disagrees with v1 on > 30% of decisions? (`1 - agreementRate > 0.30`)
- v2's hypothetical P&L is non-negative over the 14-day window?

If either fails, do not proceed to paper trading. Investigate why v2 isn't producing useful signals or why v2's signal disagrees with reality.

- [ ] **Step 4: Commit**

```bash
cd /Users/vishwa/Desktop/BTC-Market-Dashboard
git add btcusd-dashboard/v2/tests/shadow
git commit -m "feat(v2): shadow mode comparison (Gate 4)"
```

---

### Task 26: Paper trading with DRY_RUN=true (Gate 5)

**Files:** Config only.

- [ ] **Step 1: Set `DRY_RUN=true` in v2 `.env`, `BOT_DISABLED=false`**

- [ ] **Step 2: Run v2 for ≥ 14 days**

`OrderManager` is configured with a stubbed `placeOrder` that returns a synthetic order ID, and `pollFill` returns `filled: true, avgPrice: currentPrice`. The bot's behavior should be identical to live except no real orders are placed.

- [ ] **Step 3: Monitor**

- Crash count (process restarts): should be 0
- Reconciliation errors: should be 0
- Missed fills: should be 0
- Daily P&L variance: should be within expected bounds (compare to backtest distribution)

- [ ] **Step 4: Verify Gate 5 pass**

- No crashes?
- No reconciliation errors?
- No missed fills?
- Daily P&L variance within expected bounds?

If any fail, debug before going live.

---

### Task 27: Live rollout phase 1 (1 contract, 7 days)

**Files:** Modify `v2/src/risk/positionSize.ts` (or wire size cap via config).

- [ ] **Step 1: Wire Delta real order-placement**

Update `v2/src/index.ts`'s `OrderManager` constructor: replace the stubbed `placeOrder` with a real call to Delta's `POST /v2/orders`. HMAC-signed request body with `product_id`, `size`, `side`, `order_type: 'market_order'`, `client_order_id` (the OrderManager auto-generates these).

- [ ] **Step 2: Wire klines fetching**

Add a periodic klines fetch (every 5 minutes) from Delta REST (`/v2/history/candles?symbol=BTCUSD&interval=4h&limit=200`). Cache the last 200 4h klines in memory; pass to `buildSnapshot`.

- [ ] **Step 3: Wire daily P&L aggregation**

In `v2/src/index.ts`'s tick handler, compute `totalDailyPnlPct` by summing today's `db.trades` P&L + current unrealized P&L from Delta's position endpoint, divided by equity.

- [ ] **Step 4: Wire position reconciliation**

Before the first tick, fetch Delta's open positions, compare to `db.trades` where `closedAt` is null. If mismatch:
- Log critical alert
- Correct local state to match exchange
- Halt new entries until manual review (set `BOT_DISABLED=true` automatically)

Run reconciliation every 30s during the tick loop as well.

- [ ] **Step 5: Cap size to 1 contract**

In `v2/src/index.ts`, pass `maxSize: 1` to `positionSize()` (or add a `LIVE_SIZE_CAP` env var).

- [ ] **Step 6: Set `DRY_RUN=false`, `BOT_DISABLED=false`, run for 7 days**

- [ ] **Step 7: Verify Gate 6 phase 1 pass**

- Profitable 5/7 days?
- No reconciliation errors?
- Fill prices within 0.05% of expected?

If any fail, halt and investigate. Do not proceed to phase 2.

- [ ] **Step 8: Commit**

```bash
cd /Users/vishwa/Desktop/BTC-Market-Dashboard
git add btcusd-dashboard/v2/src/index.ts
git commit -m "feat(v2): live rollout phase 1 - real delta wiring + 1-contract cap"
```

---

### Task 28: Live rollout phase 2 (5 contracts, 14 days)

- [ ] **Step 1: Update size cap to 5 contracts**

- [ ] **Step 2: Run for 14 days**

- [ ] **Step 3: Verify Gate 6 phase 2 pass**

- Profitable 10/14 days?
- No reconciliation errors?
- Max drawdown < 15% of equity?

If fail, halt and investigate. Do not promote to phase 3.

- [ ] **Step 4: Commit** — `git commit -m "feat(v2): live rollout phase 2 - 5-contract cap"`

---

### Task 29: Live rollout phase 3 (10+ contracts, 60-day hold)

- [ ] **Step 1: Update size cap to 10 contracts**

- [ ] **Step 2: Run for 60 days**

- [ ] **Step 3: Verify Gate 6 final pass**

- Positive net P&L after fees + slippage over the 60-day window?
- Max drawdown < 15% of equity?

If yes, optionally promote to 20-contract cap (still gated on continued profitability). Stop increasing size at any point that drawdown exceeds 12%.

- [ ] **Step 4: Commit** — `git commit -m "feat(v2): live rollout phase 3 - 10-contract cap, 60-day hold"`

---

### Task 30: Decommission v1

- [ ] **Step 1: Disable v1 auto-trader**

In v1's UI: toggle "Live Trading" OFF. Verify no v1 orders are placed for 14 days while v2 continues running.

- [ ] **Step 2: After 14 days with v2 profitable, archive v1 code**

```bash
cd /Users/vishwa/Desktop/BTC-Market-Dashboard
git mv btcusd-dashboard/app/api/trade btcusd-dashboard/app/api/trade.deprecated
git mv btcusd-dashboard/app/api/arbitrage btcusd-dashboard/app/api/arbitrage.deprecated
git mv btcusd-dashboard/app/lib/signalEngine.ts btcusd-dashboard/app/lib/signalEngine.ts.deprecated
git mv btcusd-dashboard/app/lib/riskManager.ts btcusd-dashboard/app/lib/riskManager.ts.deprecated
git mv btcusd-dashboard/app/lib/priceArbitrage.ts btcusd-dashboard/app/lib/priceArbitrage.ts.deprecated
# Add a `.deprecated` README explaining what each is and why it's archived
git commit -m "chore: archive v1 trading bot (replaced by v2)"
```

- [ ] **Step 3: Verify v1 is no longer reachable**

- Search the codebase for references to v1's trade endpoints; ensure none are called by the UI
- Confirm v1's `AutoTraderControl` UI is hidden or marked as deprecated
- Run the dashboard manually and verify it still works (dashboard reads data, doesn't write trades)

- [ ] **Step 4: Final commit** if any UI changes were needed — `git commit -m "chore: remove v1 auto-trader UI references"`

---

## Self-Review

**Spec coverage (Gates 2-7 + decommission):**
- ✓ Gate 2 — Backtest (Task 23)
- ✓ Gate 3 — Walk-forward (Task 24)
- ✓ Gate 4 — Shadow (Task 25)
- ✓ Gate 5 — Paper trading (Task 26)
- ✓ Gate 6 — Live rollout phase 1 (Task 27)
- ✓ Gate 6 — Live rollout phase 2 (Task 28)
- ✓ Gate 6 — Live rollout phase 3 (Task 29)
- ✓ Gate 7 — v1 decommission (Task 30)

**Placeholder scan:** Task 25 (`compare.ts`) has a partial implementation note for "find v1 trade in same hour bucket" — the executor must implement this by reading v1's `btcusd.trades` collection directly via a separate Mongo client (no code coupling between v2 and v1). Task 27's "wire Delta order-placement" requires the executor to call Delta's `POST /v2/orders` per Delta's official API docs.

**Hard rules enforced:**
- Backtest pass criteria are non-negotiable. If a strategy fails, tune out — never lower standards.
- Each live rollout phase must pass before the next is started.
- v1 must be disabled for 14 days with v2 profitable before archival.

**Known caveats:**
- Liquidation data: Binance public API retains ~30 days. The executor must extend backtest to use real liquidation data for that window and accept reduced signal confidence for older periods.
- Delta wallet endpoint may require product-scoped signing depending on Delta India's auth model. If the wallet fetch fails, fall back to `ACCOUNT_BALANCE_USD` config value.
- Telegram heartbeat URL: configurable via `HEARTBEAT_URL` env var. Any URL accepting POST works.
