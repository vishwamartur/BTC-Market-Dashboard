# Hedge Positions Payoff Graph — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hedge-positions payoff graph card to the main dashboard and wallet pages, showing the theoretical short-straddle payoff curve and realized/unrealized P&L history.

**Architecture:** A new API route (`/api/hedge/payoff`) reads live option positions and fills from Delta Exchange, then uses pure helpers in `app/lib/hedgePayoff.ts` to compute the payoff curve and P&L history. A new canvas-based React component (`app/components/HedgePayoffChart.tsx`) fetches and renders the data on both pages.

**Tech Stack:** Next.js 16, React 19, TypeScript, Node built-in test runner (`node:test`), canvas 2D API.

---

## File Map

- **Create:** `app/lib/hedgePayoff.ts` — payoff and P&L-history calculations.
- **Create:** `app/lib/hedgePayoff.test.ts` — unit tests.
- **Create:** `app/api/hedge/payoff/route.ts` — API route.
- **Create:** `app/components/HedgePayoffChart.tsx` — chart card component.
- **Modify:** `app/page.tsx` — insert component on the dashboard.
- **Modify:** `app/wallet/page.tsx` — insert component on the wallet page.

---

## Task 1: Payoff calculation helpers + tests

**Complexity:** simple

**Files:**
- Create: `app/lib/hedgePayoff.ts`
- Create: `app/lib/hedgePayoff.test.ts`

### Step 1.1: Write failing tests

Create `app/lib/hedgePayoff.test.ts`:

```typescript
/**
 * Unit tests for hedge payoff calculations.
 * Run with: npx tsx --test app/lib/hedgePayoff.test.ts
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  parseOptionStrike,
  isOptionSymbol,
  buildPayoffCurve,
  buildPnlHistory,
  type OptionPosition,
  type RawFill,
} from './hedgePayoff.js';

describe('parseOptionStrike', () => {
  it('extracts strike from C-108000-250711', () => {
    assert.equal(parseOptionStrike('C-108000-250711'), 108000);
  });

  it('extracts strike from P-95000-250711', () => {
    assert.equal(parseOptionStrike('P-95000-250711'), 95000);
  });

  it('returns null for non-option symbols', () => {
    assert.equal(parseOptionStrike('BTCUSDT'), null);
  });

  it('returns null for malformed option symbols', () => {
    assert.equal(parseOptionStrike('C-'), null);
  });
});

describe('isOptionSymbol', () => {
  it('returns true for call symbol', () => {
    assert.equal(isOptionSymbol('C-108000-250711'), true);
  });

  it('returns true for put symbol', () => {
    assert.equal(isOptionSymbol('P-95000-250711'), true);
  });

  it('returns false for futures symbol', () => {
    assert.equal(isOptionSymbol('BTCUSDT'), false);
  });
});

describe('buildPayoffCurve', () => {
  it('produces max profit at strike and correct breakevens', () => {
    const call: OptionPosition = {
      symbol: 'C-100000-250711',
      side: 'SHORT',
      size: 10,
      entryPrice: 500,
      unrealizedPnl: 0,
    };
    const put: OptionPosition = {
      symbol: 'P-100000-250711',
      side: 'SHORT',
      size: 10,
      entryPrice: 500,
      unrealizedPnl: 0,
    };

    const { curve, maxProfit, breakevens, strike } = buildPayoffCurve({
      call,
      put,
      currentPrice: 100000,
      gridPoints: 101,
    });

    assert.equal(strike, 100000);
    assert.equal(maxProfit, 10000); // 10 * (500 + 500)
    assert.ok(breakevens);
    assert.equal(breakevens!.lower, 99000);
    assert.equal(breakevens!.upper, 101000);

    const atStrike = curve.find(p => p.price === 100000);
    assert.ok(atStrike);
    assert.equal(atStrike!.pnl, 10000);

    const atLower = curve.find(p => p.price === 99000);
    assert.ok(atLower);
    assert.equal(atLower!.pnl, 0);

    const atUpper = curve.find(p => p.price === 101000);
    assert.ok(atUpper);
    assert.equal(atUpper!.pnl, 0);
  });

  it('returns empty result when call/put are missing', () => {
    const result = buildPayoffCurve({
      call: null,
      put: null,
      currentPrice: 100000,
      gridPoints: 101,
    });
    assert.equal(result.curve.length, 0);
    assert.equal(result.maxProfit, null);
    assert.equal(result.breakevens, null);
    assert.equal(result.strike, null);
  });
});

describe('buildPnlHistory', () => {
  it('builds cumulative realized P&L from option fills', () => {
    const fills = [
      { symbol: 'C-100000-250711', realized_pnl: '100', created_at: '2025-07-09T10:00:00Z' },
      { symbol: 'P-100000-250711', realized_pnl: '-50', created_at: '2025-07-09T10:05:00Z' },
    ];

    const result = buildPnlHistory(fills, []);

    assert.equal(result.totalRealizedPnl, 50);
    assert.equal(result.history.length, 3);
    assert.equal(result.history[0].cumulativePnl, 0);
    assert.equal(result.history[1].cumulativePnl, 100);
    assert.equal(result.history[2].cumulativePnl, 50);
  });

  it('adds a final point for current unrealized P&L', () => {
    const fills: RawFill[] = [];
    const positions: OptionPosition[] = [
      { symbol: 'C-100000-250711', side: 'SHORT', size: 1, entryPrice: 500, unrealizedPnl: 200 },
    ];

    const result = buildPnlHistory(fills, positions);

    assert.equal(result.totalRealizedPnl, 0);
    assert.equal(result.history.length, 1);
    assert.equal(result.history[0].cumulativePnl, 200);
  });

  it('ignores non-option fills', () => {
    const fills = [
      { symbol: 'BTCUSDT', realized_pnl: '1000', created_at: '2025-07-09T10:00:00Z' },
    ];

    const result = buildPnlHistory(fills, []);

    assert.equal(result.totalRealizedPnl, 0);
    assert.equal(result.history.length, 0);
  });
});
```

### Step 1.2: Run tests to verify they fail

```bash
npx tsx --test app/lib/hedgePayoff.test.ts
```

Expected: FAIL with "module not found" or missing exports.

### Step 1.3: Implement `app/lib/hedgePayoff.ts`

```typescript
/**
 * Hedge payoff calculations.
 *
 * Pure functions for computing the theoretical short-straddle payoff curve
 * and realized/unrealized P&L history from Delta Exchange positions and fills.
 */

export interface OptionPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  unrealizedPnl: number;
}

export interface PayoffPoint {
  price: number;
  pnl: number;
}

export interface PnlHistoryPoint {
  timestamp: string;
  cumulativePnl: number;
  realizedPnl: number;
  label: string;
}

export interface PayoffCurveResult {
  curve: PayoffPoint[];
  strike: number | null;
  maxProfit: number | null;
  breakevens: { lower: number; upper: number } | null;
}

export interface PnlHistoryResult {
  history: PnlHistoryPoint[];
  totalRealizedPnl: number;
}

/** Returns true if the symbol is a BTC option (call or put). */
export function isOptionSymbol(symbol: string): boolean {
  return typeof symbol === 'string' && (symbol.startsWith('C-') || symbol.startsWith('P-'));
}

/**
 * Parse the strike price from a Delta option symbol such as C-108000-250711.
 * Returns null if the symbol is not a valid option symbol.
 */
export function parseOptionStrike(symbol: string): number | null {
  if (!isOptionSymbol(symbol)) return null;
  const parts = symbol.split('-');
  if (parts.length < 2) return null;
  const strike = Number(parts[1]);
  return Number.isFinite(strike) && strike > 0 ? strike : null;
}

/**
 * Build the theoretical short-straddle payoff curve at expiry.
 *
 * For a short straddle with strike K and per-leg size N, total premium P is
 * N * (callEntryPrice + putEntryPrice). Payoff at spot S is P - N * |S - K|.
 */
export function buildPayoffCurve({
  call,
  put,
  currentPrice: _currentPrice,
  gridPoints = 101,
}: {
  call: OptionPosition | null;
  put: OptionPosition | null;
  currentPrice: number;
  gridPoints?: number;
}): PayoffCurveResult {
  if (!call || !put) {
    return { curve: [], strike: null, maxProfit: null, breakevens: null };
  }

  const callStrike = parseOptionStrike(call.symbol);
  const putStrike = parseOptionStrike(put.symbol);
  if (callStrike === null || putStrike === null || callStrike !== putStrike) {
    return { curve: [], strike: null, maxProfit: null, breakevens: null };
  }

  const strike = callStrike;
  const size = Math.max(call.size, put.size);
  if (size <= 0 || !Number.isFinite(size)) {
    return { curve: [], strike: null, maxProfit: null, breakevens: null };
  }

  const totalPremium = size * (call.entryPrice + put.entryPrice);
  if (!Number.isFinite(totalPremium) || totalPremium <= 0) {
    return { curve: [], strike: null, maxProfit: null, breakevens: null };
  }

  const breakevenDistance = totalPremium / size;
  const breakevens = {
    lower: Math.round((strike - breakevenDistance) * 100) / 100,
    upper: Math.round((strike + breakevenDistance) * 100) / 100,
  };

  const maxDistance = (4 * totalPremium) / size;
  const minPrice = Math.max(0, strike - maxDistance);
  const maxPrice = strike + maxDistance;
  const step = (maxPrice - minPrice) / Math.max(1, gridPoints - 1);

  const curve: PayoffPoint[] = [];
  for (let i = 0; i < gridPoints; i++) {
    const price = minPrice + step * i;
    const pnl = totalPremium - size * Math.abs(price - strike);
    curve.push({ price: Math.round(price), pnl: Math.round(pnl * 100) / 100 });
  }

  // Ensure exact breakeven prices are included in the curve so callers can
  // look them up precisely (and the chart can mark them exactly).
  for (const bePrice of [breakevens.lower, breakevens.upper]) {
    if (bePrice >= minPrice && bePrice <= maxPrice) {
      const exists = curve.some((p) => Math.abs(p.price - bePrice) < 0.5);
      if (!exists) {
        const pnl = totalPremium - size * Math.abs(bePrice - strike);
        curve.push({ price: bePrice, pnl: Math.round(pnl * 100) / 100 });
      }
    }
  }

  curve.sort((a, b) => a.price - b.price);

  return {
    curve,
    strike,
    maxProfit: Math.round(totalPremium * 100) / 100,
    breakevens,
  };
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

interface RawFill {
  symbol?: string;
  product_symbol?: string;
  realized_pnl?: string | number;
  created_at?: string;
}

/**
 * Build realized + current-unrealized P&L history from Delta fills and positions.
 *
 * - Filters fills to option symbols only.
 * - Sorts oldest-first and computes cumulative realized P&L.
 * - Appends one final point representing the current unrealized P&L of open option positions.
 */
export function buildPnlHistory(
  fills: RawFill[],
  optionPositions: OptionPosition[],
): PnlHistoryResult {
  const optionFills = (fills || []).filter((f) =>
    isOptionSymbol(f.symbol || f.product_symbol || ''),
  );

  const sorted = [...optionFills].sort((a, b) => {
    const timeA = a.created_at ? new Date(a.created_at).getTime() : 0;
    const timeB = b.created_at ? new Date(b.created_at).getTime() : 0;
    return timeA - timeB;
  });

  const history: PnlHistoryPoint[] = [];
  let cumulativePnl = 0;

  if (sorted.length > 0) {
    history.push({
      timestamp: sorted[0].created_at || new Date().toISOString(),
      cumulativePnl: 0,
      realizedPnl: 0,
      label: 'Start',
    });

    for (const fill of sorted) {
      const realizedPnl = toNumber(fill.realized_pnl);
      cumulativePnl += realizedPnl;
      history.push({
        timestamp: fill.created_at || new Date().toISOString(),
        cumulativePnl: Math.round(cumulativePnl * 100) / 100,
        realizedPnl: Math.round(realizedPnl * 100) / 100,
        label: 'Realized',
      });
    }
  }

  const currentUnrealized = optionPositions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  if (currentUnrealized !== 0 || optionPositions.length > 0) {
    history.push({
      timestamp: new Date().toISOString(),
      cumulativePnl: Math.round((cumulativePnl + currentUnrealized) * 100) / 100,
      realizedPnl: 0,
      label: 'Current unrealized',
    });
  }

  return {
    history,
    totalRealizedPnl: Math.round(cumulativePnl * 100) / 100,
  };
}
```

### Step 1.4: Run tests to verify they pass

```bash
npx tsx --test app/lib/hedgePayoff.test.ts
```

Expected: all 9 tests pass.

### Step 1.5: Commit

```bash
git add app/lib/hedgePayoff.ts app/lib/hedgePayoff.test.ts
git commit -m "feat(hedge): add payoff curve and P&L history calculations"
```

---

## Task 2: API route for hedge payoff data

**Complexity:** simple

**Files:**
- Create: `app/api/hedge/payoff/route.ts`

### Step 2.1: Implement the route

```typescript
import { NextResponse } from 'next/server';
import { getDeltaFills, getDeltaPositions } from '../../../lib/delta';
import {
  buildPayoffCurve,
  buildPnlHistory,
  isOptionSymbol,
  parseOptionStrike,
  type OptionPosition,
} from '../../../lib/hedgePayoff.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DELTA_API_KEY = process.env.DELTA_API_KEY || '';
const DELTA_API_SECRET = process.env.DELTA_API_SECRET || '';

const CACHE_TTL_MS = 5000;
let cachedResult: { data: unknown; fetchedAt: number } | null = null;

interface RawDeltaPosition {
  product_symbol?: string;
  symbol?: string;
  size?: number;
  entry_price?: string;
  unrealized_pnl?: string;
  side?: string;
}

function normalizeOptionPositions(rawPositions: unknown[]): OptionPosition[] {
  return rawPositions
    .filter((p): p is RawDeltaPosition => {
      const sym = (p as RawDeltaPosition).product_symbol || (p as RawDeltaPosition).symbol || '';
      return isOptionSymbol(sym);
    })
    .map((p) => {
      const sym = p.product_symbol || p.symbol || '';
      const size = Math.abs(Number(p.size) || 0);
      const rawSide = String(p.side || '').toLowerCase();
      const side: OptionPosition['side'] =
        rawSide.includes('short') || rawSide === 'sell' ? 'SHORT' : 'LONG';
      return {
        symbol: sym,
        side,
        size,
        entryPrice: Number(p.entry_price) || 0,
        unrealizedPnl: Number(p.unrealized_pnl) || 0,
      };
    })
    .filter((p) => p.size > 0 && parseOptionStrike(p.symbol) !== null);
}

function findStraddlePair(positions: OptionPosition[]): {
  call: OptionPosition | null;
  put: OptionPosition | null;
} {
  const call = positions.find((p) => p.symbol.startsWith('C-')) || null;
  const put = positions.find((p) => p.symbol.startsWith('P-')) || null;
  return { call, put };
}

/**
 * Parse the YYMMDD expiry segment of a Delta option symbol (e.g. 250711)
 * into a UTC timestamp. Returns null if the segment is missing or malformed.
 */
function parseOptionExpiry(symbol: string | null): number | null {
  if (!symbol) return null;
  const expiryPart = symbol.split('-')[2];
  if (!expiryPart || !/^\d{6}$/.test(expiryPart)) return null;
  return new Date(
    `20${expiryPart.slice(0, 2)}-${expiryPart.slice(2, 4)}-${expiryPart.slice(4, 6)}T00:00:00Z`,
  ).getTime();
}

export async function GET() {
  if (!DELTA_API_KEY || !DELTA_API_SECRET) {
    return NextResponse.json(
      { success: false, error: 'Delta API credentials not configured' },
      { status: 500 },
    );
  }

  if (cachedResult && Date.now() - cachedResult.fetchedAt < CACHE_TTL_MS) {
    return NextResponse.json(cachedResult.data);
  }

  try {
    const [positionsRes, fillsRes] = await Promise.all([
      getDeltaPositions(DELTA_API_KEY, DELTA_API_SECRET),
      getDeltaFills(DELTA_API_KEY, DELTA_API_SECRET, undefined, 500),
    ]);

    if (!positionsRes.success) {
      return NextResponse.json(
        { success: false, error: positionsRes.error || 'Failed to fetch positions' },
        { status: 502 },
      );
    }

    const rawPositions = Array.isArray(positionsRes.result) ? positionsRes.result : [];
    const optionPositions = normalizeOptionPositions(rawPositions);
    const { call, put } = findStraddlePair(optionPositions);

    // Use current BTC price from positions if available, otherwise a sensible default
    const btcFutures = rawPositions.find(
      (p: any) => p.product_id === 27 || (p.product_symbol || p.symbol) === 'BTCUSDT',
    ) as any;
    const currentPrice = Number(btcFutures?.mark_price || 0);

    const payoffResult = buildPayoffCurve({ call, put, currentPrice });

    const { history, totalRealizedPnl } = buildPnlHistory(
      Array.isArray(fillsRes?.result) ? fillsRes.result : [],
      optionPositions,
    );

    const currentUnrealizedPnl = optionPositions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
    const hasHedge = optionPositions.length > 0;

    const responseData = {
      success: true,
      hasHedge,
      currentPrice: Math.round(currentPrice * 100) / 100,
      strike: payoffResult.strike,
      breakevens: payoffResult.breakevens,
      maxProfit: payoffResult.maxProfit,
      currentUnrealizedPnl: Math.round(currentUnrealizedPnl * 100) / 100,
      totalRealizedPnl,
      payoffCurve: payoffResult.curve,
      pnlHistory: history,
      metadata: {
        callSymbol: call?.symbol || null,
        putSymbol: put?.symbol || null,
        size: call?.size || put?.size || null,
        entryNotional: payoffResult.maxProfit,
        expiryTime: parseOptionExpiry(call?.symbol || null),
      },
      timestamp: Date.now(),
    };

    cachedResult = { data: responseData, fetchedAt: Date.now() };
    return NextResponse.json(responseData);
  } catch (error: any) {
    console.error('[/api/hedge/payoff] error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to calculate hedge payoff' },
      { status: 500 },
    );
  }
}
```

### Step 2.2: Verify the route compiles

```bash
npx tsc --noEmit app/api/hedge/payoff/route.ts
```

Expected: no type errors. If `tsc` complains about Next.js types, instead run:

```bash
npm run build
```

and confirm the route compiles as part of the build.

### Step 2.3: Commit

```bash
git add app/api/hedge/payoff/route.ts
git commit -m "feat(hedge): add /api/hedge/payoff route"
```

---

## Task 3: Hedge payoff chart component

**Complexity:** simple

**Files:**
- Create: `app/components/HedgePayoffChart.tsx`

### Step 3.1: Implement the component

Create `app/components/HedgePayoffChart.tsx`:

```tsx
'use client';

import { useState, useEffect, useRef } from 'react';

interface PayoffPoint {
  price: number;
  pnl: number;
}

interface PnlHistoryPoint {
  timestamp: string;
  cumulativePnl: number;
  realizedPnl: number;
  label: string;
}

interface HedgePayoffData {
  success: boolean;
  error?: string;
  hasHedge: boolean;
  currentPrice: number;
  strike: number | null;
  breakevens: { lower: number; upper: number } | null;
  maxProfit: number | null;
  currentUnrealizedPnl: number;
  totalRealizedPnl: number;
  payoffCurve: PayoffPoint[];
  pnlHistory: PnlHistoryPoint[];
  metadata: {
    callSymbol: string | null;
    putSymbol: string | null;
    size: number | null;
    entryNotional: number | null;
    expiryTime: number | null;
  };
  timestamp: number;
}

function formatUsd(val: number): string {
  const abs = Math.abs(val);
  if (abs >= 1_000_000) return `$${(val / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(val / 1_000).toFixed(1)}K`;
  return `$${val.toFixed(0)}`;
}

function formatPrice(val: number): string {
  return `$${val.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export default function HedgePayoffChart() {
  const [data, setData] = useState<HedgePayoffData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const payoffCanvasRef = useRef<HTMLCanvasElement>(null);
  const historyCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch('/api/hedge/payoff');
        const json = await res.json();
        if (!res.ok || !json.success) {
          setError(json.error || 'Failed to fetch hedge payoff data');
          return;
        }
        setData(json);
        setError(null);
      } catch (err: any) {
        console.error('Hedge payoff fetch error:', err);
        setError(err.message || 'An error occurred while fetching hedge payoff data.');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const canvas = payoffCanvasRef.current;
    if (!canvas || !data || data.payoffCurve.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const pad = { top: 20, right: 24, bottom: 32, left: 64 };
    const chartW = width - pad.left - pad.right;
    const chartH = height - pad.top - pad.bottom;

    ctx.clearRect(0, 0, width, height);

    const prices = data.payoffCurve.map((p) => p.price);
    const pnls = data.payoffCurve.map((p) => p.pnl);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const minPnl = Math.min(0, ...pnls);
    const maxPnl = Math.max(10, ...pnls);
    const pnlRange = maxPnl - minPnl || 1;

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748b';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';

    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (chartH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(width - pad.right, y);
      ctx.stroke();

      const val = maxPnl - pnlRange * (i / 4);
      ctx.fillText(formatUsd(val), pad.left - 8, y + 4);
    }

    // Zero line
    const zeroY = pad.top + chartH - ((0 - minPnl) / pnlRange) * chartH;
    if (zeroY >= pad.top && zeroY <= pad.top + chartH) {
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(pad.left, zeroY);
      ctx.lineTo(width - pad.right, zeroY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // X-axis labels (price)
    ctx.textAlign = 'center';
    for (let i = 0; i <= 4; i++) {
      const x = pad.left + (chartW / 4) * i;
      const price = minPrice + (maxPrice - minPrice) * (i / 4);
      ctx.fillText(formatPrice(price), x, pad.top + chartH + 18);
    }

    // Helpers to map price/pnl to canvas coordinates
    const priceToX = (price: number) => pad.left + ((price - minPrice) / (maxPrice - minPrice || 1)) * chartW;
    const pnlToY = (pnl: number) => pad.top + chartH - ((pnl - minPnl) / pnlRange) * chartH;

    // Payoff line — render in segments colored by per-segment sign
    for (let i = 1; i < data.payoffCurve.length; i++) {
      const prev = data.payoffCurve[i - 1];
      const curr = data.payoffCurve[i];
      const avgPnl = (prev.pnl + curr.pnl) / 2;

      ctx.beginPath();
      ctx.moveTo(priceToX(prev.price), pnlToY(prev.pnl));
      ctx.lineTo(priceToX(curr.price), pnlToY(curr.pnl));
      ctx.lineWidth = 2;
      ctx.strokeStyle = avgPnl >= 0 ? 'var(--green)' : 'var(--red)';
      ctx.stroke();
    }

    // Gradient fill under the entire curve
    ctx.beginPath();
    for (let i = 0; i < data.payoffCurve.length; i++) {
      const p = data.payoffCurve[i];
      const x = priceToX(p.price);
      const y = pnlToY(p.pnl);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineTo(pad.left + chartW, pad.top + chartH);
    ctx.lineTo(pad.left, pad.top + chartH);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + chartH);
    if (data.currentUnrealizedPnl >= 0) {
      gradient.addColorStop(0, 'rgba(0, 240, 152, 0.2)');
      gradient.addColorStop(1, 'rgba(0, 240, 152, 0)');
    } else {
      gradient.addColorStop(0, 'rgba(255, 42, 85, 0)');
      gradient.addColorStop(1, 'rgba(255, 42, 85, 0.2)');
    }
    ctx.fillStyle = gradient;
    ctx.fill();

    // Strike line
    if (data.strike !== null) {
      const x = pad.left + ((data.strike - minPrice) / (maxPrice - minPrice || 1)) * chartW;
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, pad.top + chartH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(`Strike ${formatPrice(data.strike)}`, x, pad.top - 6);
    }

    // Current price line
    if (data.currentPrice > 0) {
      const x = pad.left + ((data.currentPrice - minPrice) / (maxPrice - minPrice || 1)) * chartW;
      ctx.strokeStyle = 'var(--blue)';
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, pad.top + chartH);
      ctx.stroke();
      ctx.fillStyle = 'var(--blue)';
      ctx.textAlign = 'center';
      ctx.fillText(`Spot ${formatPrice(data.currentPrice)}`, x, pad.top - 6);
    }

    // Breakeven markers
    if (data.breakevens !== null) {
      ctx.strokeStyle = 'var(--amber)';
      ctx.setLineDash([4, 4]);
      ctx.fillStyle = 'var(--amber)';
      ctx.textAlign = 'center';

      const markers = [
        { price: data.breakevens.lower, label: 'BE Low' },
        { price: data.breakevens.upper, label: 'BE High' },
      ];

      for (const marker of markers) {
        const x = pad.left + ((marker.price - minPrice) / (maxPrice - minPrice || 1)) * chartW;
        ctx.beginPath();
        ctx.moveTo(x, pad.top);
        ctx.lineTo(x, pad.top + chartH);
        ctx.stroke();
        ctx.fillText(`${marker.label} ${formatPrice(marker.price)}`, x, pad.top - 6);
      }

      ctx.setLineDash([]);
    }
  }, [data]);

  useEffect(() => {
    const canvas = historyCanvasRef.current;
    if (!canvas || !data || data.pnlHistory.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const pad = { top: 16, right: 24, bottom: 28, left: 56 };
    const chartW = width - pad.left - pad.right;
    const chartH = height - pad.top - pad.bottom;

    ctx.clearRect(0, 0, width, height);

    const pnls = data.pnlHistory.map((p) => p.cumulativePnl);
    const minPnl = Math.min(0, ...pnls);
    const maxPnl = Math.max(10, ...pnls);
    const pnlRange = maxPnl - minPnl || 1;

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.fillStyle = '#64748b';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';

    for (let i = 0; i <= 3; i++) {
      const y = pad.top + (chartH / 3) * i;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(width - pad.right, y);
      ctx.stroke();

      const val = maxPnl - pnlRange * (i / 3);
      ctx.fillText(formatUsd(val), pad.left - 8, y + 4);
    }

    // Zero line
    const zeroY = pad.top + chartH - ((0 - minPnl) / pnlRange) * chartH;
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, zeroY);
    ctx.lineTo(width - pad.right, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Line
    ctx.beginPath();
    for (let i = 0; i < data.pnlHistory.length; i++) {
      const p = data.pnlHistory[i];
      const x = pad.left + (chartW / Math.max(1, data.pnlHistory.length - 1)) * i;
      const y = pad.top + chartH - ((p.cumulativePnl - minPnl) / pnlRange) * chartH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineWidth = 2;
    const finalPnl = data.pnlHistory[data.pnlHistory.length - 1]?.cumulativePnl || 0;
    ctx.strokeStyle = finalPnl >= 0 ? 'var(--green)' : 'var(--red)';
    ctx.stroke();

    // Gradient fill
    ctx.lineTo(pad.left + chartW, pad.top + chartH);
    ctx.lineTo(pad.left, pad.top + chartH);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + chartH);
    if (finalPnl >= 0) {
      gradient.addColorStop(0, 'rgba(0, 240, 152, 0.2)');
      gradient.addColorStop(1, 'rgba(0, 240, 152, 0)');
    } else {
      gradient.addColorStop(0, 'rgba(255, 42, 85, 0)');
      gradient.addColorStop(1, 'rgba(255, 42, 85, 0.2)');
    }
    ctx.fillStyle = gradient;
    ctx.fill();
  }, [data]);

  return (
    <div className="card" id="hedge-payoff-chart">
      <div className="card-header">
        <span className="card-title">🛡️ Hedge Payoff</span>
        {loading ? (
          <span className="card-badge polling">Updating...</span>
        ) : (
          <span className="card-badge live">Live</span>
        )}
      </div>

      {error && (
        <div
          style={{
            background: 'var(--red-dim)',
            color: 'var(--red)',
            padding: '16px',
            borderRadius: 'var(--radius-sm)',
            marginBottom: '24px',
            border: '1px solid var(--red)',
            fontSize: '14px',
          }}
        >
          {error}
        </div>
      )}

      {data && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
            gap: '16px',
            marginBottom: '20px',
          }}
        >
          <StatBox label="Max Profit" value={data.maxProfit} color="var(--green)" />
          <StatBox label="Lower Break" value={data.breakevens?.lower} color="var(--text-primary)" formatter={formatPrice} />
          <StatBox label="Upper Break" value={data.breakevens?.upper} color="var(--text-primary)" formatter={formatPrice} />
          <StatBox label="Unrealized P&L" value={data.currentUnrealizedPnl} color={data.currentUnrealizedPnl >= 0 ? 'var(--green)' : 'var(--red)'} />
          <StatBox label="Realized P&L" value={data.totalRealizedPnl} color={data.totalRealizedPnl >= 0 ? 'var(--green)' : 'var(--red)'} />
        </div>
      )}

      {loading && !data ? (
        <div className="chart-empty">
          <div style={{ fontSize: '32px', opacity: 0.5 }}>🛡️</div>
          <p>Loading hedge payoff data...</p>
        </div>
      ) : data && !data.hasHedge && data.pnlHistory.length === 0 ? (
        <div className="chart-empty">
          <div style={{ fontSize: '32px', opacity: 0.5 }}>🛡️</div>
          <p>No active hedge or historical option activity found.</p>
        </div>
      ) : (
        <>
          <div style={{ position: 'relative', marginBottom: '24px' }}>
            <canvas ref={payoffCanvasRef} style={{ width: '100%', height: '260px', display: 'block' }} />
          </div>

          {data && data.pnlHistory.length > 0 && (
            <div style={{ position: 'relative' }}>
              <div className="card-title" style={{ marginBottom: '12px', fontSize: '13px' }}>
                📈 Hedge P&L History
              </div>
              <canvas ref={historyCanvasRef} style={{ width: '100%', height: '160px', display: 'block' }} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatBox({
  label,
  value,
  color,
  formatter = formatUsd,
}: {
  label: string;
  value: number | null | undefined;
  color: string;
  formatter?: (n: number) => string;
}) {
  return (
    <div
      style={{
        padding: '12px',
        background: 'rgba(0,0,0,0.3)',
        borderRadius: 'var(--radius-xs)',
        border: '1px solid rgba(255,255,255,0.05)',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          fontSize: '11px',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '1px',
          marginBottom: '4px',
        }}
      >
        {label}
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '18px', fontWeight: 700, color }}>
        {value !== null && value !== undefined ? formatter(value) : '—'}
      </div>
    </div>
  );
}
```

### Step 3.2: Verify the component compiles

```bash
npm run build
```

Expected: build succeeds (no new type errors from the component).

### Step 3.3: Commit

```bash
git add app/components/HedgePayoffChart.tsx
git commit -m "feat(hedge): add HedgePayoffChart component"
```

---

## Task 4: Add component to both pages

**Complexity:** simple

**Files:**
- Modify: `app/page.tsx`
- Modify: `app/wallet/page.tsx`

### Step 4.1: Add import and component to `app/page.tsx`

Add the import near the other component imports:

```tsx
import HedgePayoffChart from './components/HedgePayoffChart';
```

Insert a new row between the "Signal & On-Chain Row" and the "Main Grid: Liquidations & Whales" sections:

```tsx
      {/* Hedge Payoff Row */}
      <div className="dashboard-grid" style={{ marginTop: '20px' }}>
        <HedgePayoffChart />
      </div>
```

### Step 4.2: Add import and component to `app/wallet/page.tsx`

Add the import:

```tsx
import HedgePayoffChart from '../components/HedgePayoffChart';
```

Insert the component below the wallet P&L chart:

```tsx
      <div style={{ marginTop: '24px' }}>
        <WalletPNLChart />
      </div>

      <div style={{ marginTop: '24px' }}>
        <HedgePayoffChart />
      </div>
```

### Step 4.3: Verify build

```bash
npm run build
```

Expected: build succeeds.

### Step 4.4: Run unit tests

```bash
npx tsx --test app/lib/hedgePayoff.test.ts
```

Expected: all tests pass.

### Step 4.5: Run lint

```bash
npm run lint
```

Expected: lint passes with no new errors.

### Step 4.6: Commit

```bash
git add app/page.tsx app/wallet/page.tsx
git commit -m "feat(hedge): add HedgePayoffChart to dashboard and wallet pages"
```

---

## Verification Checklist

- [ ] `npx tsx --test app/lib/hedgePayoff.test.ts` passes.
- [ ] `npm run build` succeeds.
- [ ] `npm run lint` passes.
- [ ] Dashboard page renders the new Hedge Payoff card.
- [ ] Wallet page renders the new Hedge Payoff card below the P&L chart.
