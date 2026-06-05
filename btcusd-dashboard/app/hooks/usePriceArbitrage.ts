'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { 
  shouldEnterTrade, 
  shouldExitTrade, 
  DEFAULT_ARB_CONFIG
} from '../lib/priceArbitrage';

export interface ArbPosition {
  side: 'BUY_DELTA' | 'SELL_DELTA';
  entryPrice: number;
  entrySpread: number;
  entryTime: number;
  size: number;
  orderId?: number;
}

export interface ArbLog {
  id: string;
  time: Date;
  action: string;
  spread: number;
  price: number;
  pnl?: number;
  fillStatus?: string;
}

// Key for persisting position state in localStorage
const POSITION_STORAGE_KEY = 'arbTrader_position';
const ENABLED_STORAGE_KEY = 'arbTrader_isEnabled';

function loadPosition(): ArbPosition | null {
  try {
    const raw = localStorage.getItem(POSITION_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.side && parsed.entryPrice) return parsed;
    }
  } catch { /* ignore */ }
  return null;
}

function savePosition(position: ArbPosition | null) {
  try {
    if (position) {
      localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(position));
    } else {
      localStorage.removeItem(POSITION_STORAGE_KEY);
    }
  } catch { /* ignore */ }
}

export function usePriceArbitrage() {
  const [isEnabled, setIsEnabled] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let savedEnabled: boolean | null = null;
    try {
      const rawEnabled = localStorage.getItem(ENABLED_STORAGE_KEY);
      if (rawEnabled !== null) {
        const parsed = JSON.parse(rawEnabled);
        if (typeof parsed === 'boolean') savedEnabled = parsed;
      }
    } catch (e) {
      console.error('Error reading localStorage', e);
    }

    queueMicrotask(() => {
      if (savedEnabled !== null) setIsEnabled(savedEnabled);
      setIsLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (isLoaded) {
      localStorage.setItem(ENABLED_STORAGE_KEY, JSON.stringify(isEnabled));
    }
  }, [isEnabled, isLoaded]);
  
  const [prices, setPrices] = useState<{
    binance: number|null; 
    bybit: number|null;
    delta: number|null; 
    deltaBid?: number|null;
    deltaAsk?: number|null;
    consensus: number|null;
  }>({
    binance: null, 
    bybit: null,
    delta: null, 
    consensus: null
  });
  const [latencies, setLatencies] = useState<{binance: number|null, bybit: number|null, delta: number|null}>({binance: null, bybit: null, delta: null});
  const [spreadPct, setSpreadPct] = useState<number>(0);
  
  // Position state — initialized to null for SSR, then loaded from localStorage on client mount
  const [position, setPosition] = useState<ArbPosition | null>(null);
  const [logs, setLogs] = useState<ArbLog[]>([]);

  useEffect(() => {
    setPosition(loadPosition());
  }, []);
  
  const isExecutingRef = useRef(false);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const reconcileCounterRef = useRef(0);

  // Persist position changes to localStorage
  useEffect(() => {
    if (isLoaded) {
      savePosition(position);
    }
  }, [position, isLoaded]);

  /**
   * Reconcile local position state with actual exchange position.
   * Runs every ~10 poll cycles to avoid hammering the API.
   */
  const reconcilePosition = useCallback(async () => {
    try {
      const res = await fetch('/api/position');
      if (!res.ok) return; // 502s are common, don't clear state on them

      const data = await res.json();
      
      if (data.success && data.position) {
        // Exchange has an open position
        const exchangePos = data.position;
        
        if (!position) {
          // We lost local state but exchange has a position — recover it
          console.warn('[ARB] Recovered position from exchange:', exchangePos);
          setPosition({
            side: exchangePos.side === 'LONG' ? 'BUY_DELTA' : 'SELL_DELTA',
            entryPrice: exchangePos.entryPrice || 0,
            entrySpread: 0, // unknown, but we need to manage the position
            entryTime: Date.now() - 30000, // assume it's been open for a bit
            size: exchangePos.size || DEFAULT_ARB_CONFIG.tradeSize,
          });
        }
      } else if (data.success && !data.position) {
        // Exchange has no position
        if (position) {
          console.warn('[ARB] Local state shows position but exchange has none. Clearing local state.');
          setPosition(null);
        }
      }
    } catch {
      // Silent — don't disrupt the main loop for reconciliation failures
    }
  }, [position]);

  const executeTrade = useCallback(async (action: string, limitPrice: number, reason: string, currentSpread: number, exitingPos?: ArbPosition) => {
    if (isExecutingRef.current) return;
    isExecutingRef.current = true;
    
    const size = DEFAULT_ARB_CONFIG.tradeSize;
    
    try {
      const res = await fetch('/api/arbitrage/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          size,
          limitPrice,
          reason,
          spreadPct: currentSpread
        })
      });
      
      const data = await res.json();
      
      const logEntry: ArbLog = {
        id: Math.random().toString(36).substr(2, 9),
        time: new Date(),
        action,
        spread: currentSpread,
        price: limitPrice,
        fillStatus: data.filled ? 'FILLED' : (data.cancelReason || 'FAILED'),
      };

      if (res.ok && data.success && data.filled) {
        // Order was placed AND filled — safe to update position state
        const actualFillPrice = data.fillPrice || limitPrice;

        if (action === 'BUY_DELTA' || action === 'SELL_DELTA') {
          setPosition({
            side: action as 'BUY_DELTA' | 'SELL_DELTA',
            entryPrice: actualFillPrice,
            entrySpread: currentSpread,
            entryTime: Date.now(),
            size,
            orderId: data.orderId,
          });
        } else if (exitingPos) {
           // Calculate PNL using actual fill price
           const diff = action === 'CLOSE_LONG' 
             ? actualFillPrice - exitingPos.entryPrice 
             : exitingPos.entryPrice - actualFillPrice;
           logEntry.pnl = diff * size;
           setPosition(null);
        }
      } else if (!data.filled && data.cancelReason === 'cancelled_timeout') {
        // Order was placed but NOT filled — cancelled automatically
        // Don't update position state — no trade happened
        console.log(`[ARB] Order not filled, cancelled. Reason: ${data.cancelReason}`);
      } else {
        // Handle other failures
        if (data?.error?.code === 'no_position_for_reduce_only') {
          console.warn('Delta returned no_position_for_reduce_only. Clearing local position state.');
          setPosition(null);
        }
      }

      setLogs(prev => [logEntry, ...prev].slice(0, 50));
    } catch (e) {
      console.error('Arb execution error', e);
    } finally {
      isExecutingRef.current = false;
    }
  }, []);

  // Poll prices and run trading logic
  useEffect(() => {
    const fetchPrices = async () => {
      try {
        const res = await fetch('/api/arbitrage/prices');
        if (!res.ok) return;
        const data = await res.json();
        
        setPrices({
          binance: data.prices.binance,
          bybit: data.prices.bybit,
          delta: data.prices.delta,
          deltaBid: data.prices.deltaBid,
          deltaAsk: data.prices.deltaAsk,
          consensus: data.prices.consensus
        });
        if (data.latencies) {
            setLatencies(data.latencies);
        }
        setSpreadPct(data.spreadPct);
        
        // --- Periodic Position Reconciliation ---
        reconcileCounterRef.current++;
        if (reconcileCounterRef.current >= 10) {
          reconcileCounterRef.current = 0;
          reconcilePosition();
        }

        // --- Trading Logic ---
        if (!isEnabled || isExecutingRef.current) return;
        if (!data.prices.consensus || !data.prices.delta) return;

        // 1. Check Exit conditions if we have a position
        if (position) {
          const exitCheck = shouldExitTrade(
            data.prices.consensus, 
            data.prices.delta, 
            position.side, 
            position.entryTime, 
            DEFAULT_ARB_CONFIG
          );

          if (exitCheck.shouldExit) {
            const exitAction = position.side === 'BUY_DELTA' ? 'CLOSE_LONG' : 'CLOSE_SHORT';
            const exitPrice = position.side === 'BUY_DELTA' ? data.prices.deltaBid : data.prices.deltaAsk;
            executeTrade(exitAction, exitPrice || data.prices.delta, exitCheck.reason, data.spreadPct, position);
          }
          return;
        }

        // 2. Check Entry conditions if flat
        const entryCheck = shouldEnterTrade(data.prices.consensus, data.prices.delta, DEFAULT_ARB_CONFIG);
        if (entryCheck.action !== 'NONE') {
          // If buying, we hit the Ask. If selling, we hit the Bid.
          const entryPrice = entryCheck.action === 'BUY_DELTA' ? data.prices.deltaAsk : data.prices.deltaBid;
          executeTrade(entryCheck.action, entryPrice || data.prices.delta, 'DEVIATION_DETECTED', entryCheck.spread);
        }

      } catch {
        // Silent catch for frequent polling
      }
    };

    if (isEnabled) {
        fetchPrices(); // immediate fetch
        pollIntervalRef.current = setInterval(fetchPrices, 2000); // 2s polling (reduced from 1s to lower API load)
    } else {
        // slower polling just for UI if disabled
        fetchPrices();
        pollIntervalRef.current = setInterval(fetchPrices, 3000); 
    }

    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [isEnabled, position, executeTrade, reconcilePosition]);

  return {
    isEnabled,
    setIsEnabled,
    prices,
    latencies,
    spreadPct,
    position,
    logs
  };
}
