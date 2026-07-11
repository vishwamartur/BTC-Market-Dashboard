/**
 * Centralized type definitions for the v2 trading bot.
 *
 * All Delta Exchange API response shapes and internal normalized
 * representations live here. Never use `any` for position/ticker/order
 * data — import from this module instead.
 */

// ---------------------------------------------------------------------------
// Delta Exchange API Response Types
// ---------------------------------------------------------------------------

/** Raw position object returned by Delta /v2/positions API */
export interface DeltaPosition {
  product_id: number;
  product_symbol: string;
  /** Alias sometimes returned instead of product_symbol */
  symbol?: string;
  /** Positive = long, negative = short, 0 = no position */
  size: number;
  entry_price: string;
  mark_price: string;
  unrealized_pnl: string;
  realized_pnl: string;
  margin: string;
  liquidation_price: string;
  /** Futures contract_type is typically undefined; options have 'call_options' | 'put_options' */
  contract_type?: string;
}

/** Raw ticker object returned by Delta /v2/tickers API */
export interface DeltaTicker {
  product_id: number;
  symbol: string;
  mark_price: string;
  funding_rate?: string;
  quotes?: {
    best_bid: string;
    best_ask: string;
  };
  greeks?: {
    theta: string;
    vega: string;
    gamma: string;
    delta: string;
  };
}

/** Raw product object returned by Delta /v2/products API */
export interface DeltaProduct {
  id: number;
  symbol: string;
  contract_type: 'call_options' | 'put_options' | 'perpetual_futures' | 'futures' | string;
  strike_price: string;
  settlement_time: string;
  underlying_asset: { symbol: string };
  state: string;
}

/** Raw order object returned by Delta /v2/orders API */
export interface DeltaOrder {
  id: number;
  product_id: number;
  size: number;
  side: string;
  state: string;
  order_type: string;
  limit_price?: string;
  average_fill_price?: string;
  [key: string]: unknown;
}

/** Raw wallet balance from Delta /v2/wallet/balances API */
export interface DeltaWalletBalance {
  asset_symbol: string;
  available_balance: string;
  balance: string;
  order_margin: string;
  position_margin: string;
}

// ---------------------------------------------------------------------------
// Internal Normalized Types
// ---------------------------------------------------------------------------

export type PositionType = 'futures' | 'call_option' | 'put_option';
export type PositionSide = 'LONG' | 'SHORT';

/** Our internal, cleaned-up representation of a position */
export interface NormalizedPosition {
  productId: number;
  symbol: string;
  side: PositionSide;
  size: number;
  entryPrice: number;
  unrealizedPnl: number;
  type: PositionType;
}

/** Signal from the dashboard signal API */
export interface SignalData {
  overallSignal: string;
  confidence: number;
  score: number;
  /** Optional component breakdown (signalEngine.ts) */
  components?: Array<{ name: string; score: number; weight: number; reason: string }>;
  /** Trend drift component score, -1 to 1 (signalEngine.ts Chunk 2) */
  trendDrift?: number;
  /** Range breakout component score, -1 to 1 (signalEngine.ts Chunk 2) */
  rangeBreakout?: number;
  /** News sentiment component score, -1 to 1 (signalEngine.ts Chunk 3) */
  newsSentiment?: number;
  /** Market regime from the dashboard signal engine */
  regime?: string;
  /** Number of signal components exceeding the strong-score threshold */
  confluenceCount?: number;
}

// ---------------------------------------------------------------------------
// Strategy Types
// ---------------------------------------------------------------------------

export type TradeAction = 'BUY' | 'SELL' | 'HEDGE' | null;

export interface RiskDecision {
  action: TradeAction;
  size: number;
  breakEven?: BreakEvenResult;
}

export interface BreakEvenResult {
  breakEvenMovePct: number;
  roundTripCostUsd: number;
  feeUsd: number;
  gstUsd: number;
  notionalUsd: number;
  feeType: 'maker' | 'taker';
}

export interface StrategyResult {
  /** What happened */
  action: 'EXECUTED' | 'SKIPPED' | 'ERROR';
  /** Human-readable reason */
  reason: string;
}

export interface HedgeProfitAction {
  shouldClose: boolean;
  reason: string;
  currentProfit: number;
  peakProfit: number;
}
