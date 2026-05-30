'use client';

import { useState, useEffect, useRef } from 'react';
import type { SignalResult, SignalStrength } from '../lib/signals';

export interface TradeLog {
  id: string;
  timestamp: Date;
  action: 'BUY' | 'SELL';
  signalScore: number;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  details?: string;
  isPaperTrade: boolean;
}

interface UseAutonomousTradingProps {
  signal: SignalResult;
}

const COOLDOWN_MS = 60000 * 5; // 5 minutes cooldown between trades

export function useAutonomousTrading({ signal }: UseAutonomousTradingProps) {
  const [isEnabled, setIsEnabled] = useState(true);
  const [isPaperTrade, setIsPaperTrade] = useState(false);
  const [tradeLogs, setTradeLogs] = useState<TradeLog[]>([]);
  
  const lastTradeTimeRef = useRef<number>(0);
  const isExecutingRef = useRef<boolean>(false);

  // Seed historical trade logs from MongoDB on mount
  useEffect(() => {
    const seedTrades = async () => {
      try {
        const res = await fetch('/api/trades?limit=50');
        if (!res.ok) return;
        const data = await res.json();

        if (data.trades && data.trades.length > 0) {
          const historicalLogs: TradeLog[] = data.trades.map((t: Record<string, unknown>) => ({
            id: (t.orderId as string) || Math.random().toString(36).substr(2, 9),
            timestamp: new Date(t.timestamp as string),
            action: t.action as 'BUY' | 'SELL',
            signalScore: 0,
            status: (t.status as string) === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
            details: t.orderId ? `Order ID: ${t.orderId}` : (typeof t.error === 'object' && t.error !== null ? JSON.stringify(t.error) : (t.error as string)) || undefined,
            isPaperTrade: t.isPaperTrade as boolean,
          }));
          setTradeLogs(historicalLogs);
        }
      } catch (err) {
        console.error('Failed to seed historical trades:', err);
      }
    };

    seedTrades();
  }, []);

  useEffect(() => {
    // Check if trading is enabled and signal is strong enough
    if (!isEnabled || isExecutingRef.current) return;

    const now = Date.now();
    const timeSinceLastTrade = now - lastTradeTimeRef.current;
    
    // Enforce cooldown
    if (timeSinceLastTrade < COOLDOWN_MS) return;

    let action: 'BUY' | 'SELL' | null = null;

    if (signal.overallSignal === 'STRONG BUY') {
      action = 'BUY';
    } else if (signal.overallSignal === 'STRONG SELL') {
      action = 'SELL';
    }

    if (action) {
      executeTrade(action, signal.score);
    }
  }, [signal.overallSignal, isEnabled, isPaperTrade, signal.score]);

  const executeTrade = async (action: 'BUY' | 'SELL', signalScore: number) => {
    isExecutingRef.current = true;
    lastTradeTimeRef.current = Date.now();

    const logId = Math.random().toString(36).substr(2, 9);
    
    const newLog: TradeLog = {
      id: logId,
      timestamp: new Date(),
      action,
      signalScore,
      status: 'PENDING',
      isPaperTrade,
    };

    setTradeLogs((prev) => [newLog, ...prev].slice(0, 50)); // Keep last 50

    try {
      const res = await fetch('/api/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          isPaperTrade,
          size: 1 // Default safe size
        }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        setTradeLogs((prev) =>
          prev.map((log) =>
            log.id === logId
              ? { ...log, status: 'SUCCESS', details: `Order ID: ${data.result?.id}` }
              : log
          )
        );
      } else {
        throw new Error(data.error?.code || data.error || 'Unknown error');
      }
    } catch (err: any) {
      setTradeLogs((prev) =>
        prev.map((log) =>
          log.id === logId
            ? { ...log, status: 'FAILED', details: err.message }
            : log
        )
      );
    } finally {
      isExecutingRef.current = false;
    }
  };

  return {
    isEnabled,
    setIsEnabled,
    isPaperTrade,
    setIsPaperTrade,
    tradeLogs,
  };
}
