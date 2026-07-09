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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _currentPrice,
  gridPoints = 101,
}: {
  call: OptionPosition | null;
  put: OptionPosition | null;
  _currentPrice: number;
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

  // Ensure exact breakeven prices are included in the curve
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
