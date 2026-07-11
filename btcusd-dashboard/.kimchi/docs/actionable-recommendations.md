# Actionable Scalability & AI-Friendly Code Recommendations

**Codebase:** btcusd-dashboard (Next.js 16 + React 19 + TypeScript 5)
**Date:** 2026-07-07
**Scope:** Improve scalability, maintainability, and AI-assisted development quality for the real-time BTC/USD dashboard and v2 trading bot.

---

## TL;DR

The codebase is functionally rich but has six structural ceilings that will worsen as features are added daily:

1. `globalThis` singletons hide dependencies from humans and LLMs.
2. `app/page.tsx` is a 294-line monolith with 17 component imports.
3. No tests in `app/` despite `v2/` using Vitest.
4. Magic numbers scattered with no central config.
5. Silent failures in MongoDB writes and WebSocket broadcasts.
6. Types duplicated between `app/` and `v2/`.

The fastest path to quality is: **converge `app/` on `v2/`'s discipline** (centralized state, Zod config, Pino logging, tests) while refactoring incrementally, one feature at a time.

---

## Priority 1 — Stop the bleeding (do these first)

### 1.1 Replace silent failures with structured logging

**Problem:** `app/lib/db.ts` and `WsManager.broadcast()` swallow errors with `console.error` + empty `catch {}`.

**Action:** Add a `shared/logger` module using Pino (copy `v2/src/logger.ts` pattern) and log every persistence/broadcast failure with structured fields.

**Files to touch:**
- `app/shared/logger/index.ts` (new)
- `app/lib/db.ts`
- `app/lib/wsManager.ts`

**Acceptance:** Every async failure is logged with `{ level: 'error', err, component, operation }`.

---

### 1.2 Centralize magic numbers in a Zod-validated config

**Problem:** Reconnect caps, batch sizes, heartbeats, and thresholds are hard-coded across files.

**Action:** Create `app/shared/config/runtime.ts` (mirror `v2/src/config/index.ts`) and replace literals with `RUNTIME.ws.reconnectMaxMs`, `RUNTIME.batch.maxBatchSize`, etc.

**Files to touch:**
- `app/shared/config/runtime.ts` (new)
- `app/lib/wsManager.ts`
- `app/lib/db.ts`
- `app/hooks/*.ts`
- `app/lib/signalEngine.ts`

**Acceptance:** Grep shows no raw `30000`, `15000`, `100`, `5000`, `0.001` in business logic.

---

### 1.3 Add a `/api/health` endpoint

**Problem:** No visibility into whether exchanges, WebSockets, and MongoDB are healthy.

**Action:** Create `app/api/health/route.ts` returning JSON with `mongo`, `binance`, `bybit`, `okx`, and `delta` health status.

**Files to touch:**
- `app/api/health/route.ts` (new)
- `app/lib/wsManager.ts` — add `isHealthy(exchange)` method
- `app/lib/db.ts` — add `isHealthy()` check

**Acceptance:** `curl /api/health` returns 200 with accurate component statuses.

---

## Priority 2 — Make the code AI-friendly

### 2.1 Hide singletons behind typed ports

**Problem:** `WsManager`, `MarketCache`, `OnChainCache` are accessed via `globalThis`, creating hidden ordering dependencies.

**Action:** Define explicit interfaces (`MarketStreamPort`, `CachePort`, `PersistencePort`) in `app/shared/ports/` and make consumers depend on the interface, not the global.

**Files to touch:**
- `app/shared/ports/market-stream.ts` (new)
- `app/shared/ports/cache.ts` (new)
- `app/shared/ports/persistence.ts` (new)
- Refactor `app/lib/wsManager.ts`, `app/lib/marketCache.ts`, `app/lib/db.ts` to implement ports

**Acceptance:** No file imports a `globalThis` singleton directly; all access is via factory or constructor injection.

---

### 2.2 Break `app/page.tsx` into a composition layer

**Problem:** 294 lines, imports 17 components + 5 hooks, mixes data wiring with JSX layout.

**Action:**
1. Create `app/_dashboard/DashboardProviders.tsx` that wires all hooks and passes props down.
2. Reduce `app/page.tsx` to ~50 lines of JSX that imports `DashboardProviders`.

**Files to touch:**
- `app/_dashboard/DashboardProviders.tsx` (new)
- `app/page.tsx`

**Acceptance:** `page.tsx` contains no hook calls and no business logic.

---

### 2.3 Update `AGENTS.md` for the main app

**Problem:** `v2/.agents/AGENTS.md` is strong; `app/.agents/AGENTS.md` is minimal.

**Action:** Write `app/.agents/AGENTS.md` documenting:
- Data flow diagram (WS → SSE → hooks → components)
- File organization rules
- Port/singleton pattern
- Magic-number config location
- Type locations
- "Do not" rules (no new `globalThis`, no raw numbers, no silent catches)

**Files to touch:**
- `app/.agents/AGENTS.md` (new or rewrite)

**Acceptance:** A new AI agent can read `AGENTS.md` and make a safe first edit.

---

## Priority 3 — Testing (start small)

### 3.1 Add Vitest to the main app

**Problem:** `app/` has zero tests. Tests are the best way for LLMs to learn module contracts.

**Action:** Add root-level `vitest.config.ts` mirroring `v2/vitest.config.ts`.

**Files to touch:**
- `vitest.config.ts` (new)
- `package.json` — add test scripts

---

### 3.2 Test pure functions first

**Order:** parsers → indicators → signal math → BatchWriter → WsManager → route handlers → Playwright smoke.

**Files to add:**
- `app/lib/exchanges.test.ts`
- `app/lib/indicators.test.ts`
- `app/lib/signalEngine.test.ts`
- `app/lib/db.test.ts`
- `app/lib/wsManager.test.ts`
- `app/api/stream/route.test.ts`
- `e2e/smoke.spec.ts`

**Acceptance:** Each test file runs in under 30s; no flaky WS timing assertions.

---

## Priority 4 — Architecture & data

### 4.1 Convert MongoDB collections to time-series

**Problem:** `liquidations` and `market_snapshots` are regular collections with manual TTL. Time-series collections offer 5-10x compression and automatic indexing.

**Action:**
1. Create new time-series collections with `timeField` and `metaField`.
2. Migrate historical data.
3. Update `app/lib/db.ts` write/read paths.

**Acceptance:** Storage size for 30 days of liquidation data decreases measurably; queries by time range remain fast.

---

### 4.2 Hoist shared types to a workspace package

**Problem:** Liquidation, position, and ticker types exist in both `app/lib/exchanges.ts` and `v2/src/types.ts`.

**Action:**
1. Add `pnpm-workspace.yaml` at root.
2. Create `packages/shared-types/` with exchange/position/trade types.
3. Replace duplicated types in `app/` and `v2/` with imports from `@btcusd/shared-types`.

**Files to touch:**
- `pnpm-workspace.yaml` (new)
- `packages/shared-types/package.json` (new)
- `packages/shared-types/src/*.ts` (new)
- `app/lib/exchanges.ts`
- `v2/src/types.ts`

**Acceptance:** A field rename in the Delta API requires changes in only one place.

---

### 4.3 Add circuit breakers to external calls

**Problem:** No circuit breaker on REST/WS integrations or MongoDB writes.

**Action:** Add `opossum` to wrap:
- `resilientFetch.ts` exchange calls
- MongoDB batch inserts
- Delta Exchange API calls

**Files to touch:**
- `app/lib/resilientFetch.ts`
- `app/lib/db.ts`
- `app/api/trade/*` route handlers

**Acceptance:** Simulate 5 consecutive failures; the breaker opens and returns a fast failure instead of retrying.

---

### 4.4 Add OpenTelemetry traces

**Problem:** No distributed tracing or request-level observability.

**Action:** Add `@vercel/otel` and create `instrumentation.ts` at the project root. Trace WS reconnects, MongoDB operations, and route handlers.

**Files to touch:**
- `instrumentation.ts` (new)
- `package.json` — add `@vercel/otel`
- `app/lib/wsManager.ts` — add span annotations

**Acceptance:** Traces appear in local OTLP output or Vercel dashboard.

---

## Priority 5 — CSS & UI organization

### 5.1 Split `globals.css`

**Problem:** 958-line monolithic CSS file.

**Action:**
1. Keep `globals.css` for design tokens + reset only (~150 lines).
2. Move component styles to co-located CSS Modules (`LiquidationFeed.module.css`).
3. Extract reusable glassmorphism classes into `shared/ui/styles.css`.

**Files to touch:**
- `app/globals.css`
- `app/components/LiquidationFeed.module.css` (example)
- `app/shared/ui/styles.css` (new)

**Acceptance:** `globals.css` < 200 lines; no component-specific selectors remain.

---

## What NOT to do

- **Don't migrate to Tailwind, Redux, or Nx.** Current tool choices are fine; the problems are organizational.
- **Don't split into separate frontend/backend repos.** Next.js handles both well.
- **Don't introduce CSS-in-JS** (styled-components, Emotion). CSS Modules + RSC is the future-proof path.
- **Don't do a big-bang refactor.** Use the strangler pattern — one feature or one file at a time.

---

## Suggested execution order

| # | Task | Why first |
|---|------|-----------|
| 1 | Pino logging + health endpoint | Stops data loss and gives visibility |
| 2 | Centralized Zod config | Removes magic numbers, enables safe changes |
| 3 | Typed ports over singletons | Unlocks parallel refactors |
| 4 | Split `page.tsx` | Immediate AI/human readability win |
| 5 | Add `AGENTS.md` | Improves future AI coding quality |
| 6 | Vitest + pure-function tests | Creates safety net for subsequent refactors |
| 7 | Time-series MongoDB migration | Storage and query performance win |
| 8 | Shared types workspace | Eliminates duplication |
| 9 | Circuit breakers | Production resilience |
| 10 | OpenTelemetry traces | Observability at scale |
| 11 | CSS Modules split | UI maintainability |

---

## Full research background

See the detailed research report for best practices, trade-offs, and source citations:
- `.kimchi/docs/scalability-ai-coding-research.md`

Key internal references:
- `v2/.agents/AGENTS.md` — model for agent docs
- `v2/src/config/index.ts` — Zod config pattern to copy
- `v2/src/logger.ts` — Pino logging pattern to copy
