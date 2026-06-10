/**
 * Centralized risk management for the auto-trader.
 * All limits are server-side-enforced; the client can only request within these bounds.
 *
 * v2: Fee-aware profit optimization
 * - Breakeven calculator accounts for trading fees + GST
 * - Position sizing ensures fee efficiency
 * - shouldTrade() rejects trades where expected profit < 1.5× fees
 */

export interface RiskConfig {
  maxDailyLossUsd: number;       // e.g. 50 — halt trading if daily loss exceeds this
  maxPositionSize: number;        // e.g. 40 — hard cap on contract count
  minPositionSize: number;        // e.g. 10 — minimum contracts (fees on <10 are never worth it)
  minConfidence: number;          // e.g. 60 — minimum signal confidence to trade
  riskRewardRatio: number;        // e.g. 2 — take-profit distance = riskRewardRatio × stop distance
  stopLossAtrMultiplier: number;  // e.g. 1.5 — stop = 1.5 × ATR from entry
  cooldownMs: number;             // e.g. 900000 — minimum ms between trades (15 min)
  takerFeePct: number;            // e.g. 0.0005 (0.05%) taker fee per side
  makerFeePct: number;            // e.g. 0.0002 (0.02%) maker fee per side
  gstRate: number;                // e.g. 0.1525 (15.25%) GST on trading fees
  estimatedWinPct: number;        // e.g. 0.005 (0.5%) average winning move
  estimatedLossPct: number;       // e.g. 0.002 (0.2%) average losing move
  minBreakEvenMultiple: number;   // e.g. 1.5 — expected profit must be >= 1.5× round-trip cost
  contractSizeBtc: number;        // e.g. 0.001 — BTC per contract on Delta Exchange
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  maxDailyLossUsd: 100,
  maxPositionSize: 40,            // Increased from 20 — better fee-to-profit ratio
  minPositionSize: 10,            // NEW: minimum 10 contracts (fees on 1-5 are never worth it)
  minConfidence: 60,              // Raised from 40 — only trade strong signals
  riskRewardRatio: 2.0,
  stopLossAtrMultiplier: 1.5,
  cooldownMs: 15 * 60 * 1000,    // 15 minutes (was 5 min) — reduce over-trading
  takerFeePct: 0.0005,            // 0.05% Delta Exchange taker fee
  makerFeePct: 0.0002,            // 0.02% Delta Exchange maker fee
  gstRate: 0.1525,                // 15.25% GST on trading fees (observed from user data)
  estimatedWinPct: 0.005,         // 0.5% expected win move (was 0.3%)
  estimatedLossPct: 0.002,        // 0.2% expected loss move (was 0.15%)
  minBreakEvenMultiple: 1.5,      // Expected profit must be >= 1.5× fees
  contractSizeBtc: 0.001,         // 0.001 BTC per contract on Delta
};

// ---------------------------------------------------------------------------
// Breakeven Calculator
// ---------------------------------------------------------------------------

export interface BreakEvenResult {
  /** Minimum price move (%) to cover round-trip fees + GST */
  breakEvenMovePct: number;
  /** Total round-trip cost in USD (fees + GST) */
  roundTripCostUsd: number;
  /** Trading fee component (USD) */
  feeUsd: number;
  /** GST component (USD) */
  gstUsd: number;
  /** Notional value of the position (USD) */
  notionalUsd: number;
  /** Whether using maker or taker fees */
  feeType: 'maker' | 'taker';
}

/**
 * Calculate the break-even cost for a round-trip trade (open + close).
 * Accounts for trading fees and GST.
 */
export function calculateBreakEven(
  positionSizeContracts: number,
  currentPrice: number,
  config: RiskConfig = DEFAULT_RISK_CONFIG,
  useMakerFee: boolean = false
): BreakEvenResult {
  const feePct = useMakerFee ? config.makerFeePct : config.takerFeePct;
  const notionalUsd = positionSizeContracts * config.contractSizeBtc * currentPrice;

  // Round-trip fee = 2 × fee% × notional (once for open, once for close)
  const feeUsd = 2 * feePct * notionalUsd;
  const gstUsd = feeUsd * config.gstRate;
  const roundTripCostUsd = feeUsd + gstUsd;

  // Break-even move = totalCost / notional
  const breakEvenMovePct = notionalUsd > 0 ? (roundTripCostUsd / notionalUsd) * 100 : 0;

  return {
    breakEvenMovePct,
    roundTripCostUsd,
    feeUsd,
    gstUsd,
    notionalUsd,
    feeType: useMakerFee ? 'maker' : 'taker',
  };
}

/**
 * Returns true if the bot is allowed to place a new trade.
 */
export function canTrade(
  dailyPnl: number,
  config: RiskConfig = DEFAULT_RISK_CONFIG
): boolean {
  // Circuit breaker: stop trading if daily loss exceeds max
  if (dailyPnl < -config.maxDailyLossUsd) {
    return false;
  }
  return true;
}

/**
 * Calculate position size based on signal confidence.
 * Higher confidence = larger position (up to maxPositionSize).
 * Enforces minimum position size for fee efficiency.
 */
export function calculatePositionSize(
  confidence: number,
  currentPrice: number = 0,
  config: RiskConfig = DEFAULT_RISK_CONFIG
): number {
  if (confidence < config.minConfidence) return 0;

  const range = 100 - config.minConfidence;
  const normalized = (confidence - config.minConfidence) / range; // 0 to 1

  // Scale from minPositionSize to maxPositionSize
  const size = Math.round(
    config.minPositionSize + normalized * (config.maxPositionSize - config.minPositionSize)
  );

  let finalSize = Math.min(size, config.maxPositionSize);

  // Fee-efficiency check: if we have a price, verify the position is worth trading
  if (currentPrice > 0 && finalSize > 0) {
    const breakEven = calculateBreakEven(finalSize, currentPrice, config);
    const expectedProfit = config.estimatedWinPct * breakEven.notionalUsd;

    // If fees eat more than 40% of expected profit, bump up size
    if (breakEven.roundTripCostUsd > expectedProfit * 0.4) {
      const bumpedSize = Math.ceil(finalSize * 1.5);
      finalSize = Math.min(bumpedSize, config.maxPositionSize);
    }
  }

  // Never go below minimum
  return Math.max(config.minPositionSize, finalSize);
}

/**
 * Calculate stop-loss price.
 * Uses ATR (Average True Range) for volatility-adjusted stops.
 */
export function getStopLoss(
  side: 'buy' | 'sell',
  entryPrice: number,
  atr: number,
  config: RiskConfig = DEFAULT_RISK_CONFIG
): number {
  const stopDistance = atr * config.stopLossAtrMultiplier;

  if (side === 'buy') {
    return Math.round((entryPrice - stopDistance) * 100) / 100;
  } else {
    return Math.round((entryPrice + stopDistance) * 100) / 100;
  }
}

/**
 * Calculate take-profit price.
 * Uses risk-reward ratio relative to the stop distance.
 */
export function getTakeProfit(
  side: 'buy' | 'sell',
  entryPrice: number,
  atr: number,
  config: RiskConfig = DEFAULT_RISK_CONFIG
): number {
  const stopDistance = atr * config.stopLossAtrMultiplier;
  const tpDistance = stopDistance * config.riskRewardRatio;

  if (side === 'buy') {
    return Math.round((entryPrice + tpDistance) * 100) / 100;
  } else {
    return Math.round((entryPrice - tpDistance) * 100) / 100;
  }
}

/**
 * Calculate the expected net value (E_net) of a trade in percentage terms.
 * E_net = p * avg_win - (1-p) * avg_loss - round_trip_fee_with_gst
 */
export function calculateExpectedNetValue(
  confidence: number,
  config: RiskConfig = DEFAULT_RISK_CONFIG
): number {
  const p = confidence / 100;
  const roundTripFee = config.takerFeePct * 2;
  const roundTripFeeWithGst = roundTripFee * (1 + config.gstRate);

  const eNet = (p * config.estimatedWinPct) - ((1 - p) * config.estimatedLossPct) - roundTripFeeWithGst;
  return eNet;
}

/**
 * Determine if the signal is strong enough and in the right direction to trade.
 * Adds hysteresis: signal must be above threshold (not just barely crossing it).
 * Includes a fee-aware expected value filter AND breakeven cost check.
 */
export function shouldTrade(
  signal: { overallSignal: string; confidence: number; score: number },
  config: RiskConfig = DEFAULT_RISK_CONFIG,
  currentPrice: number = 0
): { action: 'BUY' | 'SELL' | null; size: number; breakEven?: BreakEvenResult } {
  if (signal.confidence < config.minConfidence) {
    return { action: null, size: 0 };
  }

  let action: 'BUY' | 'SELL' | null = null;

  // Require STRONG signals with sufficient confidence
  if (signal.overallSignal === 'STRONG BUY' && signal.score >= 0.5) {
    action = 'BUY';
  } else if (signal.overallSignal === 'STRONG SELL' && signal.score <= -0.5) {
    action = 'SELL';
  }

  if (!action) return { action: null, size: 0 };

  // Fee-aware expected value filter (percentage-based)
  const eNet = calculateExpectedNetValue(signal.confidence, config);
  if (eNet <= 0) {
    console.log(`[RISK] Skipping trade due to negative expected value: ${(eNet * 100).toFixed(3)}%`);
    return { action: null, size: 0 };
  }

  const size = calculatePositionSize(signal.confidence, currentPrice, config);

  // If we have a current price, do the USD breakeven check
  if (currentPrice > 0 && size > 0) {
    const breakEven = calculateBreakEven(size, currentPrice, config);
    const expectedProfitUsd = eNet * breakEven.notionalUsd;

    // Expected profit must be at least minBreakEvenMultiple × round-trip cost
    const requiredProfit = breakEven.roundTripCostUsd * config.minBreakEvenMultiple;
    if (expectedProfitUsd < requiredProfit) {
      console.log(
        `[RISK] Skipping trade: expected profit $${expectedProfitUsd.toFixed(2)} ` +
        `< ${config.minBreakEvenMultiple}× breakeven $${requiredProfit.toFixed(2)} ` +
        `(round-trip cost: $${breakEven.roundTripCostUsd.toFixed(2)}, size: ${size})`
      );
      return { action: null, size: 0 };
    }

    return { action, size, breakEven };
  }

  return { action, size };
}
