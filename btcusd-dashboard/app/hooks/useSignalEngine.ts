'use client';

import { useMemo } from 'react';
import { generateTradingSignal, type SignalResult, type SignalInputs } from '../lib/signals';
import type { LiquidationStats } from './useLiquidationData';
import type { WhaleTransaction } from '../lib/blockchain';
import type { HashrateData } from '../lib/mempool';

interface UseSignalEngineProps {
  liquidationStats: LiquidationStats;
  longShortRatioStr: string | undefined;
  mempoolTxCount: number | null;
  fastestFee: number | null;
  whaleTransactions: WhaleTransaction[];
  hashrateData: HashrateData | null;
  // New v2 inputs
  fundingRate: number | null;
  recentPrices: number[];
  oiHistory: number[];
}

export function useSignalEngine({
  liquidationStats,
  longShortRatioStr,
  mempoolTxCount,
  fastestFee,
  whaleTransactions,
  hashrateData,
  fundingRate,
  recentPrices,
  oiHistory,
}: UseSignalEngineProps): SignalResult {
  return useMemo(() => {
    let hashrateTrend: 'UP' | 'DOWN' | 'FLAT' | null = null;
    
    if (hashrateData && hashrateData.hashrates.length >= 2) {
      const recent = hashrateData.hashrates[hashrateData.hashrates.length - 1].avgHashrate;
      const prev = hashrateData.hashrates[hashrateData.hashrates.length - 2].avgHashrate;
      if (recent > prev * 1.02) hashrateTrend = 'UP';
      else if (recent < prev * 0.98) hashrateTrend = 'DOWN';
      else hashrateTrend = 'FLAT';
    }

    const inputs: SignalInputs = {
      liquidationStats,
      longShortRatio: longShortRatioStr ? parseFloat(longShortRatioStr) : null,
      mempoolTxCount,
      fastestFee,
      whaleTransactions,
      hashrateTrend,
      fundingRate,
      recentPrices,
      oiHistory,
    };

    return generateTradingSignal(inputs);
  }, [
    liquidationStats,
    longShortRatioStr,
    mempoolTxCount,
    fastestFee,
    whaleTransactions,
    hashrateData,
    fundingRate,
    recentPrices,
    oiHistory,
  ]);
}
