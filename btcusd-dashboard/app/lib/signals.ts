import type { LiquidationStats } from '../hooks/useLiquidationData';
import type { WhaleTransaction } from './blockchain';
import {
  priceMomentumScore,
  calcLinearRegressionSlope,
  calcEMASlope,
  calcDonchianChannels,
  calcBollingerBandwidth,
  detectMarketRegime,
  type MarketRegime,
} from './indicators';
import type { SignalDataQuality } from './signalQuality';

export type SignalStrength = 'STRONG BUY' | 'BUY' | 'NEUTRAL' | 'SELL' | 'STRONG SELL';

export const MIN_CONFLUENCE_COMPONENTS = 3;
export const MIN_COMPONENT_SCORE = 0.3;

const REGIME_WEIGHT_MULTIPLIERS: Record<MarketRegime, Partial<Record<string, number>>> = {
  trending: { 'Range Breakout': 0.5 },
  ranging: { 'Price Momentum': 0.5, 'Trend Drift': 0.5 },
  choppy: { 'Price Momentum': 0.3, 'Trend Drift': 0.3, 'Range Breakout': 0.3, 'News Sentiment': 0.5 },
};

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
  /** Pre-gate weighted score, retained to explain a neutral safety decision. */
  rawScore?: number;
  /** Pre-gate confidence, retained for display only and never tradeable. */
  provisionalConfidence?: number;
  components: SignalComponent[];
  timestamp: number;
  // Optional per-component scores consumed by downstream consumers
  // (e.g. v2 drift-enhanced hedge). Null when the component was not active.
  trendDrift?: number | null;
  rangeBreakout?: number | null;
  newsSentiment?: number | null;
  regime?: MarketRegime;
  confluenceCount?: number;
  /** Number of independent strong components opposing the final direction. */
  opposingConfluenceCount?: number;
  /** Freshness/readiness metadata used to make the result safe to act on. */
  dataQuality?: SignalDataQuality;
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
  // Real-time news sentiment in [-1, +1]; null if unavailable.
  newsSentiment: number | null;
  /** Omitted by callers that do not have source freshness metadata. */
  dataQuality?: SignalDataQuality;
}

const CONFLUENCE_GROUPS: Record<string, string> = {
  'Price Momentum': 'price-action',
  'Trend Drift': 'price-action',
  'Range Breakout': 'price-action',
  'Long/Short Ratio': 'derivatives-positioning',
  'Funding Rate': 'derivatives-positioning',
};

function getConfluenceGroup(component: SignalComponent): string {
  return CONFLUENCE_GROUPS[component.name] ?? component.name;
}

/**
 * Signal history for debounce/hysteresis.
 * Kept module-level so it persists across re-renders.
 */
const signalHistory: number[] = [];
const MAX_SIGNAL_HISTORY = 20;

/**
 * Reset the module-level signal history buffer.
 *
 * Intended for tests that need a deterministic starting state. Production
 * callers should not need this — the buffer self-trims at MAX_SIGNAL_HISTORY.
 */
export function resetSignalHistory(): void {
  signalHistory.length = 0;
}

export function generateTradingSignal(inputs: SignalInputs): SignalResult {
  const components: SignalComponent[] = [];

  // 1. Liquidation Imbalance (weight: 0.15)
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
    components.push({ name: 'Liquidation Imbalance', score, weight: 0.15, reason });
  }

  // 2. Long/Short Ratio (weight: 0.11)
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
    components.push({ name: 'Long/Short Ratio', score, weight: 0.11, reason });
  }

  // 3. Price Momentum — NEW (weight: 0.15)
  if (inputs.recentPrices && inputs.recentPrices.length >= 25) {
    const momentumScore = priceMomentumScore(inputs.recentPrices);
    let reason = 'Flat momentum';
    if (momentumScore > 0.3) reason = 'Strong upward momentum';
    else if (momentumScore > 0.1) reason = 'Mild upward momentum';
    else if (momentumScore < -0.3) reason = 'Strong downward momentum';
    else if (momentumScore < -0.1) reason = 'Mild downward momentum';

    components.push({ name: 'Price Momentum', score: momentumScore, weight: 0.15, reason });
  }

  // 4. Funding Rate — NEW (weight: 0.11)
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
    components.push({ name: 'Funding Rate', score, weight: 0.11, reason });
  }

  // 5. OI Delta — NEW (weight: 0.08)
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
    components.push({ name: 'OI Delta', score, weight: 0.08, reason });
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

  // 8. Whale Flows (weight: 0.05)
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

    components.push({ name: 'Whale Flows', score, weight: 0.05, reason });
  }

  // 9. Hashrate Trend (weight: 0.02)
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
    components.push({ name: 'Hashrate/Difficulty', score, weight: 0.02, reason });
  }

  // 10. Trend Drift (weight: 0.11) — Chunk 2
  // Detects slow drift using LR slope and EMA21 slope, normalized by current price.
  let trendDriftScore: number | null = null;
  if (inputs.recentPrices && inputs.recentPrices.length >= 25) {
    const lrSlope = calcLinearRegressionSlope(inputs.recentPrices);
    const ema21Slope = calcEMASlope(inputs.recentPrices, 21);
    const currentPrice = inputs.recentPrices[inputs.recentPrices.length - 1];
    const lrSlopePerPoint = currentPrice > 0 ? lrSlope / currentPrice : 0;

    let driftScore = (lrSlopePerPoint * 5) + (ema21Slope * 10);
    if (driftScore > 1) driftScore = 1;
    else if (driftScore < -1) driftScore = -1;
    trendDriftScore = driftScore;

    let reason = 'Price drifting sideways';
    if (driftScore < -0.1) reason = 'Slow downtrend detected (negative LR/EMA slope)';
    else if (driftScore > 0.1) reason = 'Slow uptrend detected';

    components.push({ name: 'Trend Drift', score: driftScore, weight: 0.11, reason });
  }

  // 11. Range Breakout (weight: 0.07) — Chunk 2
  // Detects Bollinger/Donchian squeezes hugging the upper or lower channel.
  let rangeBreakoutScore: number | null = null;
  if (inputs.recentPrices && inputs.recentPrices.length >= 20) {
    const bandwidthSeries = calcBollingerBandwidth(inputs.recentPrices, 20, 2);
    const donchian = calcDonchianChannels(inputs.recentPrices, 20);
    const current = inputs.recentPrices[inputs.recentPrices.length - 1];
    const bandwidth = bandwidthSeries[bandwidthSeries.length - 1];
    const lower = donchian.lower[donchian.lower.length - 1];
    const upper = donchian.upper[donchian.upper.length - 1];

    let score = 0;
    let reason = 'No clear range breakout';

    if (current > 0 && isFinite(lower) && isFinite(upper)) {
      if (bandwidth < 0.02 && (current - lower) / current < 0.005) {
        score = -0.7;
        reason = 'Downside range breakout building';
      } else if (bandwidth < 0.02 && (upper - current) / current < 0.005) {
        score = 0.7;
        reason = 'Upside range breakout building';
      }
    }
    rangeBreakoutScore = score;

    components.push({ name: 'Range Breakout', score, weight: 0.07, reason });
  }

  // 12. News Sentiment (weight: 0.05) — Chunk 3
  let newsSentimentScore: number | null = null;
  if (inputs.newsSentiment !== null) {
    let score = 0;
    let reason = 'Neutral news sentiment';
    if (inputs.newsSentiment < -0.3) {
      score = -0.6;
      reason = 'Negative news sentiment';
    } else if (inputs.newsSentiment > 0.3) {
      score = 0.6;
      reason = 'Positive news sentiment';
    }
    newsSentimentScore = score;
    components.push({ name: 'News Sentiment', score, weight: 0.05, reason });
  }

  // Detect market regime and down-weight misaligned components
  const regime = detectMarketRegime(inputs.recentPrices);
  const multipliers = REGIME_WEIGHT_MULTIPLIERS[regime];
  for (const comp of components) {
    const multiplier = multipliers?.[comp.name];
    if (multiplier !== undefined) {
      comp.weight = Math.round(comp.weight * multiplier * 1000) / 1000;
    }
  }

  // Calculate weighted average (dynamically normalized)
  let totalScore = 0;
  let totalWeight = 0;

  for (const comp of components) {
    totalScore += comp.score * comp.weight;
    totalWeight += comp.weight;
  }

  const rawScore = totalWeight > 0 ? totalScore / totalWeight : 0;
  const provisionalConfidence = Math.min(100, Math.round(
    Math.abs(rawScore) * 60 + totalWeight * 40,
  ));

  // Never let stale or incomplete critical data enter the smoothing history.
  // Keeping the component breakdown lets the UI explain why trading is paused.
  if (inputs.dataQuality && !inputs.dataQuality.isReady) {
    return {
      overallSignal: 'NEUTRAL',
      confidence: 0,
      score: 0,
      rawScore: Math.round(rawScore * 1000) / 1000,
      provisionalConfidence,
      components,
      timestamp: Date.now(),
      trendDrift: trendDriftScore,
      rangeBreakout: rangeBreakoutScore,
      newsSentiment: newsSentimentScore,
      regime,
      confluenceCount: 0,
      opposingConfluenceCount: 0,
      dataQuality: inputs.dataQuality,
    };
  }

  // Count independent, directionally aligned evidence. Three derived price
  // indicators should not be allowed to satisfy confluence on their own, and
  // mixed bullish/bearish evidence should not be described as agreement.
  const direction = rawScore === 0 ? 0 : rawScore > 0 ? 1 : -1;
  const strongestByGroup = new Map<string, SignalComponent>();
  for (const component of components) {
    if (Math.abs(component.score) < MIN_COMPONENT_SCORE) continue;
    const group = getConfluenceGroup(component);
    const previous = strongestByGroup.get(group);
    if (!previous || Math.abs(component.score) > Math.abs(previous.score)) {
      strongestByGroup.set(group, component);
    }
  }

  const strongComponents = [...strongestByGroup.values()];
  const confluenceCount = direction === 0
    ? 0
    : strongComponents.filter((component) => component.score * direction >= MIN_COMPONENT_SCORE).length;
  const opposingConfluenceCount = direction === 0
    ? 0
    : strongComponents.filter((component) => component.score * direction <= -MIN_COMPONENT_SCORE).length;

  if (confluenceCount < MIN_CONFLUENCE_COMPONENTS) {
    return {
      overallSignal: 'NEUTRAL',
      confidence: 0,
      score: 0,
      rawScore: Math.round(rawScore * 1000) / 1000,
      provisionalConfidence,
      components,
      timestamp: Date.now(),
      trendDrift: trendDriftScore,
      rangeBreakout: rangeBreakoutScore,
      newsSentiment: newsSentimentScore,
      regime,
      confluenceCount,
      opposingConfluenceCount,
      dataQuality: inputs.dataQuality,
    };
  }

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

  // A transition may have enough current evidence but still be opposed by the
  // debounce history. Do not publish the old direction under new confluence.
  if (direction !== 0 && finalScore * direction < 0) {
    return {
      overallSignal: 'NEUTRAL',
      confidence: 0,
      score: 0,
      rawScore: Math.round(rawScore * 1000) / 1000,
      provisionalConfidence,
      components,
      timestamp: Date.now(),
      trendDrift: trendDriftScore,
      rangeBreakout: rangeBreakoutScore,
      newsSentiment: newsSentimentScore,
      regime,
      confluenceCount,
      opposingConfluenceCount,
      dataQuality: inputs.dataQuality,
    };
  }

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
    rawScore: Math.round(rawScore * 1000) / 1000,
    provisionalConfidence,
    components,
    timestamp: Date.now(),
    trendDrift: trendDriftScore,
    rangeBreakout: rangeBreakoutScore,
    newsSentiment: newsSentimentScore,
    regime,
    confluenceCount,
    opposingConfluenceCount,
    dataQuality: inputs.dataQuality,
  };
}
