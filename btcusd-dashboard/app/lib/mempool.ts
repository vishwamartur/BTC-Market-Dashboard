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
  const res = await fetch(`${MEMPOOL_API_BASE}/mempool`);
  if (!res.ok) throw new Error('Failed to fetch mempool stats');
  return res.json();
}

export async function fetchMempoolFees(): Promise<MempoolFees> {
  const res = await fetch(`${MEMPOOL_API_BASE}/v1/fees/recommended`);
  if (!res.ok) throw new Error('Failed to fetch mempool fees');
  return res.json();
}

export async function fetchLatestBlocks(): Promise<BlockData[]> {
  const res = await fetch(`${MEMPOOL_API_BASE}/v1/blocks`);
  if (!res.ok) throw new Error('Failed to fetch latest blocks');
  return res.json();
}

export async function fetchHashrate(): Promise<HashrateData> {
  const res = await fetch(`${MEMPOOL_API_BASE}/v1/mining/hashrate/3d`);
  if (!res.ok) throw new Error('Failed to fetch hashrate');
  return res.json();
}
