# Hedge Positions Payoff Graph — Design

## Goal

Add a hedge-positions payoff visualization to both the main dashboard and the wallet page. The card must show (1) the theoretical P&L at expiry of the current short-straddle hedge across a range of BTC prices, and (2) the realized + current-unrealized P&L of those hedge positions over time.

## Context

- The trading bot in `v2/` executes a short-straddle hedge strategy (`v2/src/strategies/hedgeStrategy.ts`, `v2/src/optionsManager.ts`).
- The dashboard (`app/`) is a Next.js 16 app that talks directly to Delta Exchange via API routes in `app/api/`.
- Existing dashboard charts are canvas-based and follow the pattern in `app/components/WalletPNLChart.tsx`.
- The app uses Node's built-in test runner (`node:test`) for unit tests.

## Architecture

A new API route (`/api/hedge/payoff`) reads live option positions and fills from Delta Exchange, then uses pure functions in `app/lib/hedgePayoff.ts` to compute:

1. **Payoff curve** — P&L at expiry for a grid of BTC prices around the current spot/strike.
2. **P&L history** — cumulative realized P&L from option fills plus the latest unrealized P&L snapshot.

A new React component (`app/components/HedgePayoffChart.tsx`) fetches that data and renders a canvas chart plus summary stats. It is embedded on both pages.

## Components & Data Flow

```
Delta Exchange
    │
    ├── positions ──┐
    │               │
    └── fills ──────┼──► /api/hedge/payoff ──► app/lib/hedgePayoff.ts
                    │
                    ▼
        HedgePayoffChart.tsx ◄── polling
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
   app/page.tsx           app/wallet/page.tsx
```

## File Changes

### New files

- `app/lib/hedgePayoff.ts` — payoff and P&L-history calculations.
- `app/lib/hedgePayoff.test.ts` — unit tests for the calculation helpers.
- `app/api/hedge/payoff/route.ts` — API route that returns computed data.
- `app/components/HedgePayoffChart.tsx` — chart card component.

### Modified files

- `app/page.tsx` — add `<HedgePayoffChart />` in a new dashboard row.
- `app/wallet/page.tsx` — add `<HedgePayoffChart />` below `<WalletPNLChart />`.

## Data Shapes

### `PayoffPoint`

```ts
interface PayoffPoint {
  price: number;
  pnl: number;
}
```

### `PnlHistoryPoint`

```ts
interface PnlHistoryPoint {
  timestamp: string;
  cumulativePnl: number;
  realizedPnl: number;
  label: string;
}
```

### `HedgePayoffResponse`

```ts
interface HedgePayoffResponse {
  success: true;
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
```

## Calculation Details

### Identifying option positions

Option product symbols on Delta start with `C-` (call) or `P-` (put). A short straddle has one short call and one short put with the same strike and size.

### Parsing strike from symbol

Symbols follow the pattern `C-<strike>-<expiry>` or `P-<strike>-<expiry>`. Strike is parsed from the second dash-delimited segment.

Example: `C-108000-250711` → strike `108000`.

### Theoretical payoff at expiry

For a short straddle with:
- strike `K`
- per-leg size `N`
- total premium collected `P = N * (callEntryPrice + putEntryPrice)`

Payoff at expiry for spot `S` is:

```
pnl(S) = P - N * |S - K|
```

Max profit is `P` when `S == K`. Breakevens are `K ± P / N`.

The price grid ranges from `max(0, K - 4 * P / N)` to `K + 4 * P / N`, sampled at 101 points. If no live option positions exist, the payoff curve is empty (`payoffCurve: []`) and `hasHedge` is `false`; the component shows an empty state instead of a synthetic curve.

### Realized + unrealized P&L history

1. Fetch all fills from Delta (`/v2/fills`).
2. Filter fills to option symbols (`C-` or `P-`).
3. Sort oldest-first and build cumulative realized P&L.
4. Append a final data point for the current unrealized P&L of open option positions, using `Date.now()`.

## UI Behavior

- Poll the API every 30 seconds.
- Show a loading state on first fetch.
- Show an empty state when no hedge positions are open and there is no historical option activity.
- Canvas chart includes:
  - Theoretical payoff line (green when positive, red when negative, gradient fill underneath).
  - Vertical dashed line at the strike price.
  - Vertical line at the current BTC price.
  - Breakeven price markers.
  - Summary stats cards: max profit, lower breakeven, upper breakeven, current unrealized P&L, total realized P&L.
- Below the payoff curve, render a smaller time-series chart of realized + unrealized P&L.

## Error Handling

- API route returns `{ success: false, error: string }` on credential/config failures or Delta API errors.
- Component surfaces the error in a card-level banner and stops polling until the next interval.

## Testing

- `app/lib/hedgePayoff.test.ts` covers:
  - Strike parsing from option symbols.
  - Short-straddle payoff curve shape (max profit at strike, breakevens at expected prices).
  - P&L history aggregation from mock fills.
  - Graceful handling when no option positions exist.

## Non-Goals

- No changes to the v2 trading bot state or logic.
- No new charting library; reuse canvas rendering.
- No option greeks visualization.
- No shared state between the v2 bot and the dashboard; all data comes from Delta Exchange APIs.
