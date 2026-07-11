# Review: Hedge Payoff Graph Implementation Plan

## Verdict: NEEDS_REVISION

All five claimed fixes are present, but one remaining correctness gap should be addressed before the plan is approved for implementation.

## Remaining Gaps

1. **Broken expiry timestamp parsing in API route**
   - **File/chunk:** `app/api/hedge/payoff/route.ts`, `metadata.expiryTime` calculation
   - **Line reference:** Plan Step 2.1, inside `responseData.metadata`
   - **Problem:** The expiry segment of Delta option symbols is a `YYMMDD` string such as `250711`. The code computes `new Date(call.symbol.split('-')[2]).getTime() || null`, and `new Date('250711')` is an invalid date, so `expiryTime` will always resolve to `null`.
   - **Suggested fix:** Parse the `YYMMDD` segment explicitly, e.g.:
     ```ts
     const expiryPart = call.symbol.split('-')[2];
     const expiryTime = expiryPart && /^\d{6}$/.test(expiryPart)
       ? new Date(`20${expiryPart.slice(0, 2)}-${expiryPart.slice(2, 4)}-${expiryPart.slice(4, 6)}T00:00:00Z`).getTime()
       : null;
     ```
     And update `metadata.expiryTime` to use this value.
