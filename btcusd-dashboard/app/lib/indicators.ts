/**
 * Technical indicators for the signal engine.
 * Pure functions — no side effects, no API calls.
 */

/** Exponential Moving Average */
export function calcEMA(prices: number[], period: number): number[] {
  if (prices.length === 0) return [];
  const k = 2 / (period + 1);
  const ema: number[] = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    ema.push(prices[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

/** Simple Moving Average */
export function calcSMA(prices: number[], period: number): number[] {
  const sma: number[] = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) {
      sma.push(NaN);
    } else {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) {
        sum += prices[j];
      }
      sma.push(sum / period);
    }
  }
  return sma;
}

/** Relative Strength Index (14-period default) */
export function calcRSI(prices: number[], period: number = 14): number[] {
  if (prices.length < period + 1) return [];

  const rsi: number[] = [];
  let gainSum = 0;
  let lossSum = 0;

  // Initial average gain/loss
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gainSum += diff;
    else lossSum -= diff; // make positive
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  // Fill NaN for initial period
  for (let i = 0; i < period; i++) rsi.push(NaN);

  // First RSI value
  const rs0 = avgLoss === 0 ? 100 : avgGain / avgLoss;
  rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs0));

  // Smoothed RSI
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs));
  }

  return rsi;
}

/** Bollinger Bands */
export function calcBollingerBands(
  prices: number[],
  period: number = 20,
  stddev: number = 2
): { upper: number[]; middle: number[]; lower: number[] } {
  const middle = calcSMA(prices, period);
  const upper: number[] = [];
  const lower: number[] = [];

  for (let i = 0; i < prices.length; i++) {
    if (isNaN(middle[i])) {
      upper.push(NaN);
      lower.push(NaN);
    } else {
      let sumSqDiff = 0;
      for (let j = i - period + 1; j <= i; j++) {
        sumSqDiff += (prices[j] - middle[i]) ** 2;
      }
      const sd = Math.sqrt(sumSqDiff / period);
      upper.push(middle[i] + stddev * sd);
      lower.push(middle[i] - stddev * sd);
    }
  }

  return { upper, middle, lower };
}

/** Average True Range — measures volatility */
export function calcATR(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number = 14
): number[] {
  if (highs.length < 2) return [];

  const tr: number[] = [highs[0] - lows[0]]; // first TR is just high - low

  for (let i = 1; i < highs.length; i++) {
    tr.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      )
    );
  }

  // ATR via Wilder's smoothing (same as EMA with k = 1/period)
  const atr: number[] = [];
  for (let i = 0; i < tr.length; i++) {
    if (i < period - 1) {
      atr.push(NaN);
    } else if (i === period - 1) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += tr[j];
      atr.push(sum / period);
    } else {
      atr.push((atr[i - 1] * (period - 1) + tr[i]) / period);
    }
  }

  return atr;
}

/** Rolling z-score for adaptive thresholds */
export function rollingZScore(values: number[], window: number): number[] {
  const zScores: number[] = [];

  for (let i = 0; i < values.length; i++) {
    if (i < window - 1) {
      zScores.push(0); // not enough data yet
    } else {
      let sum = 0;
      let sumSq = 0;
      for (let j = i - window + 1; j <= i; j++) {
        sum += values[j];
        sumSq += values[j] * values[j];
      }
      const mean = sum / window;
      const variance = sumSq / window - mean * mean;
      const stdDev = Math.sqrt(Math.max(0, variance));
      zScores.push(stdDev === 0 ? 0 : (values[i] - mean) / stdDev);
    }
  }

  return zScores;
}

/**
 * Price momentum score based on current price vs moving averages.
 * Returns a score between -1 (strong bearish) and +1 (strong bullish).
 */
export function priceMomentumScore(prices: number[]): number {
  if (prices.length < 25) return 0;

  const current = prices[prices.length - 1];
  const ema8 = calcEMA(prices, 8);
  const ema21 = calcEMA(prices, 21);

  const ema8Val = ema8[ema8.length - 1];
  const ema21Val = ema21[ema21.length - 1];

  let score = 0;

  // Price vs EMA8 (short-term momentum)
  const diffShort = (current - ema8Val) / ema8Val;
  score += Math.max(-0.5, Math.min(0.5, diffShort * 20)); // scale ~2.5% move to 0.5

  // EMA8 vs EMA21 (trend direction)
  const diffTrend = (ema8Val - ema21Val) / ema21Val;
  score += Math.max(-0.5, Math.min(0.5, diffTrend * 15)); // scale ~3.3% spread to 0.5

  return Math.max(-1, Math.min(1, score));
}

/**
 * Short-window momentum score for when we have < 25 price points.
 * Uses EMA5 and EMA10 for faster reaction to momentum.
 * Returns a score between -1 (strong bearish) and +1 (strong bullish).
 */
export function shortMomentumScore(prices: number[]): number {
  if (prices.length < 10) return 0;

  const current = prices[prices.length - 1];
  const ema5 = calcEMA(prices, 5);
  const ema10 = calcEMA(prices, 10);

  const ema5Val = ema5[ema5.length - 1];
  const ema10Val = ema10[ema10.length - 1];

  let score = 0;

  // Price vs EMA5 (very short-term momentum)
  const diffShort = (current - ema5Val) / ema5Val;
  score += Math.max(-0.5, Math.min(0.5, diffShort * 30)); // More sensitive scaling

  // EMA5 vs EMA10 (short trend direction)
  const diffTrend = (ema5Val - ema10Val) / ema10Val;
  score += Math.max(-0.5, Math.min(0.5, diffTrend * 20));

  return Math.max(-1, Math.min(1, score));
}

