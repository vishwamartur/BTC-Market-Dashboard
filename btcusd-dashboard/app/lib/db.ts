import { MongoClient, Db } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI || '';
const DB_NAME = 'btcusd';

if (!MONGODB_URI) {
  console.warn('[MongoDB] No MONGODB_URI found in environment variables');
}

// Cache the client across hot reloads in dev
let cached: { client: MongoClient; db: Db } | null = null;

// eslint-disable-next-line @typescript-eslint/no-namespace
declare global {
  // eslint-disable-next-line no-var
  var _mongoClientPromise: Promise<MongoClient> | undefined;
}

async function connectToDatabase(): Promise<{ client: MongoClient; db: Db }> {
  if (cached) {
    return cached;
  }

  if (!global._mongoClientPromise) {
    const client = new MongoClient(MONGODB_URI, {
      maxPoolSize: 10,
      minPoolSize: 2,
      maxIdleTimeMS: 60000,
      connectTimeoutMS: 10000,
      serverSelectionTimeoutMS: 10000,
    });
    global._mongoClientPromise = client.connect();
  }

  const client = await global._mongoClientPromise;
  const db = client.db(DB_NAME);

  cached = { client, db };
  return cached;
}

/**
 * Get a reference to the `btcusd` database.
 * Lazily connects on first call; caches across hot reloads.
 */
export async function getDb(): Promise<Db> {
  const { db } = await connectToDatabase();
  return db;
}

/**
 * Fire-and-forget helper: inserts a document without awaiting or blocking.
 * Logs errors silently so the caller is never impacted.
 */
export function insertOneAsync(collectionName: string, doc: Record<string, unknown>): void {
  getDb()
    .then((db) => db.collection(collectionName).insertOne(doc))
    .catch((err) => console.error(`[MongoDB] insertOneAsync(${collectionName}) error:`, err));
}

/**
 * Fire-and-forget helper: inserts many documents.
 */
export function insertManyAsync(collectionName: string, docs: Record<string, unknown>[]): void {
  if (docs.length === 0) return;
  getDb()
    .then((db) => db.collection(collectionName).insertMany(docs, { ordered: false }))
    .catch((err) => console.error(`[MongoDB] insertManyAsync(${collectionName}) error:`, err));
}

// ---------------------------------------------------------------------------
// BatchWriter — buffers writes and flushes periodically
// ---------------------------------------------------------------------------

const BATCH_FLUSH_INTERVAL_MS = 5000;
const BATCH_MAX_SIZE = 100;

class BatchWriter {
  private buffers = new Map<string, Record<string, unknown>[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  private ensureStarted() {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => this.flushAll(), BATCH_FLUSH_INTERVAL_MS);
  }

  /** Queue a document for batched insertion. */
  queue(collectionName: string, doc: Record<string, unknown>): void {
    this.ensureStarted();

    let buffer = this.buffers.get(collectionName);
    if (!buffer) {
      buffer = [];
      this.buffers.set(collectionName, buffer);
    }

    buffer.push(doc);

    // Flush immediately if buffer is full
    if (buffer.length >= BATCH_MAX_SIZE) {
      this.flush(collectionName);
    }
  }

  /** Flush a specific collection's buffer. */
  private flush(collectionName: string): void {
    const buffer = this.buffers.get(collectionName);
    if (!buffer || buffer.length === 0) return;

    const batch = buffer.splice(0);
    insertManyAsync(collectionName, batch);
  }

  /** Flush all collection buffers. */
  private flushAll(): void {
    for (const collectionName of this.buffers.keys()) {
      this.flush(collectionName);
    }
  }

  destroy() {
    this.flushAll();
    if (this.timer) clearInterval(this.timer);
    this.started = false;
  }
}

// Global singleton
// eslint-disable-next-line @typescript-eslint/no-namespace
declare global {
  // eslint-disable-next-line no-var
  var _batchWriter: BatchWriter | undefined;
}

export function getBatchWriter(): BatchWriter {
  if (!global._batchWriter) {
    global._batchWriter = new BatchWriter();
  }
  return global._batchWriter;
}

/**
 * Ensure indexes exist for our collections.
 * Called once on startup / first connection.
 */
let indexesCreated = false;
export async function ensureIndexes(): Promise<void> {
  if (indexesCreated) return;
  try {
    const db = await getDb();

    await Promise.allSettled([
      db.collection('liquidations').createIndex({ orderTradeTime: -1 }),
      db.collection('liquidations').createIndex({ exchange: 1 }),
      db.collection('liquidations').createIndex(
        { _insertedAt: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60 } // 30-day TTL
      ),
      db.collection('trades').createIndex({ timestamp: -1 }),
      db.collection('market_snapshots').createIndex({ timestamp: -1 }),
      db.collection('market_snapshots').createIndex(
        { _insertedAt: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60 } // 30-day TTL
      ),
      db.collection('whale_transactions').createIndex({ hash: 1 }, { unique: true }),
      db.collection('whale_transactions').createIndex({ time: -1 }),
    ]);

    indexesCreated = true;
    console.log('[MongoDB] Indexes ensured (including TTL indexes)');
  } catch (err) {
    console.error('[MongoDB] Failed to create indexes:', err);
  }
}
