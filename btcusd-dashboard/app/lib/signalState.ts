import type { SignalResult } from './signals';
import { getDb, isDatabaseConfigured } from './db';

const SIGNAL_STATE_ID = 'latest';
const STATE_READ_CACHE_MS = 1000;

let cachedRead: { state: PersistedSignalState | null; expiresAt: number } | null = null;

export interface TimedNumber {
  value: number;
  timestamp: number;
}

export interface LiquidationBucket {
  bucketStart: number;
  totalLongLiquidations: number;
  totalShortLiquidations: number;
  totalLongUsd: number;
  totalShortUsd: number;
  largestUsdValue: number;
}

export interface PersistedSignalState {
  latestSignal: SignalResult;
  currentPrice: number;
  priceHistory: TimedNumber[];
  oiHistory: TimedNumber[];
  liquidationBuckets: LiquidationBucket[];
  lastPriceTimestamp: number;
  lastMarketSnapshotTimestamp: number;
  computedAt: number;
}

type SignalStateDocument = PersistedSignalState & {
  _id: string;
  updatedAt?: Date;
};

function isTimedNumber(value: unknown): value is TimedNumber {
  if (!value || typeof value !== 'object') return false;
  const point = value as Record<string, unknown>;
  return Number.isFinite(point.value) && Number.isFinite(point.timestamp);
}

function isLiquidationBucket(value: unknown): value is LiquidationBucket {
  if (!value || typeof value !== 'object') return false;
  const bucket = value as Record<string, unknown>;
  return [
    'bucketStart',
    'totalLongLiquidations',
    'totalShortLiquidations',
    'totalLongUsd',
    'totalShortUsd',
    'largestUsdValue',
  ].every((key) => Number.isFinite(bucket[key]));
}

function isPersistedSignalState(value: unknown): value is PersistedSignalState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  const signal = state.latestSignal as Record<string, unknown> | undefined;
  return Boolean(
    signal &&
      typeof signal.overallSignal === 'string' &&
      Number.isFinite(signal.timestamp) &&
      Number.isFinite(state.currentPrice) &&
      Number.isFinite(state.lastPriceTimestamp) &&
      Number.isFinite(state.lastMarketSnapshotTimestamp) &&
      Number.isFinite(state.computedAt) &&
      Array.isArray(state.priceHistory) &&
      state.priceHistory.every(isTimedNumber) &&
      Array.isArray(state.oiHistory) &&
      state.oiHistory.every(isTimedNumber) &&
      Array.isArray(state.liquidationBuckets) &&
      state.liquidationBuckets.every(isLiquidationBucket),
  );
}

/** Read the shared, durable engine state. Returns null when persistence is not configured. */
export async function readSignalState(): Promise<PersistedSignalState | null> {
  if (!isDatabaseConfigured) return null;
  if (cachedRead && cachedRead.expiresAt > Date.now()) return cachedRead.state;

  const db = await getDb();
  const doc = await db.collection<SignalStateDocument>('signal_state').findOne({ _id: SIGNAL_STATE_ID });
  const state = isPersistedSignalState(doc) ? doc : null;
  cachedRead = { state, expiresAt: Date.now() + STATE_READ_CACHE_MS };
  return state;
}

/** Atomically replace the current engine snapshot; no unbounded signal history is stored. */
export async function writeSignalState(state: PersistedSignalState): Promise<void> {
  if (!isDatabaseConfigured) return;

  const db = await getDb();
  await db.collection<SignalStateDocument>('signal_state').updateOne(
    { _id: SIGNAL_STATE_ID },
    { $set: { ...state, updatedAt: new Date() } },
    { upsert: true },
  );
  cachedRead = { state, expiresAt: Date.now() + STATE_READ_CACHE_MS };
}
