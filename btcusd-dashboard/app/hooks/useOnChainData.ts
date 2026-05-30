'use client';

import { useState, useEffect, useRef } from 'react';
import type { MempoolStats, MempoolFees, BlockData, HashrateData } from '../lib/mempool';
import { classifyWhaleTransaction, type WhaleTransaction, type UnconfirmedTransactionsResponse } from '../lib/blockchain';

const ONCHAIN_POLL = 30000; // 30s

export function useOnChainData(btcPrice: number) {
  const [mempoolStats, setMempoolStats] = useState<MempoolStats | null>(null);
  const [mempoolFees, setMempoolFees] = useState<MempoolFees | null>(null);
  const [latestBlocks, setLatestBlocks] = useState<BlockData[]>([]);
  const [hashrateData, setHashrateData] = useState<HashrateData | null>(null);
  
  const [whaleTransactions, setWhaleTransactions] = useState<WhaleTransaction[]>([]);
  const seenWhaleHashes = useRef<Set<string>>(new Set());

  const [lastUpdate, setLastUpdate] = useState<number>(0);

  useEffect(() => {
    let active = true;

    const fetchOnChain = async () => {
      if (!active) return;
      try {
        const priceParam = btcPrice > 0 ? `?price=${btcPrice}` : '';
        const res = await fetch(`/api/onchain${priceParam}`);
        if (!res.ok) return;
        const data = await res.json();

        if (data.mempoolStats) setMempoolStats(data.mempoolStats);
        if (data.mempoolFees) setMempoolFees(data.mempoolFees);
        if (data.latestBlocks) setLatestBlocks(data.latestBlocks);
        if (data.hashrateData) setHashrateData(data.hashrateData);

        if (data.unconfirmedTxs && btcPrice > 0) {
          const txs = (data.unconfirmedTxs as UnconfirmedTransactionsResponse).txs;
          const newWhaleTxs: WhaleTransaction[] = [];

          for (const tx of txs) {
            if (seenWhaleHashes.current.has(tx.hash)) continue;
            seenWhaleHashes.current.add(tx.hash);

            const whaleTx = classifyWhaleTransaction(tx, btcPrice);
            if (whaleTx) {
              newWhaleTxs.push(whaleTx);
            }
          }

          if (seenWhaleHashes.current.size > 10000) {
            const arr = Array.from(seenWhaleHashes.current);
            seenWhaleHashes.current = new Set(arr.slice(arr.length - 5000));
          }

          if (newWhaleTxs.length > 0) {
            setWhaleTransactions(prev => {
              const combined = [...newWhaleTxs, ...prev];
              // Keep top 50 recent whale txs
              combined.sort((a, b) => b.time - a.time);
              return combined.slice(0, 50);
            });
          }
        }

        setLastUpdate(Date.now());
      } catch (err) {
        console.error('On-chain fetch error:', err);
      }
    };

    fetchOnChain();
    const interval = setInterval(fetchOnChain, ONCHAIN_POLL);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [btcPrice]); // re-run if price changes drastically to re-evaluate USD values, though not strictly necessary to reset interval

  return {
    mempoolStats,
    mempoolFees,
    latestBlocks,
    hashrateData,
    whaleTransactions,
    lastUpdate,
  };
}
