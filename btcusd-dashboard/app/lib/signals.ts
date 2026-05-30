import type { LiquidationStats } from '../hooks/useLiquidationData';
import type { WhaleTransaction } from './blockchain';

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
}

export interface SignalInputs {
  liquidationStats: LiquidationStats;
  longShortRatio: number | null;
  mempoolTxCount: number | null;
  fastestFee: number | null;
  whaleTransactions: WhaleTransaction[];
  hashrateTrend: 'UP' | 'DOWN' | 'FLAT' | null;
}

export function generateTradingSignal(inputs: SignalInputs): SignalResult {
  const components: SignalComponent[] = [];

  // 1. Liquidation Imbalance
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
    components.push({ name: 'Liquidation Imbalance', score, weight: 0.25, reason });
  }

  // 2. Long/Short Ratio
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
      score = (1 - inputs.longShortRatio) * 0.5; // Rough scaling
      reason = 'Moderate positioning';
    }
    components.push({ name: 'Long/Short Ratio', score, weight: 0.20, reason });
  }

  // 3. Mempool Congestion
  // High unconfirmed = network demand = bullish
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
    components.push({ name: 'Mempool Congestion', score, weight: 0.10, reason });
  }

  // 4. Fee Market
  // Spiking fees = urgency = bullish
  if (inputs.fastestFee !== null) {
    let score = 0;
    let reason = 'Normal fees';
    if (inputs.fastestFee > 100) {
      score = 0.5;
      reason = 'Fee spike (Urgent Demand)';
    }
    components.push({ name: 'Fee Market', score, weight: 0.10, reason });
  }

  // 5. Whale Flows
  // Outflows = Accumulation (Buy), Inflows = Selling (Sell)
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
    
    components.push({ name: 'Whale Flows', score, weight: 0.20, reason });
  }

  // 6. Hashrate Trend
  // Rising = confident, Falling = capitulation
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
    components.push({ name: 'Hashrate/Difficulty', score, weight: 0.15, reason });
  }

  // Calculate weighted average
  let totalScore = 0;
  let totalWeight = 0;

  for (const comp of components) {
    totalScore += comp.score * comp.weight;
    totalWeight += comp.weight;
  }

  // Normalize score
  const finalScore = totalWeight > 0 ? totalScore / totalWeight : 0;
  
  // Map to SignalStrength
  let overallSignal: SignalStrength = 'NEUTRAL';
  if (finalScore >= 0.5) overallSignal = 'STRONG BUY';
  else if (finalScore >= 0.15) overallSignal = 'BUY';
  else if (finalScore <= -0.5) overallSignal = 'STRONG SELL';
  else if (finalScore <= -0.15) overallSignal = 'SELL';

  // Confidence is just the magnitude of the score scaled to 0-100%
  // Or based on how many signals are present vs total weight
  const confidence = Math.min(100, Math.round(Math.abs(finalScore) * 100 + (totalWeight * 20)));

  return {
    overallSignal,
    confidence,
    score: finalScore,
    components,
  };
}
