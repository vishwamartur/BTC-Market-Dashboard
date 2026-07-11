import { getDb, isDatabaseConfigured } from './db';

const EXECUTION_STATE_ID = 'btc-autotrader';
const LOCK_TTL_MS = 90_000;

export interface ExecutionLease {
  requestId: string;
  acquiredAt: number;
}

export type LeaseResult =
  | { acquired: true; lease: ExecutionLease }
  | { acquired: false; reason: 'persistence_unavailable' | 'busy' | 'cooldown'; retryAfterMs?: number };

interface ExecutionStateDocument {
  _id: string;
  lastEntryAt?: number;
  lock?: { requestId: string; expiresAt: number };
  updatedAt: Date;
}

interface TradeRequestDocument {
  _id: string;
  action: string;
  status: 'PENDING' | 'COMPLETE';
  response?: Record<string, unknown>;
  statusCode?: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export type TradeRequestReservation =
  | { state: 'reserved' }
  | { state: 'replay'; response: Record<string, unknown>; statusCode: number }
  | { state: 'pending' }
  | { state: 'unavailable' };

const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Persist a request before its order reaches Delta. Replays return the exact
 * completed result, while in-flight duplicates cannot submit another order.
 */
export async function reserveTradeRequest(requestId: string, action: string): Promise<TradeRequestReservation> {
  if (!isDatabaseConfigured) return { state: 'unavailable' };
  const db = await getDb();
  const collection = db.collection<TradeRequestDocument>('trade_requests');
  const now = new Date();
  try {
    await collection.insertOne({
      _id: requestId,
      action,
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
    });
    return { state: 'reserved' };
  } catch (error: unknown) {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null;
    if (code !== 11000) throw error;
  }

  const existing = await collection.findOne({ _id: requestId });
  if (existing?.status === 'COMPLETE' && existing.response && existing.statusCode) {
    return { state: 'replay', response: existing.response, statusCode: existing.statusCode };
  }
  return { state: 'pending' };
}

export async function completeTradeRequest(
  requestId: string,
  response: Record<string, unknown>,
  statusCode: number,
): Promise<void> {
  if (!isDatabaseConfigured) return;
  const db = await getDb();
  await db.collection<TradeRequestDocument>('trade_requests').updateOne(
    { _id: requestId, status: 'PENDING' },
    { $set: { status: 'COMPLETE', response, statusCode, updatedAt: new Date() } },
  );
}

/**
 * Atomically reserve execution across browser tabs and server instances. A
 * duplicate-key conflict during upsert means another process won the lease.
 */
export async function acquireExecutionLease(
  requestId: string,
  isEntry: boolean,
  cooldownMs: number,
  now: number = Date.now(),
): Promise<LeaseResult> {
  if (!isDatabaseConfigured) return { acquired: false, reason: 'persistence_unavailable' };

  const db = await getDb();
  const collection = db.collection<ExecutionStateDocument>('trade_execution_state');
  const conditions: Record<string, unknown>[] = [
    { 'lock.expiresAt': { $exists: false } },
    { 'lock.expiresAt': { $lte: now } },
  ];
  const filter: Record<string, unknown> = {
    _id: EXECUTION_STATE_ID,
    $or: conditions,
  };

  if (isEntry) {
    filter.$and = [{
      $or: [
        { lastEntryAt: { $exists: false } },
        { lastEntryAt: { $lte: now - cooldownMs } },
      ],
    }];
  }

  try {
    const result = await collection.updateOne(
      filter,
      {
        $set: {
          lock: { requestId, expiresAt: now + LOCK_TTL_MS },
          updatedAt: new Date(now),
        },
      },
      { upsert: true },
    );
    if (result.matchedCount > 0 || result.upsertedCount > 0) {
      return { acquired: true, lease: { requestId, acquiredAt: now } };
    }
  } catch (error: unknown) {
    // Existing locked documents can make an upsert race throw duplicate key.
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null;
    if (code !== 11000) throw error;
  }

  const state = await collection.findOne({ _id: EXECUTION_STATE_ID });
  if (isEntry && state?.lastEntryAt && state.lastEntryAt > now - cooldownMs) {
    return { acquired: false, reason: 'cooldown', retryAfterMs: state.lastEntryAt + cooldownMs - now };
  }
  return {
    acquired: false,
    reason: 'busy',
    retryAfterMs: state?.lock?.expiresAt ? Math.max(0, state.lock.expiresAt - now) : undefined,
  };
}

/** Start the durable entry cooldown only after Delta accepts the entry order. */
export async function recordEntryAccepted(lease: ExecutionLease): Promise<void> {
  if (!isDatabaseConfigured) return;
  const db = await getDb();
  await db.collection<ExecutionStateDocument>('trade_execution_state').updateOne(
    { _id: EXECUTION_STATE_ID, 'lock.requestId': lease.requestId },
    { $set: { lastEntryAt: Date.now(), updatedAt: new Date() } },
  );
}

export async function releaseExecutionLease(lease: ExecutionLease): Promise<void> {
  if (!isDatabaseConfigured) return;
  const db = await getDb();
  await db.collection<ExecutionStateDocument>('trade_execution_state').updateOne(
    { _id: EXECUTION_STATE_ID, 'lock.requestId': lease.requestId },
    { $unset: { lock: '' }, $set: { updatedAt: new Date() } },
  );
}
