import { request } from 'undici';
import type { Config } from './config/index.js';

export interface SignalData {
  overallSignal: string;
  confidence: number;
  score: number;
}

export interface MarketData {
  price: number;
}

export async function fetchSignal(config: Config): Promise<SignalData> {
  const url = `${config.DASHBOARD_URL}/api/signal`;
  const { statusCode, body } = await request(url);
  
  if (statusCode !== 200) {
    throw new Error(`Failed to fetch signal. Status: ${statusCode}`);
  }
  
  const data = await body.json() as SignalData;
  if (!data || typeof data.overallSignal !== 'string') {
    throw new Error(`Failed to parse signal response`);
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
