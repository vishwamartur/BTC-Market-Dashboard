import { request } from 'undici';
import type { Config } from './config/index.js';

import type { SignalData } from './types.js';
export type { SignalData } from './types.js';

export interface MarketData {
  price: number;
}

export async function fetchSignal(config: Config): Promise<SignalData> {
  const url = `${config.DASHBOARD_URL}/api/signal`;
  const { statusCode, body } = await request(url);

  if (statusCode !== 200) {
    throw new Error(`Failed to fetch signal. Status: ${statusCode}`);
  }

  const raw = await body.json() as Record<string, unknown>;
  if (!raw || typeof raw.overallSignal !== 'string') {
    throw new Error(`Failed to parse signal response`);
  }

  // Parse optional trend/sentiment fields if present in the dashboard response.
  const data: SignalData = {
    overallSignal: raw.overallSignal,
    confidence: Number(raw.confidence ?? 0),
    score: Number(raw.score ?? 0),
  };

  if (typeof raw.trendDrift === 'number') data.trendDrift = raw.trendDrift;
  if (typeof raw.rangeBreakout === 'number') data.rangeBreakout = raw.rangeBreakout;
  if (typeof raw.newsSentiment === 'number') data.newsSentiment = raw.newsSentiment;

  // Components are an array of { name, score, weight, reason }
  if (Array.isArray(raw.components)) {
    data.components = raw.components as NonNullable<SignalData['components']>;
  }

  return data;
}

export async function fetchMarketPrice(config: Config): Promise<number> {
  const url = `${config.DASHBOARD_URL}/api/market`;
  const { statusCode, body } = await request(url);

  if (statusCode !== 200) {
    throw new Error(`Failed to fetch market price. Status: ${statusCode}`);
  }

  const data = await body.json() as any;
  const price = data.price || data.ticker?.close || data.fundingRate?.markPrice;
  if (!price) {
    throw new Error(`Failed to parse market price response`);
  }

  return Number(price);
}

/**
 * Fetch the Average True Range (ATR) from the dashboard market endpoint.
 *
 * Returns the dashboard's `atr14` field if exposed, otherwise falls back
 * to a simple ATR proxy computed as 2% of the current spot price.
 * Returns 0 if neither price nor ATR is available — callers should treat
 * that as "no ATR info" and skip volatility-based logic.
 */
export async function fetchAtr(config: Config): Promise<number> {
  const url = `${config.DASHBOARD_URL}/api/market`;
  let currentPrice = 0;
  try {
    const { statusCode, body } = await request(url);
    if (statusCode !== 200) {
      throw new Error(`Failed to fetch market data. Status: ${statusCode}`);
    }
    const data = await body.json() as Record<string, any>;

    // Prefer explicit ATR fields from the dashboard
    const explicitAtr = data.atr14 ?? data.atr ?? data.ATR;
    if (typeof explicitAtr === 'number' && explicitAtr > 0) {
      return explicitAtr;
    }

    // Fall back to deriving a price-based ATR proxy
    const rawPrice = data.price ?? data.ticker?.close ?? data.fundingRate?.markPrice;
    if (typeof rawPrice === 'number' && rawPrice > 0) {
      currentPrice = rawPrice;
    }
  } catch (err) {
    // Swallow network errors — caller will receive the price-based fallback.
  }

  // 2% of price is a sensible ATR proxy for BTC at ~30-60% annualized vol
  return currentPrice > 0 ? currentPrice * 0.02 : 0;
}
