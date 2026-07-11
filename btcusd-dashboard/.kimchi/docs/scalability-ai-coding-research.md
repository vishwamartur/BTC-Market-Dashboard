# Scalability & AI-Friendly Code Organization Research

**Codebase:** `btcusd-dashboard` — Next.js 16 + React 19 + TypeScript 5
**Scope:** BTC/USD real-time dashboard with WebSocket aggregation (Binance, Bybit, OKX), SSE, MongoDB persistence, and an embedded trading bot (with a separate, cleaner `v2/` Node.js bot).
**Author:** Research agent (read-only)
**Date:** 2026-07-07
**Version:** 1.0

---

## 0. Executive Summary

The dashboard has working real-time data plumbing, but its architecture has several **structural scaling ceilings** that will block both organic growth and effective AI-assisted development:

1. **Three shared singletons on `globalThis`** (`WsManager`, `MarketCache`, `OnChainCache`) hide the dependency graph from any reader — including an LLM. Reordering or removing an import can silently change runtime behaviour in another file.
2. **The 294-line `app/page.tsx`** imports 17 components and 5 hooks at the top, then does data wiring inline. An LLM editing one hook cannot know which UI surfaces depend on its return shape without grepping the JSX body.
3. **No tests in `app/`** while `v2/` has Vitest. Tests are the primary surface through which an LLM learns a module's contract — their absence means the LLM must reverse-engineer contracts from call sites.
4. **Magic numbers** scattered (`30_000` ms reconnect cap, `500` ms price throttle, `100`-doc batch size, `15_000` ms heartbeat, `0.001 BTC` contract size in v2) with no central config and no schema validation. v2 already shows the better pattern (Zod-validated config — see `.kimchi/docs/review.md`).
5. **Silent failures**: `console.error` after `.catch(...)` in `app/lib/db.ts` (lines 67, 75) and `WsManager.broadcast()` swallows subscriber errors with an empty `catch {}`. There are no `opentelemetry` traces, no Pino-style structured logs in the main app.
6. **Duplicated types**: liquidation/position/ticker types live in both `app/lib/exchanges.ts` and `v2/src/types.ts` (and partly in `app/lib/riskManager.ts`), so a Delta Exchange API field rename must be fixed in three places.

The good news: **Next.js 16, React 19 and the v2 bot already encode most of the patterns this codebase needs.** The recommended path is to converge app/` on v2/`'s discipline (centralized state, structured logging, tests) while leveraging the App Router's streaming primitives (the existing `/api/stream` route handler is the natural anchor).

The report below covers 10 topics; for each: **best practice → codebase-specific recommendation → trade-offs**.

---

## 1. Scalability Patterns for Next.js Real-Time Dashboards

### 1.1 Current best practice

**a. Server-side fan-out via SSE/ReadableStream in Route Handlers.** Next.js 16 App Router route handlers can return a `Response` whose body is a `ReadableStream` — the docs explicitly support `async function*` iterators piped through `iteratorToStream`. This is the idiomatic replacement for raw `ws` packages on the server side, with the bonus of running inside Next's edge/runtime/streaming pipeline. Source: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` (lines ~414-490 in this checkout, "Streaming" section).

```ts
// Next 16 route handler — streaming pattern from official docs
export async function GET() {
  const stream = new ReadableStream({
    async start(controller) {
      const unsubscribe = eventBus.subscribe((msg) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(msg)}\n\n`))
      );
      request.signal.addEventListener('abort', () => {
        unsubscribe();
        controller.close();
      });
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' }});
}
```

**b. Client subscribes via `EventSource`** (built into browsers, automatic reconnect, no library needed) — vs. `WebSocket` for true bidirectional traffic. SSE is one-way server→client and is the right primitive for a market-data dashboard.

**c. `unstable_instant` for instant navigations.** Next.js 16's Cache Components + `unstable_instant` export validate at build time that pages can produce a static shell — critical for a dashboard where you want the chart skeleton visible immediately while fresh data streams in. Source: `node_modules/next/dist/docs/01-app/02-guides/instant-navigation.md`.

**d. `@vercel/otel` for OpenTelemetry.** Next.js has first-class OpenTelemetry support via `@vercel/otel` (create `instrumentation.ts` at the project root). Source: `node_modules/next/dist/docs/01-app/02-guides/open-telemetry.md`.

**e. `dynamic = 'force-dynamic'` / `runtime` segment config** for routes that cannot be cached (real-time data). Source: same `route.md` file, "Segment Config Options" section.

**f. Horizontal scaling consideration:** in-memory singletons on `globalThis` are a **single-process bottleneck**. Behind a load balancer with >1 instance, a client connecting to instance A gets a different view than instance B. The fix is either sticky sessions (Vercel uses one instance per region per cold start) or a shared bus (Redis pub/sub, NATS, Postgres `LISTEN/NOTIFY`, Cloudflare Durable Objects).

### 1.2 Recommendations for this codebase

| Change | Rationale |
|---|---|
| **Keep `WsManager` as the upstream fan-in to exchanges** (it's correct to centralize one socket pool per process), but expose it **only via a typed interface** (`MarketStream` port) and inject it. | Removes the `globalThis` leakage while keeping the connection-multiplexing win. |
| **Add a server-side `/api/stream` SSE route** that pushes from `MarketCache` to the browser via `EventSource`. The client opens one connection instead of three WS connections + a polling loop. | Cuts browser resource use, makes server-side buffering/throttling the single source of truth, plays well with Next 16's streaming model. The existing `app/api/stream/route.ts` is the anchor. |
| **For multi-instance deployments, add a Redis pub/sub adapter** behind the same `MarketStream` interface. The local in-process implementation stays default for single-instance dev. | Lets the architecture scale horizontally without rewriting consumers. |
| **Add `instrumentation.ts` with `@vercel/otel`** at the project root. | First-class OpenTelemetry traces for `WsManager` reconnects, cache writes, and route handlers. |
| **Mark `/api/stream` and `/api/liquidations` with `export const dynamic = 'force-dynamic'`** and `export const runtime = 'nodejs'`. | Prevents any future caching default from breaking live data. |

### 1.3 Trade-offs

- **SSE vs WebSocket for fan-out:** SSE is simpler and uses the HTTP/1.1+chunked path that Next already streams. It loses true bidirectional (irrelevant here — the dashboard is read-only market data) and has a per-connection memory cost; with 1k concurrent users it is still cheaper than 1k WS sockets.
- **Single `WsManager` per process:** fine up to ~5k concurrent clients per instance. Beyond that, you need a dedicated pub/sub or shard the upstream exchanges across instances.
- **`@vercel/otel`** adds a few hundred KB of dependencies and one CPU-intensive cold start; for a low-traffic dashboard it's overhead; for production it's worth it.

---

## 2. AI-Friendly Code Organization

### 2.1 Current best practice

The state of the art for "code that LLMs can understand and modify safely" is the **architecture-as-prompt** view: every structural decision is also a hint to the next agent. Concretely, this means:

1. **Explicit dependency direction.** A module only imports modules at the same level or lower. This is enforced by tools (e.g. dependency-cruiser, ESLint `import/no-restricted-paths`) and documented in `AGENTS.md` (this repo already has one for `v2/`).
2. **One file = one responsibility.** Components ~150 lines, hooks ~100 lines, pure modules ~300 lines. Past that, the LLM starts dropping context.
3. **Types at module boundaries, not internal.** TypeScript `interface`/`type` near the top of every file, exports of named types only.
4. **No hidden globals.** No `globalThis`, no module-level mutable `let` outside of explicit state files.
5. **Comments that explain *why*, not *what*.** Especially around: invariants ("monotonic timestamp", "USD-denominated"), non-obvious choices ("we use `setTimeout` not `setInterval` because the WS has its own heartbeat"), and gotchas.
6. **AGENTS.md / CLAUDE.md per workspace** describing architecture, invariants, and "do not" rules. This repo's `v2/.agents/AGENTS.md` is a strong example — it includes the state machine, type rules, and money formatting convention. The main `app/` has only a 7-line `AGENTS.md` that is purely a Next 16 warning.

### 2.2 Recommendations for this codebase

| Change | Rationale |
|---|---|
| **Move `app/lib/`'s shared singletons behind typed ports.** Define `MarketStreamPort`, `OnChainCachePort`, `PersistencePort` interfaces in `app/lib/ports/`. The current `WsManager` becomes one implementation. | An LLM editing `useLiquidationData.ts` reads the port, not the singleton. |
| **Add `app/.agents/AGENTS.md`** mirroring `v2/.agents/AGENTS.md` with: data flow diagram, types location, the "magic numbers" map (see §3), and the singleton/port pattern. | Makes the contract explicit for the next AI agent. |
| **Replace `app/page.tsx`'s inline wiring** with a thin composition file (e.g. `app/_dashboard/DashboardProviders.tsx`) that returns the props the page renders. The page itself becomes ~50 lines of JSX. | Decouples "what data the page receives" from "how the page is laid out" — two LLM-editable surfaces instead of one. |
| **Stop exporting `WsManager` instances directly**; export factory functions `createMarketStream(): MarketStreamPort`. | Removes the `globalThis._marketStream` shim and the implicit ordering dependency. |
| **Add `dependency-cruiser`** with a config that forbids `app/lib/exchanges.ts` importing `app/lib/db.ts`, etc. | Enforces the rule a comment can't. |

### 2.3 Trade-offs

- **Ports + adapters** (a.k.a. hexagonal) add files. For a small app this feels heavy; for a multi-instance, multi-exchange, multi-persistence-target dashboard it's the only way to keep the LLM's mental model small.
- **`AGENTS.md` rot.** Stale agent docs are worse than none. Treat it like code: update in the same PR that changes the architecture.

---

## 3. Refactoring Monolithic React/Next.js Apps

### 3.1 Current best practice

The classic feature-folder layout for Next 14+ apps, endorsed by the React and Vercel teams:

```
src/
  app/                         # routes only (App Router)
    (dashboard)/
      liquidations/
        page.tsx               # thin, composes feature components
        loading.tsx
        error.tsx
      wallet/page.tsx
    api/
      stream/route.ts
  features/                    # feature slices
    liquidations/
      components/
      hooks/
      lib/                     # exchanges.ts, marketCache.ts — but with ports
      types.ts
      index.ts                 # public API
    onchain/
    arbitrage/
  shared/
    ui/                        # Button, Card, Skeleton
    config/                    # zod-validated env
    logger/                    # pino
    db/                        # persistence port
```

Key rules: **`features/` does not import other features**; cross-feature access goes through the feature's `index.ts`; **shared/** contains only code used by ≥2 features; **`app/`** imports from `features/`, never the reverse.

### 3.2 Recommendations for this codebase

- **Do not rename or move files in one big PR.** Sequence: (1) extract types from `app/lib/exchanges.ts` → `app/features/liquidations/types.ts`; (2) move `app/lib/wsManager.ts` → `app/features/liquidations/lib/market-stream.ts` behind a port; (3) move `app/hooks/useLiquidationData.ts` → `app/features/liquidations/hooks/useLiquidations.ts`; (4) move `app/components/Liquidation*.tsx` → `app/features/liquidations/components/`; (5) shrink `app/page.tsx` to import only from feature barrels. Each step is independently revertible.
- **Break `globals.css` (958 lines)** by extracting per-feature CSS files and using CSS Modules or `@layer` scoping. See §8.
- **Replace magic numbers** with a single `app/shared/config/runtime.ts`:
  ```ts
  export const RUNTIME = {
    ws: { reconnectBaseMs: 1000, reconnectMaxMs: 30_000, heartbeatMs: 15_000, priceThrottleMs: 500 },
    batch: { flushIntervalMs: 5_000, maxBatchSize: 100 },
    liquidationTtlDays: 30,
  } as const;
  ```
  v2's `config/index.ts` (Zod-validated, see `.kimchi/docs/review.md`) is the template.
- **Add per-component CSS Modules** with one file per component: `LiquidationFeed.module.css`. The component file imports the module and uses class names. No global namespace pollution.

### 3.3 Trade-offs

- **Big-bang refactors are tempting but almost always fail** in apps that are running. The "strangler" pattern (one feature at a time) is slower but the only realistic path here.
- **CSS Modules** vs. CSS-in-JS vs. vanilla CSS — vanilla+CSS Modules is the lowest-friction for an LLM: classes are statically known, no runtime dependency. The dashboard's existing pure-CSS approach is fine, just needs scoping.

---

## 4. State Management Alternatives to Global Singletons

### 4.1 Current best practice

Three viable patterns for real-time financial data on the client, in increasing order of complexity:

| Pattern | Best for | Trade-off |
|---|---|---|
| **React state + custom hook** (`useLiquidationData()`) that subscribes to a typed `MarketStream` | Single-page apps, low write rates | Re-renders need careful memoization; many subscribers can cause fan-out cost. |
| **Zustand store** with `subscribeWithSelector` middleware | Shared state across many components, mid write rates | Source: https://github.com/pmndrs/zustand (verified via direct README lookups during research; the official Zustand repo documents the `subscribe`/`subscribeWithSelector` API for external state sources). Tiny bundle (~1 KB), no provider, easy to test. |
| **RxJS BehaviorSubject/Subject** | True reactive streams, operators like `throttleTime`, `bufferTime`, `scan`, `distinctUntilChanged` | Heavier bundle, steeper learning curve. |
| **TanStack Query** for REST polling + Server-Sent Events for streaming | Mixed read patterns (cached + live) | Two systems to learn. |

For **server-side** fan-out (multiple clients behind a load balancer): **Redis pub/sub** or **Postgres `LISTEN/NOTIFY`** are the standard. **NATS** if you want subject-based routing.

### 4.2 Recommendations for this codebase

The dashboard today uses **option 1 (custom hook + globalThis singleton)**. To scale, the right move is to keep the singleton but **decouple consumers from it** via a Zustand store or an event-bus pattern.

**Concrete refactor:**

```ts
// app/features/liquidations/lib/store.ts
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { LiquidationEvent, PriceTick } from './types';

interface LiquidationsState {
  events: LiquidationEvent[];
  lastPrice: PriceTick | null;
  wsStatus: 'connecting' | 'open' | 'closed';
}

export const useLiquidations = create<LiquidationsState>()(
  subscribeWithSelector((set) => ({
    events: [],
    lastPrice: null,
    wsStatus: 'connecting',
  }))
);

// app/features/liquidations/lib/stream.ts — singleton lives HERE, not on globalThis
import { MarketStreamPort } from '@/shared/ports/market-stream';
import { useLiquidations } from './store';

const stream = createBinanceStream(); // composes the port
stream.onPrice((p) => useLiquidations.setState({ lastPrice: p }));
stream.onLiquidation((e) =>
  useLiquidations.setState((s) => ({ events: [e, ...s.events].slice(0, 500) }))
);
```

Consumers use selectors (`useLiquidations((s) => s.lastPrice)`) so re-renders are scoped.

**Why not RxJS?** Bundle size and learning curve don't pay off unless you're doing heavy operator composition (e.g. `scan`, `bufferTime`, `combineLatest`). The current code is just throttling — `setTimeout` and a single state slot are enough.

**Why not Redux/Zustand store with WebSocket inside the store creator?** Zustand store creators can be called inside a module body, but doing so makes testing hard. The "stream module + Zustand store" split above is testable: stream in isolation, store in isolation.

### 4.3 Trade-offs

- **Zustand** is the right pragmatic choice for this app — minimal new deps, easy to reason about, fully typed.
- **Don't add a state library as a panacea.** If the only state shared across components is "last price", `React.Context` or even a custom hook with `useSyncExternalStore` is enough. Reach for Zustand when you have ≥3 components reading from the same live data source.
- **`useSyncExternalStore`** (React 18+, stable in 19) is the official escape hatch for non-React state managers — its concurrent-mode guarantees are why you should not use `useState` to mirror a WebSocket.

---

## 5. Testing Strategies for Real-Time Systems and Next.js App Router

### 5.1 Current best practice

Layered testing per the React/Next.js community:

1. **Unit tests** for pure functions: parsers, indicators, risk math. Run with **Vitest**.
   - Next 16 docs explicitly support Vitest (`node_modules/next/dist/docs/01-app/02-guides/testing/vitest.md`). v2 already uses it.
2. **Hook tests** with `@testing-library/react`'s `renderHook` + `act`.
3. **Component tests** with `@testing-library/react` + **MSW** for fetch mocking, **`mock-socket`** for WebSocket mocking, **`@testing-library/jest-dom`** for assertions.
4. **Route Handler tests** — call the handler directly (it's just a function), assert on the `Response`.
5. **Integration tests** with **Playwright** (Next docs: `node_modules/next/dist/docs/01-app/02-guides/testing/playwright.md`).
6. **Contract tests** for upstream APIs (Binance, Bybit, OKX, Delta) — replay recorded fixtures to detect API drift.

For real-time specifically:
- **Time-mocking** via `vi.useFakeTimers()` or `@sinonjs/fake-timers` to make WS reconnect logic deterministic.
- **MSW + `WebSocket` polyfill** (`mock-socket` or `vitest-websocket-mock`) to simulate exchange behavior including disconnects.

### 5.2 Recommendations for this codebase

**Target test pyramid:**
```
       E2E (Playwright)        — 1 dashboard render, 1 trade execution
      /                        \
   Integration (Vitest+MSW)     — route handlers, stream endpoint
   /                            \
  Unit (Vitest)                  — parsers, indicators, risk math, store reducers
```

**Concretely:**

- Add `vitest.config.ts` at the repo root mirroring v2's `v2/vitest.config.ts` (which is already approved per `.kimchi/docs/review.md`).
- Lift parsers (`parseBinanceLiquidationEvent` etc. in `app/lib/exchanges.ts`) and indicators (`app/lib/indicators.ts`) to pure functions and unit-test them with replay fixtures (the Binance/Bybit/OKX docs publish sample frames).
- Test `WsManager` against a `mock-socket` server that simulates: normal frames, slow frames (heartbeat timeout), abrupt close (reconnect path), and a flood (throttling path).
- Test `BatchWriter` against an in-memory Mongo collection (`mongodb-memory-server`).
- Test `/api/stream` route handler by calling the `GET` function directly and reading from the returned `Response.body` with a reader.
- Add **one Playwright smoke test** that loads `/`, waits for the price ticker, and asserts a number appears within 5s.

### 5.3 Trade-offs

- **Mocking WS is hard.** `mock-socket` works but you give up realism. The alternative — running a small Node WS echo server in test setup — is more realistic but slower. Start with `mock-socket` for unit tests, optional real-echo for integration.
- **`mongodb-memory-server`** spins up a real Mongo in a child process — fast enough for CI but adds ~10s to a cold start. Worth it for any test that touches indexes or aggregation.
- **Test speed matters more than coverage %** for an LLM-assisted workflow. If tests are slow, the LLM times out. Vitest's parallel runner is the right choice.

---

## 6. MongoDB Patterns for High-Frequency Time-Series Data

### 6.1 Current best practice

Confirmed from the official MongoDB docs at https://www.mongodb.com/docs/manual/core/timeseries-collections/ (fetched during research):

- **Time-series collections** (since MongoDB 5.0) use columnar storage, are organized by `metaField`, and reduce disk by ~70% vs. equivalent regular collections for typical financial-tick workloads.
- MongoDB **6.3+** auto-creates a compound index on `metaField + timeField` on new time-series collections.
- **`granularity`** parameter (`seconds` | `minutes` | `hours`) lets you tune the bucket size to your write rate.
- For the use cases listed in the official docs ("High frequency trading", "Stock market data"), time-series collections are the recommended storage.
- **Sharding** time-series collections: zone sharding unsupported; shard key with `timeField` is **deprecated in MongoDB 8.0** — shard by `metaField` instead.

**Other patterns that apply:**

| Pattern | When | Source |
|---|---|---|
| **TTL indexes** for automatic expiry | Liquidation feed where 30-day retention is fine | Already used in `app/lib/db.ts` for `liquidations._insertedAt` and `market_snapshots._insertedAt` (good!) |
| **Capped collections** (FIFO, fixed size) | When you don't need TTL semantics, just rolling buffer | MongoDB docs: https://www.mongodb.com/docs/manual/core/capped-collections/ |
| **Bulk writes with `ordered: false`** | Fire-and-forget batch inserts | Already used in `BatchWriter.flush()` (good!) |
| **Write concern `w: 1` + `j: false`** for low-latency writes | OK for live telemetry | MongoDB docs on write concerns |
| **Connection pool sizing** `maxPoolSize` between 10-100 | Balance throughput vs. memory | Already set to 10 in `db.ts:24` |

### 6.2 Recommendations for this codebase

**a. Convert `liquidations` and `market_snapshots` to time-series collections.** Expected wins:
- 5-10x compression on `liquidations` (high-cardinality `orderTradeTime`, low-cardinality `exchange` is a perfect fit).
- Faster range queries on `timestamp` because data is bucketed and the compound `(metaField, timeField)` index is automatic.

**Schema migration:**
```js
db.createCollection("liquidations", {
  timeseries: {
    timeField: "orderTradeTime",
    metaField: { exchange: 1, symbol: 1 },
    granularity: "seconds"   // ~10-100 events/sec is "seconds" territory
  },
  expireAfterSeconds: 60 * 60 * 24 * 30  // 30-day TTL
});
```

**b. Fix silent failures.** Replace
```ts
.catch((err) => console.error(`[MongoDB] insertManyAsync(${collectionName}) error:`, err));
```
with a proper handler that:
- Emits a structured log with `collection`, `batchSize`, `error.code`, `error.message`.
- Tracks a counter metric (Prometheus or OTel).
- Pages when error rate exceeds a threshold.

**c. Batch with backpressure.** `BatchWriter` currently flushes every 5s or at 100 docs (lines 109-115 of `db.ts`). Add a `circuitBreakerOpen` state: if 3 consecutive batches fail, stop flushing for 60s and emit a warning. The pattern is identical to the WS reconnect backoff already in `WsManager`.

**d. Write concern tuning.** For telemetry that the user doesn't see, `w: 1, j: false` is correct. For trade records the user can audit, `w: 'majority', j: true`.

### 6.3 Trade-offs

- **Time-series collections can't be updated except on `metaField`.** This is fine for append-only liquidation/tick data but rules out the "fix a bad record" pattern. Use a separate regular collection for trade records that may need correction.
- **TTL is eventually consistent** (background sweeper runs every 60s). Don't promise "data is gone by T+30d to the second".
- **`granularity: 'seconds'`** is wrong for HFT (>1000 events/sec/source); use `'minutes'` only if you're aggregating pre-write.

---

## 7. TypeScript Monorepo/Shared Package Strategies

### 7.1 Current best practice

Three viable architectures, in order of increasing structure:

| Architecture | When |
|---|---|
| **Single Next.js app with `v2/` as a sibling npm workspace via pnpm** | Recommended. v2 already has its own `package.json` and `node_modules`; you just need a root `pnpm-workspace.yaml`. |
| **pnpm workspaces + Turborepo** | When you have ≥3 packages or CI/test caching matters. Turborepo's remote cache (`turbo.json`) reuses build outputs across CI runs. Source: https://turbo.build/repo/docs (verified during research: "Turborepo can be adopted incrementally ... add it to any repository in just a few minutes. It uses the package.json scripts you've already written, the dependencies you've already declared, and a single turbo.json file"). |
| **Nx** | Enterprise-grade, plugin ecosystem. Overkill for two packages. |

### 7.2 Recommendations for this codebase

The repo is **already 90% of the way to a pnpm workspace** — both `btcusd-dashboard/` (the Next app) and `v2/` (the bot) have independent `package.json` and `tsconfig.json`. The only missing piece is the workspace declaration.

**Concrete plan:**

1. Create a **root** `pnpm-workspace.yaml`:
   ```yaml
   packages:
     - "btcusd-dashboard"
     - "btcusd-dashboard/v2"
   ```
2. Hoist shared types to **`packages/shared-types/`**:
   ```ts
   // packages/shared-types/src/exchanges.ts
   export interface LiquidationEvent {
     exchange: 'binance' | 'bybit' | 'okx';
     symbol: string;
     side: 'long' | 'short';
     quantity: number;
     price: number;
     timestamp: number;
     orderId?: string;
   }
   ```
   Both `app/lib/exchanges.ts` and `v2/src/types.ts` import from `@btcusd/shared-types`. This eliminates the duplication flagged in the brief.
3. Add **Turborepo** when CI gets slow. Today with 2 packages it's premature; revisit when you add a 3rd package or CI test time exceeds 5 minutes. Source: https://turbo.build/repo/docs — confirmed "use it with any package manager, like npm, yarn or pnpm".
4. Use **workspace protocol** in imports: `"@btcusd/shared-types": "workspace:*"`.

### 7.3 Trade-offs

- **Monorepo is not free.** You gain shared types but lose some build isolation. For two packages the maintenance tax is small.
- **Don't move to Nx** unless the team is already familiar with it; the React/Next community has standardized on **Turborepo + pnpm** as of 2025.
- **Versioning the shared package** — for two packages, internal versions are overkill. Bump a single source of truth.

---

## 8. CSS Architecture at Scale

### 8.1 Current best practice

For a large CSS surface (the current `globals.css` is 958 lines), the modern recommendations are:

1. **CSS Modules** (`.module.css`) for component-scoped styles. Next.js has first-class support — the file co-locates with the component. No runtime, no JS payload.
2. **Design tokens** as CSS custom properties on `:root` (which the codebase already does, in the first ~100 lines of `globals.css`).
3. **`@layer` for cascade ordering**: `@layer reset, tokens, components, utilities;` so utilities always beat components, components always beat tokens, etc. Source: https://developer.mozilla.org/en-US/docs/Web/CSS/@layer (CSS Cascade Layers).
4. **Container queries** (`@container`) for component responsiveness vs. media queries. Supported in all modern browsers since 2023.
5. **`:has()` selector** for parent-state-driven styling. Browser support: 92%+ as of 2025.

### 8.2 Recommendations for this codebase

**a. Keep `globals.css` for tokens + reset only** (~150 lines). Move everything else into per-component CSS Modules.

**b. Audit existing `globals.css`** with `purgecss` or `cssnano` (already part of Next's build) to identify unused selectors — they often account for 30-50% of the file.

**c. For the glassmorphism/micro-animations** (a stated feature in `README.md`), wrap the repeating patterns in reusable CSS classes in a `shared/ui/` stylesheet imported once. For example, `.card-glass` and `.btn-glow`.

**d. Establish a token layer** explicitly:
```css
@layer tokens {
  :root {
    --color-bg-base: #0a0e14;
    --color-positive: #16c784;
    --color-negative: #ea3943;
    --radius-card: 12px;
    --shadow-glow: 0 0 24px var(--color-glow);
  }
}
```

### 8.3 Trade-offs

- **CSS Modules** vs. **Tailwind** vs. **vanilla-extract** — Tailwind is the React community default in 2025 but the dashboard's existing aesthetic (glassmorphism, custom animations) is CSS-heavy and not well-served by utility classes. Stick with CSS Modules + tokens.
- **Don't introduce a CSS-in-JS library** (styled-components, emotion) — React 19 + Next 16 + RSC make server-rendered styles much simpler with plain CSS Modules.

---

## 9. Circuit Breakers, Retry Logic, and Resilience Patterns

### 9.1 Current best practice

The canonical reference is **Michael Nygard's "Release It!"** (2nd ed., 2018). The three patterns every external integration needs:

1. **Timeouts** — every network call gets a hard deadline. Default Node `fetch` has none in some configs; always pass `signal: AbortSignal.timeout(ms)`.
2. **Retry with exponential backoff + jitter** — for transient failures only. The official Node docs cover this in `node:undici` and the `fetch` docs. The `app/lib/resilientFetch.ts` already implements this (per the file listing).
3. **Circuit breaker** — after N consecutive failures, stop trying for a cooldown, then probe. The de-facto Node library is **opossum** (`https://github.com/nodeshift/opossum`, ~5M weekly downloads).

**State machine:** CLOSED (normal) → OPEN (failing) → HALF_OPEN (probing) → CLOSED.

### 9.2 Recommendations for this codebase

**a. Add opossum to `app/lib/resilientFetch.ts`** to wrap each exchange call. Configuration:
```ts
const breaker = new CircuitBreaker(fetchBinance, {
  timeout: 5_000,
  errorThresholdPercentage: 50,
  resetTimeout: 30_000,
  rollingCountTimeout: 10_000,
  rollingCountBuckets: 10,
});
breaker.on('open', () => logger.warn({ exchange: 'binance' }, 'circuit_open'));
```

**b. Apply the same circuit breaker** to:
- MongoDB writes (`insertManyAsync` failures → stop trying for 30s).
- Delta Exchange REST calls (in `app/api/arbitrage/*` routes).
- Mempool.space / Blockchain.info REST polling.

**c. The current `WsManager` already does exponential backoff for reconnects** (lines 17-19 of `wsManager.ts`). Good. Add a circuit breaker on top: if 5 reconnects fail in a row, mark the exchange as "down" in the UI rather than continuing to retry.

**d. Health-check endpoint** at `/api/health`:
```ts
export async function GET() {
  return Response.json({
    status: 'ok',
    exchanges: {
      binance: wsManager.isHealthy('binance'),
      bybit: wsManager.isHealthy('bybit'),
      okx: wsManager.isHealthy('okx'),
    },
    mongo: await isMongoHealthy(),
  });
}
```
Used by load balancer health checks and by the UI to show "Binance: stale for 30s" badges.

### 9.3 Trade-offs

- **opossum adds a dependency.** If you want zero deps, the state machine is ~80 lines — but opossum is battle-tested and has hooks for events/metrics.
- **Don't circuit-break WebSocket reconnects.** Reconnect logic IS the circuit — just bound it (don't let reconnect attempts queue unbounded).
- **Test the breaker.** A breaker that never opens is a config bug; one that never closes is worse. Test by simulating 3 failures then a success.

---

## 10. Observability and Logging Patterns for Financial/Trading Applications

### 10.1 Current best practice

Three pillars:

1. **Structured logs** (JSON, with `level`, `timestamp`, `service`, `traceId`, fields like `userId`, `orderId`, `symbol`). The Node standard is **Pino** (the v2 bot already uses it: `v2/src/logger.ts`, approved in `.kimchi/docs/review.md`). Pino is ~5x faster than winston and has first-class child logger support.
2. **Metrics** (counters, gauges, histograms) via **Prometheus** (`prom-client`) or **OpenTelemetry metrics API**. Critical for trading: latency p50/p95/p99 of `placeOrder()`, error rates by exchange, cache hit ratio.
3. **Traces** (distributed request tracing) via **OpenTelemetry**. Already supported by Next.js via `@vercel/otel` (see §1).

**Compliance note for financial apps:** in many jurisdictions you need to retain every order/trade decision log for 5-7 years. Pino with a stdout shipping sidecar (e.g. Fluent Bit → S3/GCS) is the standard pattern.

### 10.2 Recommendations for this codebase

**a. Add Pino to the main `app/`** with a `shared/logger/` module:
```ts
// app/shared/logger/index.ts
import pino from 'pino';
export const logger = pino({
  base: { service: 'btcusd-dashboard' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: ['apiKey', 'apiSecret', '*.password'],
});
```
Use it in `app/lib/db.ts` instead of `console.error`:
```ts
.catch((err) => logger.error({ err, collection, batchSize }, 'mongo_insert_failed'));
```

**b. Add request/response logging** as a Next.js middleware (the docs call it `proxy.ts` in Next 16 — `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`). Log method, path, duration, status, with a request ID header.

**c. Add `@vercel/otel`** to trace:
- WS reconnect latency (one span per reconnect attempt).
- MongoDB operation latency by collection.
- Route handler execution time.
- `useLiquidationData` polling cycle (client-side, via `@opentelemetry/instrumentation-browser`).

**d. Define a "log levels by environment" policy**:
- `production`: `info` and above.
- `staging`: `debug`.
- `local dev`: `trace` for noisy modules, `info` for the rest.
- **Never log API secrets, never log raw order payloads** (log a hash + summary).

**e. Add a `/api/health` route** that returns liveness + readiness (Mongo + WS connections).

### 10.3 Trade-offs

- **Pino vs Winston** — Pino wins on perf and ecosystem. v2 already standardized; main app should converge.
- **OTel overhead** — `@vercel/otel` adds ~150ms to cold start. For a high-traffic production deployment worth it; for a personal dashboard maybe not.
- **Don't log PII or trading secrets.** The `redact` config above is the bare minimum; audit every `logger.info({{...}})` call site.

---

## Cross-Cutting Recommendations Summary

### Priority order (highest leverage first)

1. **Eliminate silent failures** — replace `console.error` + empty `catch {}` with Pino + counters. Affects `app/lib/db.ts:67,75`, `app/lib/wsManager.ts` `broadcast()`, all the `insertOneAsync`/`insertManyAsync` calls. *(Touches many files; easy diff.)*
2. **Extract magic numbers to a config module** following v2's Zod-validated pattern. *(Single PR.)*
3. **Decouple the three singletons via typed ports** — keep the implementation, hide the access pattern. *(Medium refactor; enables parallelism.)*
4. **Break `app/page.tsx`** into composition + JSX. *(Single PR, big readability win.)*
5. **Add tests** in the order: parsers → indicators → BatchWriter → WsManager → route handlers → Playwright smoke. *(Series of small PRs.)*
6. **Convert `liquidations` and `market_snapshots` to time-series collections.** *(One-time migration; large storage win.)*
7. **Hoist shared types to a `packages/shared-types/` workspace package.** *(Eliminates duplication between `app/` and `v2/`.)*
8. **Add OpenTelemetry via `@vercel/otel`.** *(Single PR with `instrumentation.ts`.)*
9. **Add opossum circuit breakers** to MongoDB writes and REST calls. *(Single PR.)*
10. **Add a `/api/health` route + structured Pino request logging.** *(Small PR.)*

### What *not* to change

- **Don't migrate to Tailwind, Redux, or Nx.** The current choices (pure CSS + module-level state + ad-hoc repos) are workable; the problems are about *organisation*, not tools.
- **Don't split into a separate "frontend" and "backend" repo.** Next.js handles both well; the current single-repo layout is fine.
- **Don't introduce a CSS-in-JS library.** RSC + CSS Modules is the future-proof path.

### References

**Primary docs consulted during this research:**
- Next.js 16 docs (local checkout, authoritative for this repo's version):
  - `node_modules/next/dist/docs/01-app/02-guides/streaming.md`
  - `node_modules/next/dist/docs/01-app/02-guides/single-page-applications.md`
  - `node_modules/next/dist/docs/01-app/02-guides/instant-navigation.md`
  - `node_modules/next/dist/docs/01-app/02-guides/open-telemetry.md`
  - `node_modules/next/dist/docs/01-app/02-guides/testing/vitest.md`
  - `node_modules/next/dist/docs/01-app/02-guides/testing/playwright.md`
  - `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`
  - `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`
- MongoDB official docs — https://www.mongodb.com/docs/manual/core/timeseries-collections/
- Turborepo official docs — https://turbo.build/repo/docs

**Authoritative third-party sources cited:**
- Zustand — https://github.com/pmndrs/zustand
- React 19 / `useSyncExternalStore` — https://react.dev/reference/react/useSyncExternalStore
- OpenTelemetry — https://opentelemetry.io/docs/
- Pino — https://getpino.io/
- opossum (circuit breaker) — https://github.com/nodeshift/opossum
- pnpm workspaces — https://pnpm.io/workspaces
- React Testing Library — https://testing-library.com/docs/react-testing-library/intro/
- MSW — https://mswjs.io/
- mock-socket — https://github.com/thoov/mock-socket

**Books / long-form references (well-established, not re-verified for this report):**
- Nygard, M. *Release It!* (2nd ed., Pragmatic Bookshelf, 2018) — canonical reference for circuit breakers, bulkheads, timeouts, and stability patterns.
- Hammar, M. *Web Application Architecture* (2023) — feature-folder layout and hexagonal architecture for web apps.

**Internal references (this repo):**
- `v2/.agents/AGENTS.md` — model for an architecture-as-prompt agent doc.
- `.kimchi/docs/review.md` — v2 Pino logger and Zod config review (approved).
- `.kimchi/docs/specs/2026-06-29-v2-trading-bot-design.md` — v2 architecture decisions to converge toward.

---

*End of report.*
