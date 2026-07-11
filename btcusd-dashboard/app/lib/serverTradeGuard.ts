import { readSignalState } from './signalState';
import { refreshSignalDataQuality } from './signalQuality';
import { DEFAULT_RISK_CONFIG, getStopLoss, getTakeProfit, shouldTrade } from './riskManager';

const MIN_PRICE_BARS_FOR_PROTECTION = 15;
const MAX_SIGNAL_AGE_MS = 15_000;

export interface EntryProtection {
  stopLossPrice: string;
  takeProfitPrice: string;
}

export type ServerEntryDecision =
  | { allowed: true; size: number; currentPrice: number; protection: EntryProtection }
  | { allowed: false; error: string; status: number };

export function calculateAtrFromCloseBars(prices: number[]): number | null {
  if (prices.length < MIN_PRICE_BARS_FOR_PROTECTION) return null;
  const recent = prices.slice(-MIN_PRICE_BARS_FOR_PROTECTION);
  let totalMove = 0;
  for (let index = 1; index < recent.length; index++) {
    totalMove += Math.abs(recent[index] - recent[index - 1]);
  }
  const atr = totalMove / (recent.length - 1);
  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

/**
 * Re-evaluates a trade entirely from durable server state. The browser action
 * is treated as a request, never as proof that a trade is still valid.
 */
export async function validateServerEntry(action: 'BUY' | 'SELL', now: number = Date.now()): Promise<ServerEntryDecision> {
  const state = await readSignalState();
  if (!state || now - state.computedAt > MAX_SIGNAL_AGE_MS) {
    return { allowed: false, error: 'Signal state is missing or stale', status: 503 };
  }

  const signal = state.latestSignal;
  const quality = refreshSignalDataQuality(signal.dataQuality, now);
  if (!quality?.isReady) {
    return { allowed: false, error: 'Signal inputs are not fresh enough to trade', status: 503 };
  }
  if ((signal.confluenceCount ?? 0) < 3) {
    return { allowed: false, error: 'Signal confluence is below the server minimum', status: 409 };
  }

  const decision = shouldTrade(signal, DEFAULT_RISK_CONFIG, state.currentPrice);
  if (!decision.action || decision.action !== action || decision.size <= 0) {
    return { allowed: false, error: 'Current server signal does not authorize this entry', status: 409 };
  }

  const prices = state.priceHistory.map((point) => point.value);
  const atr = calculateAtrFromCloseBars(prices);
  if (atr === null) {
    return { allowed: false, error: 'Insufficient one-minute price bars for protective orders', status: 503 };
  }

  const side = action === 'BUY' ? 'buy' : 'sell';
  const stopLoss = getStopLoss(side, state.currentPrice, atr, DEFAULT_RISK_CONFIG);
  const takeProfit = getTakeProfit(side, state.currentPrice, atr, DEFAULT_RISK_CONFIG);
  if (!Number.isFinite(stopLoss) || !Number.isFinite(takeProfit) || stopLoss <= 0 || takeProfit <= 0) {
    return { allowed: false, error: 'Could not calculate protective prices', status: 503 };
  }

  return {
    allowed: true,
    size: decision.size,
    currentPrice: state.currentPrice,
    protection: {
      stopLossPrice: stopLoss.toFixed(2),
      takeProfitPrice: takeProfit.toFixed(2),
    },
  };
}
