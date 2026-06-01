/**
 * Centralized risk management for the auto-trader.
 * All limits are server-side-enforced; the client can only request within these bounds.
 */

export interface RiskConfig {
  maxDailyLossUsd: number;       // e.g. 50 — halt trading if daily loss exceeds this
  maxPositionSize: number;        // e.g. 5 — hard cap on contract count
  minConfidence: number;          // e.g. 40 — minimum signal confidence to trade
  riskRewardRatio: number;        // e.g. 2 — take-profit distance = riskRewardRatio × stop distance
  stopLossAtrMultiplier: number;  // e.g. 1.5 — stop = 1.5 × ATR from entry
  cooldownMs: number;             // e.g. 300000 — minimum ms between trades
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  maxDailyLossUsd: 100,
  maxPositionSize: 5,
  minConfidence: 40,
  riskRewardRatio: 2.0,
  stopLossAtrMultiplier: 1.5,
  cooldownMs: 5 * 60 * 1000, // 5 minutes
};

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
 */
export function calculatePositionSize(
  confidence: number,
  config: RiskConfig = DEFAULT_RISK_CONFIG
): number {
  if (confidence < config.minConfidence) return 0;

  // Linearly scale: minConfidence → 1 contract, 100 → maxPositionSize
  const range = 100 - config.minConfidence;
  const normalized = (confidence - config.minConfidence) / range; // 0 to 1
  const size = Math.max(1, Math.round(1 + normalized * (config.maxPositionSize - 1)));

  return Math.min(size, config.maxPositionSize);
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
 * Determine if the signal is strong enough and in the right direction to trade.
 * Adds hysteresis: signal must be above threshold (not just barely crossing it).
 */
export function shouldTrade(
  signal: { overallSignal: string; confidence: number; score: number },
  config: RiskConfig = DEFAULT_RISK_CONFIG
): { action: 'BUY' | 'SELL' | null; size: number } {
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

  const size = calculatePositionSize(signal.confidence, config);
  return { action, size };
}
