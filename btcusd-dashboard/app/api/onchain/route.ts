import { NextResponse } from 'next/server';
import { fetchMempoolStats, fetchMempoolFees, fetchLatestBlocks, fetchHashrate } from '../../lib/mempool';
import { fetchUnconfirmedTransactions, classifyWhaleTransaction } from '../../lib/blockchain';
import { getDb } from '../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Simple in-memory price cache for whale classification on the server
let lastKnownPrice = 0;

export async function GET(request: Request) {
  try {
    // Read optional price hint from query params (sent by client)
    const { searchParams } = new URL(request.url);
    const priceHint = parseFloat(searchParams.get('price') || '0');
    if (priceHint > 0) lastKnownPrice = priceHint;

    const [mempoolStats, mempoolFees, latestBlocks, hashrateData, unconfirmedTxs] = await Promise.allSettled([
      fetchMempoolStats(),
      fetchMempoolFees(),
      fetchLatestBlocks(),
      fetchHashrate(),
      fetchUnconfirmedTransactions(),
    ]);

    const extract = <T>(res: PromiseSettledResult<T>): T | null => {
      if (res.status === 'fulfilled') {
        return res.value;
      }
      return null;
    };

    const response = {
      mempoolStats: extract(mempoolStats),
      mempoolFees: extract(mempoolFees),
      latestBlocks: extract(latestBlocks),
      hashrateData: extract(hashrateData),
      unconfirmedTxs: extract(unconfirmedTxs),
      timestamp: Date.now(),
    };

    // Persist whale transactions to MongoDB in the background (fire-and-forget)
    if (response.unconfirmedTxs && lastKnownPrice > 0) {
      const txs = (response.unconfirmedTxs as { txs: any[] }).txs;
      if (txs && txs.length > 0) {
        // Classify and persist asynchronously
        (async () => {
          try {
            const db = await getDb();
            const collection = db.collection('whale_transactions');
            for (const tx of txs) {
              const whaleTx = classifyWhaleTransaction(tx, lastKnownPrice);
              if (whaleTx) {
                // Upsert to deduplicate by hash
                await collection.updateOne(
                  { hash: whaleTx.hash },
                  { $setOnInsert: { ...whaleTx, _insertedAt: new Date() } },
                  { upsert: true }
                ).catch(() => {}); // silently ignore duplicates
              }
            }
          } catch (err) {
            console.error('[MongoDB] Whale persistence error:', err);
          }
        })();
      }
    }

    return NextResponse.json(response);
  } catch (error) {
    console.error('On-chain data fetch error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch on-chain data' },
      { status: 500 }
    );
  }
}

