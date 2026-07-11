import { getDb, isDatabaseConfigured } from './db';

const CONFIG_ID = 'btc-autotrader';

export interface AutoTraderConfig {
  enabled: boolean;
  lastSignalTimestamp: number;
  lastSignal: string;
  consecutiveSignalCount: number;
  workerHeartbeatAt: number;
  updatedAt: number;
}

interface AutoTraderConfigDocument extends AutoTraderConfig {
  _id: string;
}

const DEFAULT_CONFIG: AutoTraderConfig = {
  enabled: false,
  lastSignalTimestamp: 0,
  lastSignal: 'NEUTRAL',
  consecutiveSignalCount: 0,
  workerHeartbeatAt: 0,
  updatedAt: 0,
};

const INSERT_DEFAULTS = {
  enabled: false,
  lastSignalTimestamp: 0,
  lastSignal: 'NEUTRAL',
  consecutiveSignalCount: 0,
  workerHeartbeatAt: 0,
};

function fromDocument(document: AutoTraderConfigDocument | null): AutoTraderConfig {
  if (!document) return { ...DEFAULT_CONFIG };
  return {
    enabled: document.enabled === true,
    lastSignalTimestamp: Number(document.lastSignalTimestamp) || 0,
    lastSignal: typeof document.lastSignal === 'string' ? document.lastSignal : 'NEUTRAL',
    consecutiveSignalCount: Number(document.consecutiveSignalCount) || 0,
    workerHeartbeatAt: Number(document.workerHeartbeatAt) || 0,
    updatedAt: Number(document.updatedAt) || 0,
  };
}

export async function getAutoTraderConfig(): Promise<AutoTraderConfig | null> {
  if (!isDatabaseConfigured) return null;
  const db = await getDb();
  const doc = await db.collection<AutoTraderConfigDocument>('autotrader_config').findOne({ _id: CONFIG_ID });
  return fromDocument(doc);
}

export async function setAutoTraderEnabled(enabled: boolean): Promise<AutoTraderConfig | null> {
  if (!isDatabaseConfigured) return null;
  const now = Date.now();
  const db = await getDb();
  await db.collection<AutoTraderConfigDocument>('autotrader_config').updateOne(
    { _id: CONFIG_ID },
    {
      $set: { enabled, updatedAt: now },
      $setOnInsert: INSERT_DEFAULTS,
    },
    { upsert: true },
  );
  return getAutoTraderConfig();
}

/** Atomically count one worker evaluation per distinct signal timestamp. */
export async function recordSignalEvaluation(timestamp: number, signal: string): Promise<AutoTraderConfig | null> {
  if (!isDatabaseConfigured) return null;
  const db = await getDb();
  const collection = db.collection<AutoTraderConfigDocument>('autotrader_config');
  await collection.updateOne(
    { _id: CONFIG_ID },
    { $setOnInsert: { ...INSERT_DEFAULTS, updatedAt: Date.now() } },
    { upsert: true },
  );
  const existing = await collection.findOne({ _id: CONFIG_ID });
  const config = fromDocument(existing);
  if (timestamp <= config.lastSignalTimestamp) return config;

  const consecutiveSignalCount = signal === config.lastSignal
    ? config.consecutiveSignalCount + 1
    : 1;
  const now = Date.now();
  await collection.updateOne(
    { _id: CONFIG_ID, lastSignalTimestamp: config.lastSignalTimestamp },
    {
      $set: {
        lastSignalTimestamp: timestamp,
        lastSignal: signal,
        consecutiveSignalCount,
        workerHeartbeatAt: now,
        updatedAt: now,
      },
    },
    { upsert: false },
  );
  return getAutoTraderConfig();
}

export async function recordWorkerHeartbeat(): Promise<void> {
  if (!isDatabaseConfigured) return;
  const now = Date.now();
  const db = await getDb();
  await db.collection<AutoTraderConfigDocument>('autotrader_config').updateOne(
    { _id: CONFIG_ID },
    {
      $set: { workerHeartbeatAt: now, updatedAt: now },
      $setOnInsert: INSERT_DEFAULTS,
    },
    { upsert: true },
  );
}
