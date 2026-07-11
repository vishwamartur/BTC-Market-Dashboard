export interface MempoolStats {
  count: number;
  vsize: number;
  total_fee: number;
  fee_histogram: number[][];
}

export interface MempoolFees {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  minimumFee: number;
}

export interface BlockData {
  id: string;
  height: number;
  version: number;
  timestamp: number;
  tx_count: number;
  size: number;
  weight: number;
  merkle_root: string;
  previousblockhash: string;
  mediantime: number;
  nonce: number;
  bits: number;
  difficulty: number;
}

export interface HashrateData {
  hashrates: {
    timestamp: number;
    avgHashrate: number;
  }[];
  difficulty: {
    time: number;
    difficulty: number;
  }[];
  currentHashrate: number;
  currentDifficulty: number;
}

export const MEMPOOL_API_BASE = 'https://mempool.space/api';

export async function fetchMempoolStats(): Promise<MempoolStats> {
  const res = await resilientFetch(`${MEMPOOL_API_BASE}/mempool`, { retries: 1, timeoutMs: 8000 });
  if (!res.ok) throw new Error('Failed to fetch mempool stats');
  return res.json();
}

export async function fetchMempoolFees(): Promise<MempoolFees> {
  const res = await resilientFetch(`${MEMPOOL_API_BASE}/v1/fees/recommended`, { retries: 1, timeoutMs: 8000 });
  if (!res.ok) throw new Error('Failed to fetch mempool fees');
  return res.json();
}

export async function fetchLatestBlocks(): Promise<BlockData[]> {
  const res = await resilientFetch(`${MEMPOOL_API_BASE}/v1/blocks`, { retries: 1, timeoutMs: 8000 });
  if (!res.ok) throw new Error('Failed to fetch latest blocks');
  return res.json();
}

export async function fetchHashrate(): Promise<HashrateData> {
  const res = await resilientFetch(`${MEMPOOL_API_BASE}/v1/mining/hashrate/3d`, { retries: 1, timeoutMs: 8000 });
  if (!res.ok) throw new Error('Failed to fetch hashrate');
  return res.json();
}
import { resilientFetch } from './resilientFetch';
