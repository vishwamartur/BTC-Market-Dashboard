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
}

export interface ArbLog {
  id: string;
  time: Date;
  action: string;
  spread: number;
  price: number;
  pnl?: number;
}

export function usePriceArbitrage() {
  const [isEnabled, setIsEnabled] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let savedEnabled: boolean | null = null;
    try {
      const rawEnabled = localStorage.getItem('arbTrader_isEnabled');
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
      localStorage.setItem('arbTrader_isEnabled', JSON.stringify(isEnabled));
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
  
  const [position, setPosition] = useState<ArbPosition | null>(null);
  const [logs, setLogs] = useState<ArbLog[]>([]);
  
  const isExecutingRef = useRef(false);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const executeTrade = useCallback(async (action: string, limitPrice: number, reason: string, currentSpread: number, exitingPos?: ArbPosition) => {
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
      
      if (res.ok && data.success) {
        // Success
        const logEntry: ArbLog = {
          id: Math.random().toString(36).substr(2, 9),
          time: new Date(),
          action,
          spread: currentSpread,
          price: limitPrice
        };

        if (action === 'BUY_DELTA' || action === 'SELL_DELTA') {
          setPosition({
            side: action as 'BUY_DELTA' | 'SELL_DELTA',
            entryPrice: limitPrice,
            entrySpread: currentSpread,
            entryTime: Date.now(),
            size
          });
        } else if (exitingPos) {
           // Calculate PNL
           const diff = action === 'CLOSE_LONG' 
             ? limitPrice - exitingPos.entryPrice 
             : exitingPos.entryPrice - limitPrice;
           logEntry.pnl = diff * size;
           setPosition(null);
        }

        setLogs(prev => [logEntry, ...prev].slice(0, 50));
      }
    } catch (e) {
      console.error('Arb execution error', e);
    } finally {
      isExecutingRef.current = false;
    }
  }, []);

  // Poll prices rapidly
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
            const exitPrice = position.side === 'BUY_DELTA' ? data.prices.deltaBid : data.prices.deltaAsk; // hit the bid to close long, hit ask to close short
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
        pollIntervalRef.current = setInterval(fetchPrices, 1000); // 1s polling for arb
    } else {
        // slower polling just for UI if disabled
        fetchPrices();
        pollIntervalRef.current = setInterval(fetchPrices, 3000); 
    }

    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [isEnabled, position, executeTrade]);

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
