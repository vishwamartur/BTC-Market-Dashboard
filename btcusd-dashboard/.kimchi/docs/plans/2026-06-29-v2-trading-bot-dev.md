# V2 Trading Bot Implementation Plan — Part 1 (Development)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a v2 BTC trading bot that achieves positive expected value after fees + slippage. Replaces v1's permissive risk thresholds and missing reconciliation with a pure-function core, hard 2× cost edge floor, slippage modeling, and tick-level position reconciliation.

**Architecture:** Standalone Node.js TypeScript process in `btcusd-dashboard/v2/`. Pure-function core (`features/`, `strategies/`, `risk/`) is deterministic and unit-testable. I/O lives only at the edges (`ingestion/`, `execution/`, `state/`, `monitor/`). Single 5-second main loop. Position reconciliation on every tick.

**Tech Stack:** TypeScript (strict), Node.js 20+, zod (config + event validation), mongodb driver, ws (WebSocket), vitest (tests), fast-check (property-based), pino (structured logging), undici (HTTP).

**Spec:** `btcusd-dashboard/.kimchi/docs/specs/2026-06-29-v2-trading-bot-design.md`
**Deployment tasks:** see Part 2 `2026-06-29-v2-trading-bot-deploy.md` (Tasks 23-30)

---

## File Structure

```
v2/
├── package.json, tsconfig.json, vitest.config.ts, .env.example, README.md
├── src/
│   ├── config/{index.ts, config.test.ts}
│   ├── logger.ts
│   ├── types.ts, types.test.ts
│   ├── ingestion/
│   │   ├── reconnectingWs.ts, reconnectingWs.test.ts
│   │   ├── binanceWs.ts, binanceWs.test.ts
│   │   ├── bybitWs.ts, bybitWs.test.ts
│   │   ├── okxWs.ts, okxWs.test.ts
│   │   ├── deltaRest.ts, deltaRest.test.ts
│   │   ├── mempool.ts, mempool.test.ts
│   │   └── blockchain.ts
│   ├── features/
│   │   ├── rollingWindow.ts, rollingWindow.test.ts
│   │   ├── indicators.ts, indicators.test.ts
│   │   ├── fundingZScore.ts, fundingZScore.test.ts
│   │   ├── liquidationImbalance.ts
│   │   └── snapshot.ts
│   ├── risk/
│   │   ├── edgeGate.ts, edgeGate.test.ts
│   │   ├── positionSize.ts, positionSize.test.ts
│   │   ├── brackets.ts, brackets.test.ts
│   │   └── evaluateHedge.ts, evaluateHedge.test.ts
│   ├── strategies/
│   │   ├── trendFollowing.ts, trendFollowing.test.ts
│   │   └── fundingMeanReversion.ts, fundingMeanReversion.test.ts
│   ├── state/{mongo.ts, mongo.test.ts}
│   ├── execution/{orderManager.ts, orderManager.test.ts}
│   ├── monitor/{heartbeat.ts, alerts.ts}
│   └── index.ts
└── tests/
    ├── backtest/{engine.ts, run.ts, walkforward.ts, fixtures/}
    └── shadow/compare.ts
```

---

## Tasks

### Task 1: Scaffold v2/ project

**Files:** Create `v2/package.json`, `v2/tsconfig.json`, `v2/vitest.config.ts`, `v2/.env.example`, `v2/README.md`, `v2/src/index.ts`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "btcusd-v2-bot",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "fast-check": "^3.18.0",
    "mongodb": "^6.10.0",
    "pino": "^9.5.0",
    "undici": "^6.21.0",
    "ws": "^8.18.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.16.10",
    "@types/ws": "^8.5.13",
    "tsx": "^4.19.1",
    "typescript": "^5.6.2",
    "vitest": "^2.1.2"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true, "esModuleInterop": true,
    "skipLibCheck": true, "outDir": "dist", "rootDir": "src",
    "resolveJsonModule": true, "declaration": false, "sourceMap": true
  },
  "include": ["src/**/*"], "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`** — defineConfig with v8 coverage, thresholds lines:90/functions:90/branches:85, include `src/features/**`, `src/strategies/**`, `src/risk/**`.

- [ ] **Step 4: Create `.env.example`**

```
DELTA_API_KEY=
DELTA_API_SECRET=
DELTA_BASE_URL=https://api.india.delta.exchange
MONGODB_URI=
HEARTBEAT_URL=
BOT_DISABLED=false
DRY_RUN=false
LOG_LEVEL=info
ACCOUNT_BALANCE_USD=1000
```

- [ ] **Step 5: Create `README.md`** (one paragraph: "v2 BTC trading bot. See `.kimchi/docs/specs/2026-06-29-v2-trading-bot-design.md` for design.")

- [ ] **Step 6: Create `src/index.ts`** with `console.log('v2 bot starting');`

- [ ] **Step 7:** `cd btcusd-dashboard/v2 && npm install` — verify success

- [ ] **Step 8:** `npm run build` — verify `dist/index.js` created

- [ ] **Step 9: Commit**

```bash
cd /Users/vishwa/Desktop/BTC-Market-Dashboard
git add btcusd-dashboard/v2/package.json btcusd-dashboard/v2/tsconfig.json \
        btcusd-dashboard/v2/vitest.config.ts btcusd-dashboard/v2/.env.example \
        btcusd-dashboard/v2/README.md btcusd-dashboard/v2/src/index.ts
git commit -m "feat(v2): scaffold standalone node project"
```

---

### Task 2: zod config + pino logger

**Files:** Create `v2/src/config/index.ts`, `v2/src/config/config.test.ts`, `v2/src/logger.ts`.

- [ ] **Step 1: Write failing test**

```ts
// v2/src/config/config.test.ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from './index.js';

describe('loadConfig', () => {
  it('rejects missing keys', () => {
    expect(() => loadConfig({})).toThrow(/DELTA_API_KEY/);
  });
  it('applies defaults', () => {
    const cfg = loadConfig({
      DELTA_API_KEY: 'k', DELTA_API_SECRET: 's',
      MONGODB_URI: 'mongodb://localhost', HEARTBEAT_URL: 'https://x.com',
    });
    expect(cfg.DELTA_BASE_URL).toBe('https://api.india.delta.exchange');
    expect(cfg.BOT_DISABLED).toBe(false);
    expect(cfg.ACCOUNT_BALANCE_USD).toBe(1000);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `cd btcusd-dashboard/v2 && npm test -- src/config`

- [ ] **Step 3: Implement `config/index.ts`**

```ts
import { z } from 'zod';
const Schema = z.object({
  DELTA_API_KEY: z.string().min(1),
  DELTA_API_SECRET: z.string().min(1),
  DELTA_BASE_URL: z.string().url().default('https://api.india.delta.exchange'),
  MONGODB_URI: z.string().min(1),
  HEARTBEAT_URL: z.string().url(),
  BOT_DISABLED: z.preprocess(v => v === 'true' || v === true, z.boolean()).default(false),
  DRY_RUN: z.preprocess(v => v === 'true' || v === true, z.boolean()).default(false),
  LOG_LEVEL: z.enum(['trace','debug','info','warn','error','fatal']).default('info'),
  ACCOUNT_BALANCE_USD: z.coerce.number().positive().default(1000),
});
export type Config = z.infer<typeof Schema>;
export function loadConfig(env: Record<string, string | undefined>): Config {
  const r = Schema.safeParse(env);
  if (!r.success) throw new Error(`Invalid config: ${r.error.issues.map(i => i.path.join('.')).join(', ')}`);
  return r.data;
}
```

- [ ] **Step 4: Implement `logger.ts`** — pino with `level: loadConfig(process.env).LOG_LEVEL`, base `{service: 'v2-bot'}`

- [ ] **Step 5: Run tests, verify pass**

- [ ] **Step 6: Commit** — `git commit -m "feat(v2): add zod-validated config and pino logger"`

---

### Task 3: Core domain types

**Files:** Create `v2/src/types.ts`, `v2/src/types.test.ts`.

- [ ] **Step 1: Write failing test**

```ts
// types.test.ts
import { describe, it, expect } from 'vitest';
import type { LiquidationEvent, Signal, ApprovedOrder, FeatureSnapshot, Position, Kline, PriceTick } from './types.js';

describe('types', () => {
  it('LiquidationEvent carries source identity', () => {
    const e: LiquidationEvent = { id: 'x', exchange: 'binance', symbol: 'BTCUSDT', side: 'SELL', originalQuantity: 1, price: 50000, orderTradeTime: Date.now(), usdValue: 50000 };
    expect(e.side).toBe('SELL');
  });
});
```

- [ ] **Step 2: Implement `types.ts`**

```ts
export type Exchange = 'binance' | 'bybit' | 'okx';

export interface LiquidationEvent {
  id: string; exchange: Exchange; symbol: string;
  side: 'BUY' | 'SELL'; originalQuantity: number;
  price: number; orderTradeTime: number; usdValue: number;
}

export interface PriceTick { symbol: string; price: number; timestamp: number; }

export interface Kline {
  openTime: number; open: number; high: number; low: number;
  close: number; volume: number; closeTime: number;
}

export interface FeatureSnapshot {
  currentPrice: number;
  trendEma50: number; trendEma200: number; atr14: number;
  fundingRate: number | null; fundingMA: number | null; fundingZScore: number | null;
  longLiquidationsUsd15m: number; shortLiquidationsUsd15m: number;
  liquidationImbalance: number;
  openInterest: number | null; oiChangePct: number | null;
  timestamp: number;
}

export type StrategyName = 'trend-following' | 'funding-mean-reversion';

export interface Signal {
  strategy: StrategyName;
  direction: 'BUY' | 'SELL';
  confidence: number; score: number;
  expectedValuePct: number; timestamp: number;
}

export interface ApprovedOrder {
  symbol: string; side: 'BUY' | 'SELL';
  size: number; leverage: number;
  entryPrice: number; stopLoss: number; takeProfit: number;
  reason: string; timestamp: number;
}

export interface Position {
  symbol: string; side: 'LONG' | 'SHORT';
  size: number; entryPrice: number | null;
  stopLoss: number; takeProfit: number;
  openedAt: number; entryFundingRate: number | null;
  peakPnl: number; strategy: StrategyName;
}
```

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit** — `git commit -m "feat(v2): define core domain types"`

---

### Task 4: Reconnecting WebSocket wrapper

**Files:** Create `v2/src/ingestion/reconnectingWs.ts`, `v2/src/ingestion/reconnectingWs.test.ts`.

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { ReconnectingWs } from './reconnectingWs.js';

describe('ReconnectingWs', () => {
  it('exposes start/stop', () => {
    const ws = new ReconnectingWs('wss://example.invalid', { parser: JSON.parse });
    expect(typeof ws.start).toBe('function');
    expect(typeof ws.stop).toBe('function');
  });
  it('caps backoff at maxBackoffMs', () => {
    const ws = new ReconnectingWs('wss://x', { parser: JSON.parse, initialBackoffMs: 100, maxBackoffMs: 5000 });
    expect((ws as any).nextBackoff(5000)).toBe(5000);
    expect((ws as any).nextBackoff(100)).toBe(200);
  });
});
```

- [ ] **Step 2: Implement `reconnectingWs.ts`** — class with `start()`, `stop()`, `onMessage(h)`, `nextBackoff(current)`. Uses `ws` package, exponential backoff, reconnects on close, parses via injected parser.

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit**

---

### Task 5: Binance liquidation + price WebSocket

**Files:** Create `v2/src/ingestion/binanceWs.ts`, `v2/src/ingestion/binanceWs.test.ts`.

- [ ] **Step 1: Write failing parser test**

```ts
import { describe, it, expect } from 'vitest';
import { parseBinanceLiquidation } from './binanceWs.js';

describe('parseBinanceLiquidation', () => {
  it('parses SELL liquidation', () => {
    const e = parseBinanceLiquidation({
      e: 'forceOrder', E: 1,
      o: { s: 'BTCUSDT', S: 'SELL', q: '0.5', p: '50000', T: 1 },
    });
    expect(e.exchange).toBe('binance');
    expect(e.side).toBe('SELL');
    expect(e.usdValue).toBe(25000);
  });
});
```

- [ ] **Step 2: Implement `binanceWs.ts`** — `parseBinanceLiquidation(raw): LiquidationEvent`, `startBinanceLiquidations(onEvent): ReconnectingWs`, `startBinancePriceStream(onTick)`. URLs: `wss://fstream.binance.com/ws/btcusdt@forceOrder`, `wss://fstream.binance.com/ws/btcusdt@markPrice@1s`.

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit**

---

### Task 6: Bybit liquidation WebSocket

**Files:** Create `v2/src/ingestion/bybitWs.ts`, `v2/src/ingestion/bybitWs.test.ts`.

- [ ] **Step 1: Write failing parser test** — note Bybit's `side: 'Buy'` means the taker bought to close, so liquidated side is the opposite (SELL means longs liquidated).

```ts
import { describe, it, expect } from 'vitest';
import { parseBybitLiquidation } from './bybitWs.js';

describe('parseBybitLiquidation', () => {
  it('parses Bybit liquidation.update', () => {
    const e = parseBybitLiquidation({
      topic: 'liquidation.BTCUSDT',
      data: { size: 0.2, price: 50000, side: 'Buy', updatedTime: 1, symbol: 'BTCUSDT' },
    });
    expect(e.side).toBe('SELL');
    expect(e.exchange).toBe('bybit');
  });
});
```

- [ ] **Step 2: Implement `bybitWs.ts`** — `parseBybitLiquidation`, `startBybitLiquidations(onEvent)`. URL: `wss://stream.bybit.com/v5/linear`. Subscribe message added in production code.

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit**

---

### Task 7: OKX liquidation WebSocket

**Files:** Create `v2/src/ingestion/okxWs.ts`, `v2/src/ingestion/okxWs.test.ts`.

- [ ] **Step 1: Write failing parser test**

```ts
import { describe, it, expect } from 'vitest';
import { parseOkxLiquidation } from './okxWs.js';

describe('parseOkxLiquidation', () => {
  it('parses OKX liquidations array', () => {
    const events = parseOkxLiquidation({
      arg: { channel: 'liquidations', instId: 'BTC-USDT-SWAP' },
      data: [{ side: 'sell', sz: '0.1', px: '50000', ts: '1' }],
    });
    expect(events.length).toBe(1);
    expect(events[0]!.side).toBe('SELL'); // sell-side = long liquidated
    expect(events[0]!.usdValue).toBe(5000);
  });
});
```

- [ ] **Step 2: Implement `okxWs.ts`** — `parseOkxLiquidation(raw): LiquidationEvent[]`, `startOkxLiquidations`. URL: `wss://ws.okx.com:8443/ws/v5/public`.

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit**

---

### Task 8: Delta REST client (funding, ticker, wallet, positions)

**Files:** Create `v2/src/ingestion/deltaRest.ts`, `v2/src/ingestion/deltaRest.test.ts`.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { signDeltaRequest, parseDeltaPosition } from './deltaRest.js';

describe('signDeltaRequest', () => {
  it('produces HMAC-SHA256 hex', () => {
    const sig = signDeltaRequest('GET', '/v2/wallet', '', '1700000000', 'secret');
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
  });
});
describe('parseDeltaPosition', () => {
  it('parses long', () => {
    const p = parseDeltaPosition({ product_id: 27, size: 10, side: 'long' }, 27);
    expect(p?.side).toBe('LONG');
  });
});
```

- [ ] **Step 2: Implement `deltaRest.ts`** — `signDeltaRequest(method, path, body, ts, secret)` using `crypto.createHmac('sha256', secret)`, `makeDeltaClient(baseUrl, apiKey, apiSecret)` returning object with `getFundingRate()`, `getTicker()`, `getWalletBalance()`, `getPositions()`. All use undici `request`. `parseDeltaPosition(raw, productId)` for position normalization.

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit**

---

### Task 9: Mempool + blockchain.info pollers

**Files:** Create `v2/src/ingestion/mempool.ts`, `v2/src/ingestion/blockchain.ts`, `v2/src/ingestion/mempool.test.ts`.

- [ ] **Step 1: Write failing parser test**

```ts
import { describe, it, expect } from 'vitest';
import { parseMempoolFees } from './mempool.js';
describe('parseMempoolFees', () => {
  it('parses fee recommendations', () => {
    const f = parseMempoolFees({ fastestFee: 50, halfHourFee: 30, hourFee: 20, economyFee: 10 });
    expect(f.fastestFee).toBe(50);
  });
});
```

- [ ] **Step 2: Implement `mempool.ts`** — `parseMempoolFees(raw): MempoolFees`, `fetchMempoolFees()`, `fetchRecentWhales(minBtc=100): Promise<WhaleTx[]>`. Use undici, log + return null on error.

- [ ] **Step 3: Implement `blockchain.ts`** — `fetchHashrateTrend(): Promise<HashratePoint[]>` from `https://api.blockchain.info/charts/hash-rate?timespan=30days`.

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Commit**

---

### Task 10: MongoDB connection

**Files:** Create `v2/src/state/mongo.ts`, `v2/src/state/mongo.test.ts`.

- [ ] **Step 1: Write failing test** (uses process.env.MONGODB_URI; skipped if MongoDB unavailable locally).

- [ ] **Step 2: Implement `mongo.ts`** — `startMongo(uri, dbName='btcusd_v2'): Promise<Db>`, `getDb(): Db`, `stopMongo()`. Singleton via module-level vars. Create indexes: `trades.{symbol:1, openedAt:-1}`, `trades.{closedAt:1}`, `signals.{timestamp:-1}`.

- [ ] **Step 3: Run tests, verify pass (or skip cleanly)**

- [ ] **Step 4: Commit**

---

### Task 11: Rolling window

**Files:** Create `v2/src/features/rollingWindow.ts`, `v2/src/features/rollingWindow.test.ts`.

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { RollingWindow } from './rollingWindow.js';

describe('RollingWindow', () => {
  it('keeps only events within windowMs of now', () => {
    const w = new RollingWindow<{v:number;t:number}>(15 * 60 * 1000);
    const now = 1_700_000_000_000;
    w.add({ v: 1, t: now - 10 * 60_000 }, now);
    w.add({ v: 2, t: now - 20 * 60_000 }, now);
    expect(w.values(now).map(e => e.v)).toEqual([1]);
  });
});
```

- [ ] **Step 2: Implement** — `RollingWindow<T extends {t:number}>` with `add(e, now)`, `evict(now)`, `values(now)`, `sumUsd(now)`.

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit**

---

### Task 12: Technical indicators (ATR, EMA)

**Files:** Create `v2/src/features/indicators.ts`, `v2/src/features/indicators.test.ts`.

- [ ] **Step 1: Write failing tests** — verify EMA returns empty when too short, returns valid value otherwise; ATR returns 0 for too-few klines, positive value otherwise.

- [ ] **Step 2: Implement `indicators.ts`**

```ts
import type { Kline } from '../types.js';

export function ema(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function atr(klines: Kline[], period = 14): number {
  if (klines.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < klines.length; i++) {
    const k = klines[i]!, p = klines[i-1]!;
    trs.push(Math.max(k.high - k.low, Math.abs(k.high - p.close), Math.abs(k.low - p.close)));
  }
  return ema(trs, period).at(-1) ?? 0;
}
```

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit**

---

### Task 13: Funding z-score + liquidation imbalance

**Files:** Create `v2/src/features/fundingZScore.ts`, `v2/src/features/liquidationImbalance.ts`, `v2/src/features/fundingZScore.test.ts`.

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { fundingZScore } from './fundingZScore.js';
describe('fundingZScore', () => {
  it('returns 0 when fewer than 8 samples', () => {
    expect(fundingZScore([0.01, 0.02], 0.015)).toBe(0);
  });
  it('returns positive when current is above mean', () => {
    const samples = [0.01,0.011,0.012,0.013,0.014,0.015,0.016,0.017];
    expect(fundingZScore(samples, 0.02)).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Implement `fundingZScore.ts`** — `fundingZScore(samples, current)`: mean + std, return (current - mean) / std.

- [ ] **Step 3: Implement `liquidationImbalance.ts`** — `liquidationImbalance(longUsd, shortUsd) = (long - short) / (long + short)` (range -1..1, 0 if total=0).

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Commit**

---

### Task 14: FeatureSnapshot assembly

**Files:** Create `v2/src/features/snapshot.ts`.

- [ ] **Step 1: Implement (pure)**

```ts
import type { FeatureSnapshot, LiquidationEvent, Kline } from '../types.js';
import { ema, atr } from './indicators.js';
import { fundingZScore } from './fundingZScore.js';
import { liquidationImbalance } from './liquidationImbalance.js';

export interface SnapshotInputs {
  currentPrice: number; klines: Kline[];
  liquidations15m: LiquidationEvent[];
  fundingHistory: number[]; currentFunding: number | null;
  openInterest: number | null; oiHistory: number[];
  timestamp: number;
}

export function buildSnapshot(input: SnapshotInputs): FeatureSnapshot {
  const closes = input.klines.map(k => k.close);
  let longUsd = 0, shortUsd = 0;
  for (const e of input.liquidations15m) {
    if (e.side === 'BUY') shortUsd += e.usdValue; else longUsd += e.usdValue;
  }
  const fundingMA = input.fundingHistory.length
    ? input.fundingHistory.reduce((a, b) => a + b, 0) / input.fundingHistory.length : null;
  const z = input.currentFunding !== null ? fundingZScore(input.fundingHistory, input.currentFunding) : null;
  let oiChange: number | null = null;
  if (input.oiHistory.length >= 2 && input.openInterest !== null && input.oiHistory[0]! > 0) {
    oiChange = (input.openInterest - input.oiHistory[0]!) / input.oiHistory[0]!;
  }
  return {
    currentPrice: input.currentPrice,
    trendEma50: ema(closes, 50).at(-1) ?? 0,
    trendEma200: ema(closes, 200).at(-1) ?? 0,
    atr14: atr(input.klines, 14),
    fundingRate: input.currentFunding, fundingMA, fundingZScore: z,
    longLiquidationsUsd15m: longUsd, shortLiquidationsUsd15m: shortUsd,
    liquidationImbalance: liquidationImbalance(longUsd, shortUsd),
    openInterest: input.openInterest, oiChangePct: oiChange,
    timestamp: input.timestamp,
  };
}
```

- [ ] **Step 2: Verify build** — `npm run build` succeeds

- [ ] **Step 3: Commit**

---

### Task 15: Strategy A — trend-following with liquidation exhaustion

**Files:** Create `v2/src/strategies/trendFollowing.ts`, `v2/src/strategies/trendFollowing.test.ts`.

- [ ] **Step 1: Write failing test** — emits BUY on uptrend + pullback + short liquidations; rejects bear trend; rejects low confidence.

- [ ] **Step 2: Implement**

```ts
import type { FeatureSnapshot, Signal } from '../types.js';

const MIN_CONFIDENCE = 60;
const MIN_IMBALANCE = 0.2;
const PULLBACK_ATR_MULT = 1.5;

export function trendFollowing(s: FeatureSnapshot): Signal[] {
  const uptrend = s.trendEma50 > s.trendEma200;
  const downtrend = s.trendEma50 < s.trendEma200;
  const distToEma = Math.abs(s.currentPrice - s.trendEma50);
  const pullback = distToEma <= PULLBACK_ATR_MULT * s.atr14;
  if (!pullback || s.atr14 === 0) return [];

  if (uptrend && s.liquidationImbalance >= MIN_IMBALANCE) {
    const skew = (s.liquidationImbalance - MIN_IMBALANCE) / (1 - MIN_IMBALANCE);
    const pullbackStrength = 1 - distToEma / (PULLBACK_ATR_MULT * s.atr14);
    const confidence = clamp(Math.round(60 + 40 * Math.min(1, skew * 0.5 + pullbackStrength * 0.5)), 60, 95);
    return [mkSignal('BUY', confidence, s)];
  }
  if (downtrend && s.liquidationImbalance <= -MIN_IMBALANCE) {
    const skew = (Math.abs(s.liquidationImbalance) - MIN_IMBALANCE) / (1 - MIN_IMBALANCE);
    const pullbackStrength = 1 - distToEma / (PULLBACK_ATR_MULT * s.atr14);
    const confidence = clamp(Math.round(60 + 40 * Math.min(1, skew * 0.5 + pullbackStrength * 0.5)), 60, 95);
    return [mkSignal('SELL', confidence, s)];
  }
  return [];
}

function mkSignal(direction: 'BUY'|'SELL', confidence: number, s: FeatureSnapshot): Signal {
  const ev = (confidence/100) * 0.005 - (1 - confidence/100) * 0.002;
  return {
    strategy: 'trend-following', direction, confidence,
    score: direction === 'BUY' ? confidence/100 : -confidence/100,
    expectedValuePct: ev, timestamp: s.timestamp,
  };
}
function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }
```

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit**

---

### Task 16: Strategy B — funding-rate mean-reversion

**Files:** Create `v2/src/strategies/fundingMeanReversion.ts`, `v2/src/strategies/fundingMeanReversion.test.ts`.

- [ ] **Step 1: Write failing test** — emits SELL on extreme positive funding in non-bull trend; rejects mild funding; rejects strong counter-trend.

- [ ] **Step 2: Implement**

```ts
import type { FeatureSnapshot, Signal } from '../types.js';

const MIN_FUNDING = 0.0005;
const MIN_ZSCORE = 1.5;
const MIN_CONFIDENCE = 60;

export function fundingMeanReversion(s: FeatureSnapshot): Signal[] {
  if (s.fundingRate === null || s.fundingZScore === null) return [];
  if (Math.abs(s.fundingRate) < MIN_FUNDING) return [];
  if (Math.abs(s.fundingZScore) < MIN_ZSCORE) return [];

  const direction: 'BUY' | 'SELL' = s.fundingRate > 0 ? 'SELL' : 'BUY';
  const strongUptrend = s.currentPrice > s.trendEma200 * 1.02 && s.trendEma50 > s.trendEma200;
  const strongDowntrend = s.currentPrice < s.trendEma200 * 0.98 && s.trendEma50 < s.trendEma200;
  if (direction === 'SELL' && strongUptrend) return [];
  if (direction === 'BUY' && strongDowntrend) return [];

  const confidence = Math.min(95, Math.round(60 + 35 * Math.min(1, (Math.abs(s.fundingZScore) - MIN_ZSCORE) / 3)));
  if (confidence < MIN_CONFIDENCE) return [];

  const funding24h = Math.abs(s.fundingRate) * 3;
  const ev = funding24h - 0.002; // round-trip cost estimate

  return [{
    strategy: 'funding-mean-reversion', direction, confidence,
    score: direction === 'BUY' ? confidence/100 : -confidence/100,
    expectedValuePct: ev, timestamp: s.timestamp,
  }];
}
```

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit**

---

### Task 17: Risk edge gate (property-based tested)

**Files:** Create `v2/src/risk/edgeGate.ts`, `v2/src/risk/edgeGate.test.ts`.

- [ ] **Step 1: Write property-based test**

```ts
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { edgeGate } from './edgeGate.js';
import type { Signal } from '../types.js';

const arbSignal: fc.Arbitrary<Signal> = fc.record({
  strategy: fc.constantFrom('trend-following','funding-mean-reversion' as const),
  direction: fc.constantFrom('BUY','SELL' as const),
  confidence: fc.float({ min: 0, max: 100 }),
  score: fc.float({ min: -1, max: 1 }),
  expectedValuePct: fc.float({ min: -0.01, max: 0.01 }),
  timestamp: fc.integer(),
});

describe('edgeGate', () => {
  it('rejects when confidence below 60', () => {
    fc.assert(fc.property(arbSignal, (sig) => {
      if (sig.confidence < 60) {
        expect(edgeGate(sig, { openPositions: 0, totalDailyPnlPct: 0, lastEntryAt: 0, now: 1e9 })).toBeNull();
      }
    }));
  });
  it('rejects when EV below 2x cost', () => {
    fc.assert(fc.property(arbSignal, (sig) => {
      const out = edgeGate(sig, { openPositions: 0, totalDailyPnlPct: 0, lastEntryAt: 0, now: 1e9 });
      if (out && sig.expectedValuePct < 0.004) throw new Error('gate leaked low-EV signal');
    }));
  });
  it('rejects daily loss > 3%', () => {
    const sig: Signal = { strategy: 'trend-following', direction: 'BUY', confidence: 80, score: 0.8, expectedValuePct: 0.005, timestamp: 0 };
    expect(edgeGate(sig, { openPositions: 0, totalDailyPnlPct: -0.04, lastEntryAt: 0, now: 0 })).toBeNull();
  });
  it('rejects too many positions', () => {
    const sig: Signal = { strategy: 'trend-following', direction: 'BUY', confidence: 80, score: 0.8, expectedValuePct: 0.005, timestamp: 0 };
    expect(edgeGate(sig, { openPositions: 2, totalDailyPnlPct: 0, lastEntryAt: 0, now: 0 })).toBeNull();
  });
  it('rejects within cooldown', () => {
    const sig: Signal = { strategy: 'trend-following', direction: 'BUY', confidence: 80, score: 0.8, expectedValuePct: 0.005, timestamp: 0 };
    expect(edgeGate(sig, { openPositions: 0, totalDailyPnlPct: 0, lastEntryAt: 60_000, now: 100_000 })).toBeNull();
  });
  it('passes a strong signal', () => {
    const sig: Signal = { strategy: 'trend-following', direction: 'BUY', confidence: 80, score: 0.8, expectedValuePct: 0.005, timestamp: 0 };
    expect(edgeGate(sig, { openPositions: 0, totalDailyPnlPct: 0, lastEntryAt: 0, now: 1e9 })).not.toBeNull();
  });
});
```

- [ ] **Step 2: Implement `edgeGate.ts`**

```ts
import type { Signal } from '../types.js';
export interface GateContext {
  openPositions: number; totalDailyPnlPct: number;
  lastEntryAt: number; now: number;
}
const MIN_CONFIDENCE = 60;
const ROUND_TRIP_COST_PCT = 0.002;
const EDGE_MULTIPLE = 2.0;
const MAX_OPEN_POSITIONS = 2;
const DAILY_LOSS_LIMIT_PCT = -0.03;
const COOLDOWN_MS = 15 * 60 * 1000;

export function edgeGate(sig: Signal, ctx: GateContext): Signal | null {
  if (sig.confidence < MIN_CONFIDENCE) return null;
  if (sig.expectedValuePct < EDGE_MULTIPLE * ROUND_TRIP_COST_PCT) return null;
  if (ctx.totalDailyPnlPct <= DAILY_LOSS_LIMIT_PCT) return null;
  if (ctx.openPositions >= MAX_OPEN_POSITIONS) return null;
  if (ctx.now - ctx.lastEntryAt < COOLDOWN_MS) return null;
  return sig;
}
```

- [ ] **Step 3: Run tests, verify pass (CI should set numRuns: 10000 in vitest config)**

- [ ] **Step 4: Commit**

---

### Task 18: Position sizing + SL/TP brackets

**Files:** Create `v2/src/risk/positionSize.ts`, `v2/src/risk/brackets.ts`, both with `.test.ts`.

- [ ] **Step 1: Write failing brackets test** — SL/TP distance + R:R ≥ 2.

- [ ] **Step 2: Implement `brackets.ts`**

```ts
const SL_ATR_MULT = 1.5;
const RR_RATIO = 2.0;
export function brackets(side: 'BUY'|'SELL', entry: number, atr: number) {
  const slDist = SL_ATR_MULT * atr;
  const tpDist = slDist * RR_RATIO;
  return side === 'BUY'
    ? { stopLoss: r2(entry - slDist), takeProfit: r2(entry + tpDist) }
    : { stopLoss: r2(entry + slDist), takeProfit: r2(entry - tpDist) };
}
const r2 = (n: number) => Math.round(n * 100) / 100;
```

- [ ] **Step 3: Write failing position-size test** — risk cap respected, size scales with confidence.

- [ ] **Step 4: Implement `positionSize.ts`**

```ts
export interface SizeInputs {
  confidence: number; equityUsd: number; currentPrice: number;
  atr: number; contractSizeBtc: number; maxLeverage: number;
}
const MAX_RISK_PCT = 0.01;
const KELLY_FRACTION = 0.25;
const SL_ATR_MULT = 1.5;
const MIN_SIZE = 1;
const MAX_SIZE = 40;

export function positionSize(i: SizeInputs): number {
  const stopDist = SL_ATR_MULT * i.atr;
  const stopDistPct = stopDist / i.currentPrice;
  const maxRiskUsd = i.equityUsd * MAX_RISK_PCT;
  const riskPerContract = stopDistPct * i.contractSizeBtc * i.currentPrice;
  if (riskPerContract <= 0) return MIN_SIZE;
  const sizeByRisk = Math.floor(maxRiskUsd / riskPerContract);
  const kellySized = Math.floor(KELLY_FRACTION * (i.confidence/100 * (MAX_SIZE - MIN_SIZE) + MIN_SIZE));
  const maxAffordable = Math.floor((i.equityUsd * i.maxLeverage * 0.8) / (i.contractSizeBtc * i.currentPrice));
  return Math.max(MIN_SIZE, Math.min(sizeByRisk, kellySized, maxAffordable, MAX_SIZE));
}
```

- [ ] **Step 5: Run tests, verify pass**

- [ ] **Step 6: Commit**

---

### Task 19: Hedge position management

**Files:** Create `v2/src/risk/evaluateHedge.ts`, `v2/src/risk/evaluateHedge.test.ts`.

- [ ] **Step 1: Write failing tests** — CLOSE when funding normalized to <30% of entry; HOLD when funding still meaningful.

- [ ] **Step 2: Implement `evaluateHedge.ts`** — function that takes hedge context (side, entryPrice, currentPrice, entryFundingRate, currentFundingRate, entryTime, peakPnl, original SL/TP, size, signal) and returns `{action, reason, newStopLoss?, newTakeProfit?}`. Actions: HOLD | CLOSE | TIGHTEN_STOP | WIDEN_TP | CONVERT_DIRECTIONAL. Logic order:
  1. CLOSE if current funding < 30% of entry funding OR funding sign flipped
  2. TIGHTEN_STOP if price move < -0.5% and > -0.75%
  3. WIDEN_TP if price move > +0.5%
  4. HOLD otherwise

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit**

---

### Task 20: OrderManager (placement + retry + fill tracking)

**Files:** Create `v2/src/execution/orderManager.ts`, `v2/src/execution/orderManager.test.ts`.

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { OrderManager } from './orderManager.js';

describe('OrderManager', () => {
  it('places order and returns fill', async () => {
    const om = new OrderManager({
      placeOrder: vi.fn().mockResolvedValue({ id: 'o-1', status: 'pending' }),
      pollFill: vi.fn().mockResolvedValue({ filled: true, avgPrice: 50000 }),
      dryRun: true,
    });
    const r = await om.submit({ symbol: 'BTCUSD', side: 'BUY', size: 5, leverage: 5, type: 'market', reduceOnly: false });
    expect(r.id).toBe('o-1');
    expect(r.avgFillPrice).toBe(50000);
  });
  it('retries on transient failure', async () => {
    const place = vi.fn()
      .mockRejectedValueOnce(new Error('net'))
      .mockResolvedValueOnce({ id: 'o-2', status: 'pending' });
    const om = new OrderManager({
      placeOrder: place as any,
      pollFill: vi.fn().mockResolvedValue({ filled: true, avgPrice: 50000 }),
      dryRun: true, maxRetries: 3,
    });
    const r = await om.submit({ symbol: 'BTCUSD', side: 'BUY', size: 5, leverage: 5, type: 'market', reduceOnly: false });
    expect(place).toHaveBeenCalledTimes(2);
    expect(r.id).toBe('o-2');
  });
});
```

- [ ] **Step 2: Implement `orderManager.ts`** — `OrderManager` class with `submit(req): Promise<FillResult>`. Retries on failure with exponential backoff (1s base, 2^n multiplier). Polls for fill every 500ms up to 10s. Auto-generates `clientOrderId = v2-{ts}-{rand}` for idempotency.

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit**

---

### Task 21: Monitor — heartbeat + alerts

**Files:** Create `v2/src/monitor/heartbeat.ts`, `v2/src/monitor/alerts.ts`.

- [ ] **Step 1: Implement `heartbeat.ts`**

```ts
import { request } from 'undici';
import { logger } from '../logger.js';

export interface HeartbeatState {
  uptime: number; lastTickMs: number;
  openPositions: number; dailyPnl: number; equity: number;
}
export class Heartbeat {
  private failures = 0; private timer: NodeJS.Timeout | null = null;
  constructor(private url: string, private intervalMs = 60_000) {}
  start(state: () => HeartbeatState) {
    const send = async () => {
      try {
        const s = state();
        await request(this.url, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(s) });
        this.failures = 0;
      } catch (err) {
        this.failures++;
        logger.warn({ failures: this.failures, err }, 'heartbeat failed');
        if (this.failures >= 3) logger.fatal({ failures: this.failures }, 'heartbeat failed 3 times');
      }
    };
    this.timer = setInterval(send, this.intervalMs);
  }
  stop() { if (this.timer) clearInterval(this.timer); }
}
```

- [ ] **Step 2: Implement `alerts.ts`** — `critical(msg, meta)` function. POSTs to `process.env.TELEGRAM_BOT_URL` if set. Logs fatal.

- [ ] **Step 3: Verify build, commit**

---

### Task 22: Wire main loop

**Files:** Modify `v2/src/index.ts`.

- [ ] **Step 1: Implement main loop** — load config → start mongo → start ingestion (Binance/Bybit/OKX liquidations → RollingWindow; Binance price stream → currentPrice; hourly Delta refresh of ticker + funding history) → start OrderManager (DRY_RUN-aware) → start Heartbeat → setInterval 5s tick:
  - Skip if `BOT_DISABLED`
  - Build SnapshotInputs (klines = empty in dev — production wiring needed; see note below)
  - If klines.length < 200: skip strategy evaluation
  - buildSnapshot → run both strategies → for each Signal: edgeGate → positionSize → brackets → om.submit → db.trades.insertOne

- [ ] **Step 2: Build verify** — `npm run build` succeeds

- [ ] **Step 3: Run all tests** — `npm test` — all pass

- [ ] **Step 4: Commit**

> **Production-wiring note (deferred to live rollout phase):** The executor must wire the following before live:
> 1. Real Delta order-placement in `OrderManager` (currently stubbed in DRY_RUN=true path)
> 2. 4h klines fetching in `index.ts` (currently empty; populate from Delta REST or Binance public API)
> 3. Daily P&L aggregation from `db.trades` for `totalDailyPnlPct` in the gate context
> 4. Position reconciliation against live Delta positions (every tick + every restart)

---

## Self-Review

**Spec coverage:**
- ✓ Scaffolding → Task 1; Config + logger → Task 2; Types → Task 3
- ✓ Ingestion (Binance/Bybit/OKX/Delta/mempool/blockchain) → Tasks 4-9
- ✓ State (Mongo, rolling windows, features, snapshot) → Tasks 10-14
- ✓ Strategies A + B → Tasks 15-16
- ✓ Risk gate (edge gate, sizing, brackets, hedge eval) → Tasks 17-19
- ✓ Execution → Task 20
- ✓ Monitor → Task 21
- ✓ Main loop → Task 22

**Placeholder scan:** Production-wiring gaps in Task 22 are explicitly listed and deferred to live phase per spec.

**Type consistency:** `LiquidationEvent`, `Signal`, `ApprovedOrder`, `Position`, `FeatureSnapshot`, `Kline`, `PriceTick` defined in Task 3 and used consistently.

See Part 2 (`2026-06-29-v2-trading-bot-deploy.md`) for Tasks 23-30 (backtest, walk-forward, shadow, paper, 3-phase live rollout, v1 decommission).
