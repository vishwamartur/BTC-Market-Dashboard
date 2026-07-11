# Hedge Payoff Graph — Code Review

## Verdict

NEEDS_FIXES

## Issues

### 1. API route silently ignores Delta fills API failures

- **File:** `/Users/vishwa/Desktop/BTC-Market-Dashboard/btcusd-dashboard/app/api/hedge/payoff/route.ts`
- **Lines:** 72–82
- **Problem:** The route checks `positionsRes.success` but never checks `fillsRes.success`. If `getDeltaFills` returns a Delta API error, the route still responds with `success: true` and an empty P&L history. The spec states that the API route must return `{ success: false, error: string }` on Delta API errors.
- **Suggested fix:** After the positions success check, add:

```ts
if (!fillsRes.success) {
  return NextResponse.json(
    { success: false, error: fillsRes.error || 'Failed to fetch fills' },
    { status: 502 },
  );
}
```

### 2. Payoff curve does not verify short-straddle side

- **File:** `/Users/vishwa/Desktop/BTC-Market-Dashboard/btcusd-dashboard/app/lib/hedgePayoff.ts`
- **Lines:** 66–75
- **Problem:** `buildPayoffCurve` accepts any `OptionPosition` for the call and put legs but never validates that `side === 'SHORT'`. The formula `P - N * |S - K|` is only correct for a short straddle. If LONG option positions are passed, the curve is mathematically wrong.
- **Suggested fix:** Reject the pair unless both legs are `SHORT`:

```ts
if (call.side !== 'SHORT' || put.side !== 'SHORT') {
  return { curve: [], strike: null, maxProfit: null, breakevens: null };
}
```

Also add unit tests for LONG-leg rejection.

### 3. Straddle pairing picks arbitrary call/put without matching strike

- **File:** `/Users/vishwa/Desktop/BTC-Market-Dashboard/btcusd-dashboard/app/api/hedge/payoff/route.ts`
- **Lines:** 91–96
- **Problem:** `findStraddlePair` returns the first call and the first put it finds, regardless of whether they share the same strike or expiry. If multiple option positions are open, this can pair a call at one strike with a put at another. `buildPayoffCurve` then rejects the pair and returns an empty curve, leaving the dashboard in an empty state even though a valid straddle may exist.
- **Suggested fix:** Find a matching pair by strike (and ideally expiry). For example:

```ts
function findStraddlePair(positions: OptionPosition[]) {
  const calls = positions.filter((p) => p.symbol.startsWith('C-'));
  const puts = positions.filter((p) => p.symbol.startsWith('P-'));
  for (const call of calls) {
    const callStrike = parseOptionStrike(call.symbol);
    const put = puts.find((p) => parseOptionStrike(p.symbol) === callStrike);
    if (put) return { call, put };
  }
  return { call: null, put: null };
}
```

### 4. Lint errors in reviewed wallet page

- **File:** `/Users/vishwa/Desktop/BTC-Market-Dashboard/btcusd-dashboard/app/wallet/page.tsx`
- **Lines:** 15, 42
- **Problem:** ESLint reports two `@typescript-eslint/no-explicit-any` errors:

```
15:18  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
42:21  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
```

These prevent `npx eslint` from passing on the set of files requested for review.
- **Suggested fix:** Replace `[key: string]: any` with a stricter index signature such as `[key: string]: string | number | undefined`, and replace `catch (err: any)` with `catch (err)` plus `instanceof Error` narrowing.

### 5. Lint warning in reviewed dashboard page

- **File:** `/Users/vishwa/Desktop/BTC-Market-Dashboard/btcusd-dashboard/app/page.tsx`
- **Line:** 40
- **Problem:** ESLint reports `@typescript-eslint/no-unused-vars` for `lastUpdate`:

```
40:5  warning  'lastUpdate' is assigned a value but never used
```

- **Suggested fix:** Either remove `lastUpdate` from the destructuring if it is not needed, or render it in the UI.

### 6. Missing unit-test coverage for new edge cases

- **File:** `/Users/vishwa/Desktop/BTC-Market-Dashboard/btcusd-dashboard/app/lib/hedgePayoff.test.ts`
- **Problem:** The tests cover the happy path and basic empty cases, but do not cover:
  - Mismatched call/put strikes.
  - LONG option legs.
  - Zero or negative size.
  - Non-finite entry prices.
  - Multiple option fills mixed with non-option fills.
- **Suggested fix:** Add tests for the above cases to lock down the helper behavior.

## Verification Summary

### Tests

```bash
npx tsx --test app/lib/hedgePayoff.test.ts
```

Result: **PASS** — 12 tests across 4 suites passed.

```
ℹ tests 12
ℹ suites 4
ℹ pass 12
ℹ fail 0
```

### Lint

```bash
npx eslint app/lib/hedgePayoff.ts app/lib/hedgePayoff.test.ts app/api/hedge/payoff/route.ts app/components/HedgePayoffChart.tsx app/page.tsx app/wallet/page.tsx
```

Result: **FAIL** — 2 errors, 1 warning.

```
/Users/vishwa/Desktop/BTC-Market-Dashboard/btcusd-dashboard/app/page.tsx
  40:5  warning  'lastUpdate' is assigned a value but never used  @typescript-eslint/no-unused-vars

/Users/vishwa/Desktop/BTC-Market-Dashboard/btcusd-dashboard/app/wallet/page.tsx
  15:18  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  42:21  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

✖ 3 problems (2 errors, 1 warning)
```

### Build

```bash
npm run build
```

Result: **PASS** — production build compiled successfully, including the new `/api/hedge/payoff` route.

```
✓ Compiled successfully in 1564ms
✓ Generating static pages using 7 workers (8/8) in 114ms
```

## Notes

- The payoff curve math, breakeven calculation, and P&L history aggregation match the spec in the tested paths.
- `<HedgePayoffChart />` is correctly imported and rendered on both `app/page.tsx` and `app/wallet/page.tsx`.
- The component polls every 30 seconds and renders the payoff curve, strike line, current-price line, breakeven markers, summary stats, and P&L history as required.
