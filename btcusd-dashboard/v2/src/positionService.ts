/**
 * Position normalization and query helpers.
 *
 * Eliminates the duplicated "filter by C-/P- prefix" pattern that was
 * copy-pasted in index.ts, optionsManager.ts, and fundingArbitrage.ts.
 * All position queries should use these helpers.
 */

import type { DeltaPosition, NormalizedPosition, PositionType } from './types.js';

const BTCUSDT_PRODUCT_ID = 27;

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Determine position type from the product symbol.
 * - Symbols starting with "C-" are call options
 * - Symbols starting with "P-" are put options
 * - Everything else (product_id 27) is futures
 */
function classifyPositionType(symbol: string, productId: number): PositionType {
  if (symbol.startsWith('C-')) return 'call_option';
  if (symbol.startsWith('P-')) return 'put_option';
  return 'futures';
}

/**
 * Convert raw Delta positions to our normalized internal format.
 * Filters out zero-size positions.
 */
export function normalizePositions(rawPositions: DeltaPosition[]): NormalizedPosition[] {
  return rawPositions
    .filter(p => p.size !== 0)
    .map(p => {
      const symbol = p.product_symbol || p.symbol || '';
      return {
        productId: p.product_id,
        symbol,
        side: (p.size > 0 ? 'LONG' : 'SHORT') as NormalizedPosition['side'],
        size: Math.abs(p.size),
        entryPrice: Number(p.entry_price) || 0,
        unrealizedPnl: Number(p.unrealized_pnl) || 0,
        type: classifyPositionType(symbol, p.product_id),
      };
    });
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** Get the active BTCUSD futures position, or null if none. */
export function getFuturesPosition(positions: NormalizedPosition[]): NormalizedPosition | null {
  return positions.find(p => p.productId === BTCUSDT_PRODUCT_ID && p.type === 'futures') || null;
}

/** Get all open option positions (calls + puts). */
export function getOptionPositions(positions: NormalizedPosition[]): NormalizedPosition[] {
  return positions.filter(p => p.type === 'call_option' || p.type === 'put_option');
}

/** Returns true if there are any open option positions. */
export function hasOpenOptions(positions: NormalizedPosition[]): boolean {
  return positions.some(p => p.type === 'call_option' || p.type === 'put_option');
}

/** Sum unrealized P&L across all option positions. */
export function sumOptionsPnl(positions: NormalizedPosition[]): number {
  return getOptionPositions(positions).reduce((sum, p) => sum + p.unrealizedPnl, 0);
}

/** Check if a position exists for a specific product. */
export function hasPositionForProduct(positions: NormalizedPosition[], productId: number): boolean {
  return positions.some(p => p.productId === productId);
}

/** The BTCUSD futures product ID on Delta Exchange. */
export { BTCUSDT_PRODUCT_ID };
