import type { LiquidationStats } from '../hooks/useLiquidationData';
import type { WhaleTransaction } from './blockchain';
import { priceMomentumScore, rollingZScore } from './indicators';

export type SignalStrength = 'STRONG BUY' | 'BUY' | 'NEUTRAL' | 'SELL' | 'STRONG SELL';

export interface SignalComponent {
  name: string;
  score: number; // -1 to 1 (negative = bearish/sell, positive = bullish/buy)
  weight: number;
  reason: string;
}

export interface SignalResult {
  overallSignal: SignalStrength;
  confidence: number; // 0 to 100%
  score: number; // -1 to 1
  components: SignalComponent[];
  timestamp: number;
}

export interface SignalInputs {
  liquidationStats: LiquidationStats;
  longShortRatio: number | null;
  mempoolTxCount: number | null;
  fastestFee: number | null;
  whaleTransactions: WhaleTransaction[];
  hashrateTrend: 'UP' | 'DOWN' | 'FLAT' | null;
  // New inputs for v2
  fundingRate: number | null;
  recentPrices: number[]; // last N price snapshots for momentum
  oiHistory: number[];    // last N OI snapshots for OI delta
}

/**
 * Signal history for debounce/hysteresis.
 * Kept module-level so it persists across re-renders.
 */
const signalHistory: number[] = [];
const MAX_SIGNAL_HISTORY = 20;

export function generateTradingSignal(inputs: SignalInputs): SignalResult {
  const components: SignalComponent[] = [];

  // 1. Liquidation Imbalance (weight: 0.20)
  // >70% long liqs = buy (capitulation)
  // >70% short liqs = sell (blow-off top)
  const totalLiqs = inputs.liquidationStats.totalLongUsd + inputs.liquidationStats.totalShortUsd;
  if (totalLiqs > 0) {
    const longPct = inputs.liquidationStats.totalLongUsd / totalLiqs;
    let score = 0;
    let reason = 'Balanced liquidations';
    if (longPct > 0.7) {
      score = 0.8; // Bullish
      reason = 'Heavy long liquidations (Capitulation)';
    } else if (longPct < 0.3) {
      score = -0.8; // Bearish
      reason = 'Heavy short liquidations (Blow-off)';
    } else {
      // Scale smoothly
      score = (longPct - 0.5) * 1.6; // 0.5 -> 0, 1.0 -> 0.8
    }
    components.push({ name: 'Liquidation Imbalance', score, weight: 0.20, reason });
  }

  // 2. Long/Short Ratio (weight: 0.15)
  // Contrarian: High longs = bearish, High shorts = bullish
  if (inputs.longShortRatio !== null) {
    let score = 0;
    let reason = 'Neutral positioning';
    if (inputs.longShortRatio > 1.5) {
      score = -0.6;
      reason = 'Extreme long bias (Contrarian Sell)';
    } else if (inputs.longShortRatio < 0.8) {
      score = 0.6;
      reason = 'Extreme short bias (Contrarian Buy)';
    } else {
      score = (1 - inputs.longShortRatio) * 0.5;
      reason = 'Moderate positioning';
    }
    components.push({ name: 'Long/Short Ratio', score, weight: 0.15, reason });
  }

  // 3. Price Momentum — NEW (weight: 0.20)
  if (inputs.recentPrices && inputs.recentPrices.length >= 25) {
    const momentumScore = priceMomentumScore(inputs.recentPrices);
    let reason = 'Flat momentum';
    if (momentumScore > 0.3) reason = 'Strong upward momentum';
    else if (momentumScore > 0.1) reason = 'Mild upward momentum';
    else if (momentumScore < -0.3) reason = 'Strong downward momentum';
    else if (momentumScore < -0.1) reason = 'Mild downward momentum';

    components.push({ name: 'Price Momentum', score: momentumScore, weight: 0.20, reason });
  }

  // 4. Funding Rate — NEW (weight: 0.15)
  // Contrarian: high positive funding = market overheated long → bearish
  // High negative funding = too many shorts → bullish
  if (inputs.fundingRate !== null) {
    let score = 0;
    let reason = 'Neutral funding';

    // Funding rate is typically between -0.01 and +0.01 (1%)
    // Extreme values beyond ±0.005 are strong signals
    if (inputs.fundingRate > 0.005) {
      score = -0.7;
      reason = `High positive funding (${(inputs.fundingRate * 100).toFixed(3)}%) — Longs paying`;
    } else if (inputs.fundingRate > 0.001) {
      score = -0.3;
      reason = `Mildly positive funding (${(inputs.fundingRate * 100).toFixed(3)}%)`;
    } else if (inputs.fundingRate < -0.005) {
      score = 0.7;
      reason = `High negative funding (${(inputs.fundingRate * 100).toFixed(3)}%) — Shorts paying`;
    } else if (inputs.fundingRate < -0.001) {
      score = 0.3;
      reason = `Mildly negative funding (${(inputs.fundingRate * 100).toFixed(3)}%)`;
    }
    components.push({ name: 'Funding Rate', score, weight: 0.15, reason });
  }

  // 5. OI Delta — NEW (weight: 0.10)
  // Rising OI + rising price = strong trend confirmation
  // Rising OI + falling price = incoming liquidation cascade
  if (inputs.oiHistory && inputs.oiHistory.length >= 5 && inputs.recentPrices && inputs.recentPrices.length >= 5) {
    const oiLen = inputs.oiHistory.length;
    const priceLen = inputs.recentPrices.length;
    const oiChange = (inputs.oiHistory[oiLen - 1] - inputs.oiHistory[oiLen - 5]) / inputs.oiHistory[oiLen - 5];
    const priceChange = (inputs.recentPrices[priceLen - 1] - inputs.recentPrices[priceLen - 5]) / inputs.recentPrices[priceLen - 5];

    let score = 0;
    let reason = 'Stable open interest';

    if (oiChange > 0.02 && priceChange > 0) {
      score = 0.5;
      reason = 'Rising OI + Rising price (Strong trend)';
    } else if (oiChange > 0.02 && priceChange < 0) {
      score = -0.5;
      reason = 'Rising OI + Falling price (Liquidation risk)';
    } else if (oiChange < -0.02) {
      score = priceChange > 0 ? -0.3 : 0.3; // Deleveraging
      reason = `Falling OI (Deleveraging: ${(oiChange * 100).toFixed(1)}%)`;
    }
    components.push({ name: 'OI Delta', score, weight: 0.10, reason });
  }

  // 6. Mempool Congestion (weight: 0.05)
  if (inputs.mempoolTxCount !== null) {
    let score = 0;
    let reason = 'Normal network demand';
    if (inputs.mempoolTxCount > 150000) {
      score = 0.5;
      reason = 'High unconfirmed TXs (High Demand)';
    } else if (inputs.mempoolTxCount < 20000) {
      score = -0.3;
      reason = 'Low network demand';
    }
    components.push({ name: 'Mempool Congestion', score, weight: 0.05, reason });
  }

  // 7. Fee Market (weight: 0.05)
  if (inputs.fastestFee !== null) {
    let score = 0;
    let reason = 'Normal fees';
    if (inputs.fastestFee > 100) {
      score = 0.5;
      reason = 'Fee spike (Urgent Demand)';
    }
    components.push({ name: 'Fee Market', score, weight: 0.05, reason });
  }

  // 8. Whale Flows (weight: 0.15)
  if (inputs.whaleTransactions.length > 0) {
    let inflowVol = 0;
    let outflowVol = 0;
    for (const tx of inputs.whaleTransactions) {
      if (tx.type === 'INFLOW') inflowVol += tx.amountBtc;
      if (tx.type === 'OUTFLOW') outflowVol += tx.amountBtc;
    }
    const totalFlow = inflowVol + outflowVol;
    let score = 0;
    let reason = 'Balanced whale activity';
    
    if (totalFlow > 0) {
      const netFlow = outflowVol - inflowVol; // positive is bullish
      score = Math.max(-1, Math.min(1, netFlow / 1000)); // Cap at +/- 1000 BTC net flow
      
      if (score > 0.3) reason = 'Whale Accumulation (Outflows)';
      else if (score < -0.3) reason = 'Whale Distribution (Inflows)';
    }
    
    components.push({ name: 'Whale Flows', score, weight: 0.15, reason });
  }

  // 9. Hashrate Trend (weight: 0.10, reduced from 0.15)
  if (inputs.hashrateTrend !== null) {
    let score = 0;
    let reason = 'Stable Hashrate';
    if (inputs.hashrateTrend === 'UP') {
      score = 0.4;
      reason = 'Rising Hashrate (Bullish)';
    } else if (inputs.hashrateTrend === 'DOWN') {
      score = -0.4;
      reason = 'Declining Hashrate (Capitulation)';
    }
    components.push({ name: 'Hashrate/Difficulty', score, weight: 0.10, reason });
  }

  // Calculate weighted average (dynamically normalized)
  let totalScore = 0;
  let totalWeight = 0;

  for (const comp of components) {
    totalScore += comp.score * comp.weight;
    totalWeight += comp.weight;
  }

  const rawScore = totalWeight > 0 ? totalScore / totalWeight : 0;

  // Apply debounce/hysteresis — smooth out rapid flips
  signalHistory.push(rawScore);
  if (signalHistory.length > MAX_SIGNAL_HISTORY) {
    signalHistory.shift();
  }

  // Use weighted average of recent signals (more recent = higher weight)
  let smoothedScore = 0;
  let smoothWeight = 0;
  for (let i = 0; i < signalHistory.length; i++) {
    const w = (i + 1); // linear weight: 1, 2, 3, ...
    smoothedScore += signalHistory[i] * w;
    smoothWeight += w;
  }
  const finalScore = smoothWeight > 0 ? smoothedScore / smoothWeight : rawScore;
  
  // Map to SignalStrength
  let overallSignal: SignalStrength = 'NEUTRAL';
  if (finalScore >= 0.5) overallSignal = 'STRONG BUY';
  else if (finalScore >= 0.15) overallSignal = 'BUY';
  else if (finalScore <= -0.5) overallSignal = 'STRONG SELL';
  else if (finalScore <= -0.15) overallSignal = 'SELL';

  // Confidence: combination of score magnitude and number of contributing signals
  const signalCoverage = totalWeight; // how many signals are active (sum of weights)
  const confidence = Math.min(100, Math.round(
    Math.abs(finalScore) * 60 +     // score magnitude contributes 60%
    signalCoverage * 40              // signal coverage contributes 40%
  ));

  return {
    overallSignal,
    confidence,
    score: Math.round(finalScore * 1000) / 1000,
    components,
    timestamp: Date.now(),
  };
}
