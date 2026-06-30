# V2 Trading Bot — Design Spec

**Date**: 2026-06-29
**Status**: Draft for review
**Author**: Kimchi (brainstorming session with the repo owner)
**Target**: `/Users/vishwa/Desktop/BTC-Market-Dashboard/btcusd-dashboard/v2/`

---

## Goal

Replace the existing v1 trading bot with a v2 implementation that improves the probability of net-positive trading returns after fees, slippage, and taxes. The v1 bot has been trading live against Delta Exchange and losing money; the hypothesized root causes are (a) permissive risk thresholds that allow trades whose expected profit is less than their fees, (b) no slippage modeling, (c) no reconciliation between local position state and the exchange, (d) no restart recovery.

**Honest framing**: this design improves expected value and risk control; it does not guarantee profitability. Markets are adversarial, and any strategy can have losing streaks. The right success metric is positive expected value over many trades, not any single P&L day.

## Non-Goals (out of scope for V2)

- Gamma scalping / options-based strategies (was disabled in v1; deferred to v3)
- A new dashboard UI (v1's UI continues unchanged; v2 reads/writes to its own Mongo collections)
- Multi-asset support (BTCUSD perpetuals only)
- High-frequency trading (v2 runs on a 5-second loop; sub-second is not a goal)
- Promising profitability — we improve expected value, we don't promise returns

---

## Success Criteria (acceptance — V2 ships when ALL are true)

1. **Unit tests**: ≥ 90% line coverage on `features/`, `strategies/`, `risk/`. Property-based tests pass on the risk gate (10k random signal/state combos, must never produce an `ApprovedOrder` that violates any floor).
2. **Backtest pass**: 12 months of historical data shows Sharpe > 1.0, max drawdown < 15%, profit factor > 1.3, fees < 30% of gross profit.
3. **Walk-forward pass**: out-of-sample performance within 30% of in-sample metrics across rolling 6-month/1-month windows.
4. **Shadow mode pass**: ≥ 14 days of live data where v2 disagrees with v1 on > 30% of decisions AND v2's hypothetical P&L is non-negative.
5. **Paper trading pass**: ≥ 14 days on `dryRun: true` mode with no crashes, no reconciliation errors, no missed fills.
6. **Live rollout complete**: graduated sizing (1 → 5 → 10 → 20 contracts) over ≥ 60 days with positive net P&L after fees + slippage.
7. **Operational gates met**: heartbeat to monitoring URL every 60s with 3-failure alert; reconciliation alert on every state mismatch; `BOT_DISABLED=true` env var halts new entries within one tick; structured JSON logs rotated daily.

---

## Architecture

### Module layout

V2 lives in `/Users/vishwa/Desktop/BTC-Market-Dashboard/btcusd-dashboard/v2/` as a standalone Node process with its own `package.json` and `tsconfig.json`. It does NOT depend on Next.js.

```
v2/
├── src/
│   ├── ingestion/      # WS + REST clients (typed, validated)
│   ├── features/       # rolling windows, derived signals (pure)
│   ├── strategies/     # trend-following, funding-rate MR (pure)
│   ├── risk/           # edge gate, sizing, SL/TP (pure)
│   ├── execution/      # Delta API calls, fill tracking
│   ├── state/          # Mongo-backed source of truth
│   ├── monitor/        # logging, metrics, heartbeat
│   ├── config/         # env-driven, zod-validated
│   └── index.ts        # main loop
├── tests/
│   ├── unit/
│   ├── backtest/       # replay engine + scenarios
│   ├── shadow/         # side-by-side vs v1
│   └── fixtures/       # historical data
├── package.json
├── tsconfig.json
└── README.md
```

### Module responsibilities

| Module | Responsibility | Pure? |
|---|---|---|
| `ingestion/` | WS clients (Binance/Bybit/OKX liquidations + prices), Delta REST (funding, ticker, wallet), mempool + blockchain.info polling | No |
| `features/` | Rolling windows (15-min liquidations, 4h klines), derived signals (ATR, EMA, OI delta, funding z-score, on-chain aggregates) | Yes |
| `strategies/` | Trend-following, funding-rate mean-reversion. Each is `features → Signal[]` | Yes |
| `risk/` | Hard gates: min expected value vs fees+slippage, position sizing, daily loss limit, cooldown, leverage cap | Yes |
| `execution/` | Approved order → Delta API call, fill tracking, retries, idempotent order IDs | No |
| `state/` | Mongo-backed: open positions, daily P&L, cooldowns, trade history, reconciliation state | No |
| `monitor/` | Structured logs, metrics, heartbeat to URL, alerts | No |
| `config/` | Env-driven config with strict validation (zod) | — |
| `index.ts` | Main loop: ingest → features → strategies → risk → execution → state → monitor | — |

### Loop cadence

- Tick every 5s: ingest new events, refresh features
- Evaluate strategies on every tick; rate-limit entries per cooldown
- Reconcile with Delta every 30s (and on every restart, before any new entry)
- Heartbeat every 60s

---

## Data Flow

```
                          ┌─────────────────────────────────────┐
                          │            EXTERNAL                  │
                          │  Binance/Bybit/OKX WS · Delta REST   │
                          │  mempool · blockchain.info           │
                          └──────────────┬──────────────────────┘
                                         │ raw events
                                         ▼
                            ┌──────────────────────────┐
                            │       ingestion/         │
                            │  typed, validated events │
                            └──────────┬───────────────┘
                                       │ normalized
                                       ▼
                            ┌──────────────────────────┐
                            │       features/          │
                            │  rolling windows, ATR,   │
                            │  EMA, OI delta, funding  │
                            └──────────┬───────────────┘
                                       │ FeatureSnapshot
                            ┌──────────┴───────────────┐
                            ▼                          ▼
                   ┌──────────────────┐      ┌──────────────────────┐
                   │ strategies/      │      │ state/               │
                   │ each returns     │      │ positions, daily PnL,│
                   │ Signal{candidate}│      │ cooldowns, history   │
                   └────────┬─────────┘      └──────────┬───────────┘
                            │ Signal[]                  │
                            └────────────┬─────────────┘
                                         │
                                         ▼
                            ┌──────────────────────────┐
                            │       risk/              │
                            │  filter → size → SL/TP   │
                            │  → ApprovedOrder|null    │
                            └──────────┬───────────────┘
                                       │ ApprovedOrder
                                       ▼
                            ┌──────────────────────────┐
                            │      execution/          │
                            │  place on Delta (idemp), │
                            │  poll fill, retry, log   │
                            └──────────┬───────────────┘
                                       │ Fill event
                            ┌──────────┴───────────────┐
                            ▼                          ▼
                   ┌──────────────────┐      ┌──────────────────────┐
                   │ state/ (persist) │      │ monitor/ (log, metric)│
                   └──────────────────┘      └──────────────────────┘
```

**Guarantees baked into this flow**:

1. **Reconciliation on every loop tick** (~200ms query). State mismatch → critical log, correct local state, halt new entries until manual review.
2. **Strategies emit `Signal[]`, not `Signal`**. Multiple uncorrelated strategies can fire simultaneously; the risk gate picks at most one to execute per tick.
3. **Restart safety**. Full reconciliation runs before any new entry is allowed after process start.
4. **Event ordering**. Each event carries its own source timestamp (WS message time, REST response time, or block time for on-chain). The feature store sorts by event time, not arrival time, so backpressure or network jitter cannot reorder state.

---

## Strategies (V1 ships with two)

### Strategy A — Trend-following with liquidation exhaustion

- **Inputs**: 4h klines (EMA50, EMA200, ATR14), 15-min rolling liquidation imbalance (long vs short USD notional), current price.
- **BUY condition**: EMA50 > EMA200 (uptrend) AND price within 1.5× ATR of EMA50 (pullback) AND 15-min liquidations skewed ≥ 60/40 toward shorts.
- **SELL condition**: mirror (EMA50 < EMA200, price within 1.5× ATR of EMA50 from above, liquidations skewed ≥ 60/40 toward longs).
- **Reject counter-trend signals** (preserves v1's trend-alignment intent, but tied to specific market structure rather than a vague `trendBias`).
- **Confidence**: continuous 0–100, scaled by EMA slope, pullback depth, and liquidation skew magnitude.
- **Hard floor**: confidence ≥ 60 to emit any signal.
- **Expected value estimate**: `confidence × avg_win_pct − (1 − confidence) × avg_loss_pct − fees − slippage`.

### Strategy B — Funding-rate mean-reversion

- **Inputs**: current funding rate (8h), 8-period funding moving average, EMA200 trend, OI change.
- **SELL condition**: funding > 0.05% AND `|funding − MA| > 1.5σ` AND trend not strongly opposing (EMA200 not steeply up AND price < EMA200 × 1.02).
- **BUY condition**: funding < −0.05% AND mirror.
- **Position management** (called every tick while position is open):
  - **Close** when funding normalizes to < 30% of entry funding (yield dried up).
  - **Close** when funding flips sign (would now be paying instead of receiving).
  - **Widen TP** if position is profitable beyond 1.5× original TP distance — trail stop to lock partial profit.
  - **Tighten stop** if position has lost > 50% of stop distance — cut the losing leg faster.
- **Confidence**: scaled by funding z-score and trend alignment strength.
- **Hard floor**: confidence ≥ 60.
- **Leverage cap**: 3× (lower than directional; funding trades need room).

### Deferred to V3
- Gamma scalping (was disabled in v1; requires options chain infrastructure that v2 doesn't need)
- Cross-exchange basis arbitrage
- Market making

---

## Risk Gate (firm floors, no lowering knobs)

For every candidate `Signal`:

1. **Edge gate (non-negotiable)**: `expected_value_pct ≥ 2.0 × round_trip_cost_pct`. If a trade can't plausibly clear 2× its costs after slippage, it's rejected.
2. **Confidence floor**: ≥ 60% (configurable, but the default IS the floor).
3. **Position cap**: max 1 open position per symbol; max 2 open positions total across strategies.
4. **Daily circuit breaker**: if realized + unrealized P&L ≤ −3% of equity → halt new entries for the rest of the UTC day.
5. **Cooldown**: 15 min between entries on same symbol; 30 min in neutral regimes (neither EMA50 > EMA200 nor < EMA200).
6. **Leverage cap**: 5× for directional (Strategy A), 3× for funding-reversion (Strategy B).
7. **Position sizing**: quarter-Kelly fraction, capped at 1% risk-per-trade of equity, capped at max absolute position size (USD), then volatility-adjusted.
8. **SL/TP**: SL = `entry − 1.5 × ATR`; TP = `entry + 2.0 × ATR` (R:R = 2.0; required by edge gate).

### Slippage model

- Default: 0.05% slippage per side on market orders (configurable; calibratable from real fills).
- Taker fee: 0.05% per side; maker fee: 0.02% per side; GST: 15.25% on fees (matches Delta India).
- Edge gate uses `(fees + slippage) × 2` as the realistic round-trip cost floor.

### Position reconciliation

- Every loop tick: fetch live positions from Delta.
- Compare to local state.
- On mismatch: critical alert, correct local state, halt new entries until manual review.
- Run at startup before any new entry.

---

## Testing & Rollout (6 sequential gates)

### Gate 1 — Unit tests
- ≥ 90% line coverage on `features/`, `strategies/`, `risk/`.
- Property-based tests on the risk gate (10k random combos).
- Run on every commit; pass before merge.

### Gate 2 — Backtest
- 12 months of historical data: 4h klines (Binance, free), funding rates (Binance, free), recent liquidations (Binance/Bybit, ~30 days available).
- Older liquidations backfilled from kline-derived proxy if needed.
- Slippage + fees baked into engine.
- **Pass criteria**: Sharpe > 1.0, max drawdown < 15%, profit factor > 1.3, fees < 30% of gross profit.
- If a strategy fails, it's tuned out or replaced — never lowered standards.

### Gate 3 — Walk-forward validation
- 6 months in-sample, 1 month out-of-sample, sliding window.
- **Pass**: out-of-sample metrics within 30% of in-sample metrics.

### Gate 4 — Shadow mode
- v2 receives same live data as v1, emits trade decisions to log + Mongo but does NOT call Delta.
- Side-by-side comparison view: how would v2 have performed on today's tape?
- Duration: ≥ 14 days.
- **Pass criteria**: v2 disagrees with v1 on > 30% of decisions AND v2's hypothetical P&L is non-negative.

### Gate 5 — Paper trading (`dryRun: true`)
- Same code path as live, against a `dryRun: true` config flag that simulates fills using live prices and a configurable fill model (immediate full fill, partial fill probability, etc.).
- Delta testnet is NOT used because Delta India does not expose a public testnet endpoint. `dryRun` is the canonical paper mode.
- Duration: ≥ 14 days.
- **Pass criteria**: no crashes, no reconciliation errors, no missed fills, daily P&L variance within expected bounds.

### Gate 6 — Live rollout (graduated sizing)
- Week 1: 1 contract per entry. Any reconciliation error → halt and review.
- Week 2: if profitable 5/7 days → 5 contracts per entry.
- Week 3: if profitable → 10 contracts.
- Hard cap: 20 contracts per entry until 60 days profitable.
- **Kill switch**: `BOT_DISABLED=true` env var halts new entries within one tick. Existing positions continue to be managed (so we don't strand an open position).

---

## Monitoring & Alerts (must exist before live)

- **Heartbeat**: POST every 60s to a configurable HTTP endpoint (Telegram bot URL or generic webhook) with `{ uptime, lastTickMs, openPositions, dailyPnl, equity }`. Alert on 3 consecutive failures.
- **Reconciliation alert**: any state mismatch → immediate alert, halt new entries.
- **Daily P&L snapshot**: written to Mongo at 00:00 UTC.
- **Logs**: structured JSON, rotated daily, retained 30 days.

---

## Configuration

Env-driven, validated by zod at startup. Required variables:

```
DELTA_API_KEY
DELTA_API_SECRET
DELTA_BASE_URL                  # default https://api.india.delta.exchange
MONGODB_URI                     # existing cluster; v2 uses db "btcusd_v2"
HEARTBEAT_URL                   # POST endpoint for heartbeats
BOT_DISABLED                    # default false; true halts new entries
DRY_RUN                         # default false; true = paper mode
LOG_LEVEL                       # default info
ACCOUNT_BALANCE_USD             # default: auto-fetched from Delta wallet on startup, with this value as fallback
```

The bot fetches live equity from Delta's wallet endpoint on startup and re-fetches every 5 minutes. `ACCOUNT_BALANCE_USD` is a fallback if the wallet endpoint fails or returns zero.

---

## Error Handling

- **Network errors in ingestion**: log warning, continue. The bot should never crash on a single feed failure.
- **Delta API errors during execution**: retry with exponential backoff (1s, 2s, 4s, 8s, max 60s). After 5 consecutive failures for the same order, mark the order as failed and emit a critical alert.
- **Reconciliation errors**: log critical, halt new entries, require manual intervention to resume (set `BOT_DISABLED=false` after the issue is reviewed).
- **Mongo connection loss**: bot pauses execution but keeps the heartbeat alive. Reconnect is automatic.
- **Process crash**: on restart, full reconciliation runs before any new entry. State is durable in Mongo, so a crash never loses position data.
- **Heartbeat failure**: 3 consecutive failures → critical alert. Bot does not stop trading (heartbeat is monitoring, not gating).

---

## Constraints

- TypeScript only (matches existing repo).
- Node.js 20+ (already required by Next.js 16).
- No new runtime dependencies unless explicitly approved. Keep `package.json` minimal.
- v2 must NOT depend on v1's code paths (parallel, not coupled).
- All trading decisions logged with enough context to reproduce post-hoc.

---

## Assumptions

- Delta Exchange API remains stable; rate limits don't change materially.
- MongoDB connection (already provisioned) is available; v2 uses database `btcusd_v2` to keep collections separate from v1.
- v1 bot continues to run during v2 development (parallel implementation, as agreed in brainstorming).
- The user is willing to fund paper trading and graduated live rollout only after gates 1–5 pass.
- 30 days of historical liquidation data is acceptable for the backtest. Older liquidations will be approximated from kline-derived proxies (with reduced confidence in pre-period signals).

---

## Phased Rollout (chronological)

| Phase | Deliverable | Validation |
|---|---|---|
| 1 | Spec (this document) | User review + approval |
| 2 | Implementation plan | Written via writing-plans skill |
| 3 | v2 scaffolding (`package.json`, `tsconfig`, module skeletons, zod config, logger) | `npm run build` succeeds |
| 4 | `ingestion/` (typed clients against v1's existing endpoints + Mongo connection) | Unit tests on parsed events |
| 5 | `features/` (rolling windows, ATR, EMA, funding z-score) | Unit tests on derived signals |
| 6 | `state/` (Mongo schema, reconciliation logic) | Unit tests on state transitions |
| 7 | `strategies/` (Strategy A + B as pure functions) | Unit tests on signal generation |
| 8 | `risk/` (edge gate, sizing, SL/TP) | Property-based tests (10k combos) |
| 9 | `execution/` (Delta API calls with idempotent order IDs, retries) | Mocked Delta server tests + dryRun end-to-end |
| 10 | `monitor/` (structured logs, heartbeat, alerts) | Integration test against a mock webhook |
| 11 | Backtest engine + 12-month replay | Gate 2 criteria |
| 12 | Walk-forward validation | Gate 3 criteria |
| 13 | Shadow mode deployment | Gate 4 criteria |
| 14 | Paper trading (`dryRun: true`) | Gate 5 criteria |
| 15 | Live rollout (graduated sizing) | Gate 6 criteria |
| 16 | Decommission v1 (after 60 days profitable) | Manual sign-off |

---

## Open Questions (must resolve before implementation starts)

These are decision-blocking and were flagged in the brainstorming session:

1. **Final account equity**: assumed auto-fetched from Delta wallet with `ACCOUNT_BALANCE_USD` fallback. Confirm this approach works with Delta India's auth (wallet endpoint may need product-scoped signing).
2. **Backtest data window**: 30 days of liquidation data is what's publicly available; older data approximated from klines. Confirm 30 days is acceptable, or budget extra time to source longer liquidation history.
3. **Heartbeat endpoint**: which service receives heartbeats? Telegram bot, UptimeRobot, custom HTTP, or all three? v2 supports any URL that accepts POST.
4. **V1 decommission policy**: at what point do we cut v1 over entirely? Proposal: only after v2 has been live ≥ 60 days profitable AND v1 has been disabled for ≥ 14 days without incident.

---

## Self-Review Notes (filled during spec writing)

- **Placeholder scan**: no TBD/TODO in the body. Open questions are explicit and numbered.
- **Internal consistency**: architecture (Section "Architecture") matches data flow (Section "Data Flow") and module responsibilities table. Strategies (Section "Strategies") match the data flow's `strategies/` node. Risk gate (Section "Risk Gate") is consistent with strategies' confidence floors and leverage caps.
- **Scope check**: focused on one coherent project (v2 trading bot). The phased rollout table shows 16 phases but they roll up into 6 testing gates; not decomposable into separate specs without losing coherence.
- **Ambiguity check**: resolved during writing —
  - Account equity: explicit (auto-fetch with fallback).
  - Testnet vs dryRun: explicit (dryRun only; no testnet).
  - Heartbeat URL: explicit (configurable, defaults to env var).
  - Reconciliation: explicit (every tick, every restart, halts new entries on mismatch).
