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
 * Least-squares linear regression slope over the full price array.
 * x = index, y = price. Returns 0 if there are fewer than 2 points.
 */
export function calcLinearRegressionSlope(prices: number[]): number {
  const n = prices.length;
  if (n < 2) return 0;

  // x_i = i for i in 0..n-1; sum(x) = n(n-1)/2, sum(x^2) = (n-1)n(2n-1)/6
  let sumY = 0;
  for (let i = 0; i < n; i++) sumY += prices[i];

  const meanX = (n - 1) / 2;
  const meanY = sumY / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    const dy = prices[i] - meanY;
    num += dx * dy;
    den += dx * dx;
  }

  if (den === 0) return 0;
  return num / den;
}

/**
 * Fractional-change slope of the EMA line over the last `period` points.
 * Computed as (ema[last] - ema[first]) / ema[first], where "first" is the
 * earliest of the last `period` EMA values and "last" is the most recent.
 * Returns 0 if there are not enough prices to compute the EMA.
 */
export function calcEMASlope(prices: number[], period: number): number {
  if (prices.length < period || period < 2) return 0;

  const ema = calcEMA(prices, period);
  const first = ema[ema.length - period];
  const last = ema[ema.length - 1];

  if (!isFinite(first) || first === 0) return 0;
  return (last - first) / first;
}

/**
 * Donchian channels: rolling high (upper) and low (lower) over `period` bars.
 * Indices before a full window is available are filled with NaN, matching the
 * convention used by calcSMA / calcBollingerBands in this module.
 */
export function calcDonchianChannels(
  prices: number[],
  period: number
): { upper: number[]; lower: number[] } {
  const upper: number[] = [];
  const lower: number[] = [];

  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) {
      upper.push(NaN);
      lower.push(NaN);
    } else {
      let hi = -Infinity;
      let lo = Infinity;
      for (let j = i - period + 1; j <= i; j++) {
        if (prices[j] > hi) hi = prices[j];
        if (prices[j] < lo) lo = prices[j];
      }
      upper.push(hi);
      lower.push(lo);
    }
  }

  return { upper, lower };
}

/**
 * Bollinger bandwidth = (upper - lower) / middle, expressed as a fraction.
 * Returns 0 for any index where the underlying Bollinger Bands are undefined
 * (insufficient data, non-finite middle, or middle == 0).
 */
export function calcBollingerBandwidth(
  prices: number[],
  period: number = 20,
  stddev: number = 2
): number[] {
  const { upper, middle, lower } = calcBollingerBands(prices, period, stddev);
  const bw: number[] = [];

  for (let i = 0; i < prices.length; i++) {
    const m = middle[i];
    if (!isFinite(m) || m === 0) {
      bw.push(0);
    } else {
      bw.push((upper[i] - lower[i]) / m);
    }
  }

  return bw;
}

export type MarketRegime = 'trending' | 'ranging' | 'choppy';

/**
 * Classify recent price action as trending, ranging, or choppy.
 *
 * Uses linear-regression slope (directional persistence) and Bollinger
 * bandwidth (volatility contraction). tuned for BTCUSD 5-second snapshots.
 */
export function detectMarketRegime(prices: number[], period: number = 20): MarketRegime {
  if (prices.length < period) return 'choppy';

  const slice = prices.slice(-period);
  const lrSlope = calcLinearRegressionSlope(slice);
  const bandwidthSeries = calcBollingerBandwidth(slice, period, 2);
  const bandwidth = bandwidthSeries[bandwidthSeries.length - 1];

  const currentPrice = slice[slice.length - 1];
  const slopePct = currentPrice > 0 ? Math.abs(lrSlope) / currentPrice : 0;

  if (slopePct > 0.002 && bandwidth > 0.015) return 'trending';
  if (slopePct < 0.001 && bandwidth < 0.015) return 'ranging';
  return 'choppy';
}
