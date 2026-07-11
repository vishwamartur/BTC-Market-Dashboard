# BTCUSD V2 Trading Bot — AI Context

> This document helps AI coding assistants understand the architecture,
> conventions, and rules of this codebase. Read this BEFORE making changes.

## What This Bot Does

Automated BTC trading bot on Delta Exchange (India) with three strategies:

1. **Directional Futures** (`futuresStrategy.ts`) — BUY/SELL on strong signals (confidence ≥ 60)
2. **Options Hedging** (`hedgeStrategy.ts`) — Short straddle during low-confidence periods (30-60)
3. **Funding Rate Arbitrage** (`fundingStrategy.ts`) — Cash & carry when funding rate is elevated

The bot runs on a 15-second tick loop. Each tick: fetch data → sync state → check profit-taking → evaluate risk → route to strategy.

## Architecture

```
index.ts (bootstrap, ~50 lines)
  └→ orchestrator.ts (tick runner, strategy router)
       ├→ strategies/hedgeStrategy.ts
       ├→ strategies/futuresStrategy.ts
       ├→ strategies/fundingStrategy.ts
       ├→ optionsManager.ts (pure options operations)
       ├→ riskManager.ts (risk evaluation, breakeven)
       ├→ positionService.ts (position normalization)
       ├→ positionSizing.ts (balance-based sizing)
       ├→ signalFetcher.ts (dashboard API)
       └→ delta.ts → resilientFetch.ts (exchange API)

state.ts       — centralized BotState (all mutable runtime state)
types.ts       — centralized type definitions (no `any` casts)
config/        — Zod-validated environment config
logger.ts      — Pino structured logger
```

### Key Design Patterns

- **Strategy Pattern**: Each strategy implements `Strategy` interface from `strategies/Strategy.ts`
- **Centralized State**: All mutable state lives in `BotState` (see `state.ts`)
- **Typed API**: Delta Exchange responses are typed via `types.ts`
- **Pure Operations**: `optionsManager.ts` is stateless — accepts state as params

## Key Rules

### Orders
- **NEVER** place market orders — always use `placeLimitOrderWithRetry()` from `delta.ts`
- **ALWAYS** check `config.DRY_RUN` before any order placement
- Order placement has 0 retries (avoids double-fills); reads have 2 retries

### State
- **NEVER** add module-level `let` variables — extend `BotState` in `state.ts`
- State mutations happen in orchestrator/strategies, not in service modules
- Exception: `hedgePeakProfit` is updated directly by `evaluateHedgeProfitTaking()`

### Types
- **NEVER** use `any` for position, ticker, or order data — import from `types.ts`
- Position filtering uses `positionService.ts` helpers, not raw `C-`/`P-` prefix checks

### Conventions
- All monetary values logged to 4 decimal places
- Contract size is `0.001 BTC` (not 1 BTC) — see `BALANCE_RISK_CONFIG.contractSizeBtc`
- The BTCUSD perpetual futures product ID is `27` (constant in `positionService.ts`)
- Structured logging via `pino` — always pass an object as first arg to `logger.info()`

## State Machine

```
                 ┌────────────────────────────────────────┐
                 │                                        │
   ┌─────────────▼──────────────┐                         │
   │         IDLE               │    confidence ≥ 60      │
   │  (no open positions)       │────+ strong signal──────▶ DIRECTIONAL
   │                            │                         │  (BUY/SELL)
   └──────────┬─────────────────┘                         │
              │ confidence 30-60                          │
              ▼                                           │
   ┌──────────────────────────┐                           │
   │       HEDGED              │   profit target hit OR   │
   │  (short straddle open)    │───trailing peak exit OR──┘
   │                           │   time-based exit OR
   │  Profit-taking checks     │   strong signal arrives
   │  run EVERY TICK           │
   └───────────────────────────┘
```

## Adding a New Strategy

1. Create `strategies/myStrategy.ts` implementing `Strategy` interface
2. Add it to the `STRATEGIES` array in `orchestrator.ts`
3. If it needs new state fields, add them to `BotState` in `state.ts`
4. If it needs new config, add to `config/index.ts` (never inline constants)
5. Run `npm run build` to verify

## File Reference

| File | Lines | Purpose |
|------|-------|---------|
| `types.ts` | ~125 | All type definitions |
| `state.ts` | ~110 | BotState + state helpers |
| `config/index.ts` | ~27 | Zod config validation |
| `index.ts` | ~53 | Bootstrap entry point |
| `orchestrator.ts` | ~125 | Tick runner + strategy router |
| `strategies/Strategy.ts` | ~35 | Strategy interface |
| `strategies/futuresStrategy.ts` | ~120 | Directional trading |
| `strategies/hedgeStrategy.ts` | ~95 | Options hedge entry |
| `strategies/fundingStrategy.ts` | ~55 | Funding rate arb |
| `optionsManager.ts` | ~300 | Options operations (stateless) |
| `riskManager.ts` | ~255 | Risk evaluation + breakeven |
| `positionService.ts` | ~80 | Position normalization |
| `positionSizing.ts` | ~90 | Balance-based sizing |
| `delta.ts` | ~380 | Delta Exchange API |
| `resilientFetch.ts` | ~160 | HTTP retry + circuit breaker |
| `signalFetcher.ts` | ~43 | Dashboard signal API |
| `fundingArbitrage.ts` | ~90 | Funding arb logic |
| `logger.ts` | ~9 | Pino logger |
