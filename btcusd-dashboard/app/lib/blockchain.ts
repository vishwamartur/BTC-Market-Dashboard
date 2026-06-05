export interface BlockchainTxInput {
  sequence: number;
  witness: string;
  script: string;
  index: number;
  prev_out: {
    addr: string;
    n: number;
    script: string;
    spending_outpoints: any[];
    spent: boolean;
    tx_index: number;
    type: number;
    value: number;
  };
}

export interface BlockchainTxOutput {
  type: number;
  spent: boolean;
  value: number; // in satoshis
  spending_outpoints: any[];
  n: number;
  tx_index: number;
  script: string;
  addr: string;
}

export interface BlockchainTx {
  hash: string;
  ver: number;
  vin_sz: number;
  vout_sz: number;
  size: number;
  weight: number;
  fee: number; // in satoshis
  relayed_by: string;
  lock_time: number;
  tx_index: number;
  double_spend: boolean;
  time: number;
  block_index: number | null;
  block_height: number | null;
  inputs: BlockchainTxInput[];
  out: BlockchainTxOutput[];
}

export interface UnconfirmedTransactionsResponse {
  txs: BlockchainTx[];
}

export interface WhaleTransaction {
  hash: string;
  time: number;
  amountBtc: number;
  usdValue: number;
  feeBtc: number;
  type: 'INFLOW' | 'OUTFLOW' | 'TRANSFER'; // Heuristic based
}

export const BLOCKCHAIN_API_BASE = 'https://blockchain.info';

export async function fetchUnconfirmedTransactions(): Promise<UnconfirmedTransactionsResponse> {
  const res = await fetch(`${BLOCKCHAIN_API_BASE}/unconfirmed-transactions?format=json`);
  if (res.status === 429) {
    throw new Error('Rate limited by blockchain.info (429)');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (body.toLowerCase().includes('rate')) {
      throw new Error(`Rate limited by blockchain.info (${res.status})`);
    }
    throw new Error(`Failed to fetch unconfirmed transactions (${res.status})`);
  }
  return res.json();
}

// Heuristic to classify whale transactions
export function classifyWhaleTransaction(tx: BlockchainTx, btcPrice: number): WhaleTransaction | null {
  // 1 BTC = 100,000,000 satoshis
  const SATS_PER_BTC = 100_000_000;
  
  // Calculate total output value
  let totalSats = 0;
  for (const output of tx.out) {
    totalSats += output.value;
  }
  
  const amountBtc = totalSats / SATS_PER_BTC;
  
  // Filter for > 10 BTC
  if (amountBtc < 10) return null;

  // Basic heuristic:
  // Many inputs -> few outputs = Consolidation (Often Exchange Inflow)
  // Few inputs -> many outputs = Distribution (Often Exchange Outflow)
  // Few inputs -> few outputs = Transfer
  
  let type: 'INFLOW' | 'OUTFLOW' | 'TRANSFER' = 'TRANSFER';
  
  if (tx.inputs.length > 5 && tx.out.length <= 2) {
    type = 'INFLOW'; // Bearish
  } else if (tx.inputs.length <= 2 && tx.out.length > 5) {
    type = 'OUTFLOW'; // Bullish
  } else if (amountBtc > 100) {
    type = 'TRANSFER'; // Whale movement
  }

  return {
    hash: tx.hash,
    time: tx.time * 1000, // convert to ms
    amountBtc,
    usdValue: amountBtc * btcPrice,
    feeBtc: tx.fee / SATS_PER_BTC,
    type,
  };
}
