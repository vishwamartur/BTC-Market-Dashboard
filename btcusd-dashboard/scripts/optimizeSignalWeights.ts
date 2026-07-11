/**
 * Lightweight grid search over signal component weights.
 *
 * Reads the last 7 days of market snapshots and liquidation events from
 * MongoDB, reconstructs synthetic signal inputs, runs each weight set,
 * and scores them by directional accuracy of the next 1-hour price move.
 *
 * Run with:
 *   MONGODB_URI=mongodb://... npx tsx scripts/optimizeSignalWeights.ts
 */

import { getDb } from '../app/lib/db.js';
import { generateTradingSignal, type SignalInputs } from '../app/lib/signals.js';
import type { WhaleTransaction } from '../app/lib/blockchain.js';
import type { LiquidationEvent } from '../app/lib/exchanges.js';

const LOOKBACK_DAYS = 7;

interface SnapshotDoc {
  timestamp: number;
  price?: number;
  longShortRatio?: { longShortRatio?: string | number };
  fundingRate?: { fundingRate?: string | number };
  openInterest?: { openInterest?: string | number };
}

interface LiquidationDoc {
  orderTradeTime: number;
  side: 'BUY' | 'SELL';
  usdValue: number;
}

interface WeightSet {
  name: string;
  weights: Partial<Record<string, number>>;
}

const DEFAULT_WEIGHTS: Record<string, number> = {
  'Liquidation Imbalance': 0.15,
  'Long/Short Ratio': 0.11,
  'Price Momentum': 0.15,
  'Funding Rate': 0.11,
  'OI Delta': 0.08,
  'Mempool Congestion': 0.05,
  'Fee Market': 0.05,
  'Whale Flows': 0.05,
  'Hashrate/Difficulty': 0.02,
  'Trend Drift': 0.11,
  'Range Breakout': 0.07,
  'News Sentiment': 0.05,
};

const GRID: WeightSet[] = [
  { name: 'default', weights: {} },
  { name: 'momentumHeavy', weights: { 'Price Momentum': 0.22, 'Trend Drift': 0.15, 'Funding Rate': 0.08 } },
  { name: 'contrarianHeavy', weights: { 'Liquidation Imbalance': 0.22, 'Long/Short Ratio': 0.16, 'Funding Rate': 0.16 } },
  { name: 'onchainHeavy', weights: { 'Whale Flows': 0.12, 'Mempool Congestion': 0.10, 'Hashrate/Difficulty': 0.06 } },
  { name: 'balanced', weights: { 'Price Momentum': 0.12, 'Funding Rate': 0.14, 'OI Delta': 0.12, 'Trend Drift': 0.14 } },
];

async function main() {
  const db = await getDb();
  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

  const snapshots = await db
    .collection<SnapshotDoc>('market_snapshots')
    .find({ timestamp: { $gte: cutoff } })
    .sort({ timestamp: 1 })
    .toArray();

  const liquidations = await db
    .collection<LiquidationDoc>('liquidations')
    .find({ orderTradeTime: { $gte: cutoff } })
    .sort({ orderTradeTime: 1 })
    .toArray();

  if (snapshots.length < 50) {
    console.warn(`Only ${snapshots.length} market snapshots found; optimization needs more data.`);
  }

  const results = GRID.map((set) => evaluateWeightSet(set, snapshots, liquidations));
  results.sort((a, b) => b.accuracy - a.accuracy);

  console.log('\n# Signal Weight Optimization Results\n');
  for (const r of results) {
    console.log(`## ${r.name} — accuracy ${(r.accuracy * 100).toFixed(1)}% (${r.correct}/${r.total})`);
    console.log('```json');
    console.log(JSON.stringify(r.weights, null, 2));
    console.log('```\n');
  }
}

function evaluateWeightSet(
  set: WeightSet,
  snapshots: SnapshotDoc[],
  liquidations: LiquidationDoc[]
) {
  const weights = { ...DEFAULT_WEIGHTS, ...set.weights };
  let correct = 0;
  let total = 0;

  for (let i = 0; i < snapshots.length - 1; i++) {
    const current = snapshots[i];
    const future = snapshots[i + 1];
    if (!current.price || !future.price) continue;

    const inputs = buildSignalInputs(current, snapshots.slice(0, i + 1), liquidations);

    // Temporarily override weights by monkey-patching component weights after generation
    const signal = generateTradingSignal(inputs);
    let totalScore = 0;
    let totalWeight = 0;
    for (const comp of signal.components) {
      const w = weights[comp.name] ?? comp.weight;
      totalScore += comp.score * w;
      totalWeight += w;
    }
    const rawScore = totalWeight > 0 ? totalScore / totalWeight : 0;
    const predictedUp = rawScore > 0.15;
    const predictedDown = rawScore < -0.15;

    if (!predictedUp && !predictedDown) continue;

    const actualUp = future.price > current.price;
    if ((predictedUp && actualUp) || (predictedDown && !actualUp)) {
      correct++;
    }
    total++;
  }

  return {
    name: set.name,
    accuracy: total > 0 ? correct / total : 0,
    correct,
    total,
    weights,
  };
}

function buildSignalInputs(
  snapshot: SnapshotDoc,
  priorSnapshots: SnapshotDoc[],
  allLiquidations: LiquidationDoc[]
): SignalInputs {
  const windowCutoff = snapshot.timestamp - 15 * 60 * 1000;
  const recentLiqs = allLiquidations.filter((l) => l.orderTradeTime >= windowCutoff);
  const totalLongUsd = recentLiqs.filter((l) => l.side === 'SELL').reduce((s, l) => s + l.usdValue, 0);
  const totalShortUsd = recentLiqs.filter((l) => l.side === 'BUY').reduce((s, l) => s + l.usdValue, 0);

  const recentPrices = priorSnapshots.map((s) => s.price ?? 0).filter((p) => p > 0);
  const oiHistory = priorSnapshots
    .map((s) => Number(s.openInterest?.openInterest ?? 0))
    .filter((oi) => oi > 0);

  const lsrObj = snapshot.longShortRatio;
  const lsr = lsrObj && typeof lsrObj === 'object' ? Number(lsrObj.longShortRatio) : null;

  const frObj = snapshot.fundingRate;
  const fr = frObj && typeof frObj === 'object' ? Number(frObj.fundingRate) : null;

  let largest: LiquidationEvent | null = null;
  if (recentLiqs.length > 0) {
    const largestDoc = recentLiqs.reduce((max, l) => (l.usdValue > max.usdValue ? l : max), recentLiqs[0]);
    const btcPrice = snapshot.price && snapshot.price > 0 ? snapshot.price : 0;
    const quantity = btcPrice > 0 ? largestDoc.usdValue / btcPrice : 0;
    largest = {
      id: `${largestDoc.orderTradeTime}-${largestDoc.side}-${largestDoc.usdValue}`,
      exchange: 'Binance',
      symbol: 'BTCUSDT',
      side: largestDoc.side,
      originalQuantity: quantity,
      price: btcPrice,
      orderTradeTime: largestDoc.orderTradeTime,
      usdValue: largestDoc.usdValue,
    };
  }

  return {
    liquidationStats: {
      totalLongLiquidations: recentLiqs.filter((l) => l.side === 'SELL').length,
      totalShortLiquidations: recentLiqs.filter((l) => l.side === 'BUY').length,
      totalLongUsd,
      totalShortUsd,
      largestLiquidation: largest,
    },
    longShortRatio: lsr !== null && !isNaN(lsr) ? lsr : null,
    mempoolTxCount: null,
    fastestFee: null,
    whaleTransactions: [] as WhaleTransaction[],
    hashrateTrend: null,
    fundingRate: fr !== null && !isNaN(fr) ? fr : null,
    recentPrices,
    oiHistory,
    newsSentiment: null,
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
