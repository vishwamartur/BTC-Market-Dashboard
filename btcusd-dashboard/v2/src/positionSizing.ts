/**
 * Balance-aware position sizing.
 *
 * Extracted from index.ts to keep sizing logic isolated and testable.
 * All position sizing should go through these functions.
 */

import { getDeltaWalletBalances } from './delta.js';
import type { DeltaWalletBalance } from './types.js';
import type { Config } from './config/index.js';

// ---------------------------------------------------------------------------
// Configuration (consolidated from inline constants in old index.ts)
// ---------------------------------------------------------------------------

export const BALANCE_RISK_CONFIG = {
  /** Risk 5% of available balance per futures trade */
  futuresRiskPct: 0.05,
  /** Use 15% of available balance for options hedge */
  hedgeRiskPct: 0.15,
  /** 1 contract = 0.001 BTC on Delta Exchange */
  contractSizeBtc: 0.001,
  /** Minimum contracts for a futures trade */
  minFuturesContracts: 10,
  /** Maximum contracts for a futures trade */
  maxFuturesContracts: 100,
  /** Minimum contracts for an options hedge */
  minHedgeContracts: 30,
  /** Maximum contracts for an options hedge */
  maxHedgeContracts: 500,
};

// ---------------------------------------------------------------------------
// Balance fetching
// ---------------------------------------------------------------------------

/**
 * Fetch the available USD/USDT balance from Delta Exchange.
 * Returns 0 if the request fails or no USD wallet is found.
 */
export async function fetchAvailableBalance(config: Config): Promise<number> {
  const res = await getDeltaWalletBalances(config.DELTA_API_KEY, config.DELTA_API_SECRET);
  if (!res.success || !Array.isArray(res.result)) return 0;
  const balances = res.result as DeltaWalletBalance[];
  const usdWallet = balances.find(
    b => (b.asset_symbol === 'USD' || b.asset_symbol === 'USDT') && Number(b.available_balance) > 0,
  );
  return usdWallet ? Number(usdWallet.available_balance) : 0;
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

/**
 * Calculate position size in contracts based on available balance and confidence.
 *
 * @param availableBalance - USD available in wallet
 * @param currentPrice     - Current BTC price
 * @param riskPct          - Fraction of balance to risk (e.g. 0.05 = 5%)
 * @param minContracts     - Floor on contract count
 * @param maxContracts     - Ceiling on contract count
 * @param confidence       - Signal confidence (0-100), scales the position
 */
export function calculateBalanceBasedSize(
  availableBalance: number,
  currentPrice: number,
  riskPct: number,
  minContracts: number,
  maxContracts: number,
  confidence: number = 60,
): number {
  if (availableBalance <= 0 || currentPrice <= 0) return minContracts;

  // How much USD to risk on this trade
  const riskUsd = availableBalance * riskPct;

  // Scale by confidence (higher confidence → closer to full risk allocation)
  const confidenceScale = Math.max(0.5, confidence / 100);
  const adjustedRiskUsd = riskUsd * confidenceScale;

  // Convert USD to contracts: riskUsd / (contractSize × price)
  const contractValueUsd = BALANCE_RISK_CONFIG.contractSizeBtc * currentPrice;
  const contracts = Math.round(adjustedRiskUsd / contractValueUsd);

  return Math.max(minContracts, Math.min(contracts, maxContracts));
}
