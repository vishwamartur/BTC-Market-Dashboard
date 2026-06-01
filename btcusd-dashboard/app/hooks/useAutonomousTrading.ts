'use client';

import { useState, useEffect, useRef } from 'react';
import type { SignalResult, SignalStrength } from '../lib/signals';
import { shouldTrade, canTrade, DEFAULT_RISK_CONFIG, type RiskConfig } from '../lib/riskManager';

export interface TradeLog {
  id: string;
  timestamp: Date;
  action: 'BUY' | 'SELL';
  signalScore: number;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  details?: string;
  isPaperTrade: boolean;
  size?: number;
}

interface UseAutonomousTradingProps {
  signal: SignalResult;
}

export function useAutonomousTrading({ signal }: UseAutonomousTradingProps) {
  // SAFETY: default to disabled — user must explicitly enable
  const [isEnabled, setIsEnabled] = useState(false);
  const [isPaperTrade, setIsPaperTrade] = useState(false);
  const [tradeLogs, setTradeLogs] = useState<TradeLog[]>([]);
  const [dailyPnl, setDailyPnl] = useState(0);
  
  const lastTradeTimeRef = useRef<number>(0);
  const isExecutingRef = useRef<boolean>(false);
  const lastSignalRef = useRef<SignalStrength>('NEUTRAL');
  const consecutiveSignalCountRef = useRef<number>(0);

  const riskConfig: RiskConfig = DEFAULT_RISK_CONFIG;

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
    if (timeSinceLastTrade < riskConfig.cooldownMs) return;

    // Signal debounce: require same signal direction for 3 consecutive evaluations
    if (signal.overallSignal === lastSignalRef.current) {
      consecutiveSignalCountRef.current++;
    } else {
      consecutiveSignalCountRef.current = 1;
      lastSignalRef.current = signal.overallSignal;
    }

    // Need at least 3 consecutive same-direction signals before acting
    if (consecutiveSignalCountRef.current < 3) return;

    // Check daily loss circuit breaker
    if (!canTrade(dailyPnl, riskConfig)) {
      console.log('[AUTO-TRADER] Daily loss limit reached, trading halted');
      return;
    }

    // Use risk manager to determine if and how much to trade
    const decision = shouldTrade(signal, riskConfig);

    if (decision.action && decision.size > 0) {
      executeTrade(decision.action, signal.score, decision.size);
    }
  }, [signal.overallSignal, isEnabled, isPaperTrade, signal.score, signal.confidence, dailyPnl]);

  const executeTrade = async (action: 'BUY' | 'SELL', signalScore: number, size: number = 1) => {
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
      size,
    };

    setTradeLogs((prev) => [newLog, ...prev].slice(0, 50)); // Keep last 50

    try {
      const res = await fetch('/api/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          isPaperTrade,
          size,
        }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        setTradeLogs((prev) =>
          prev.map((log) =>
            log.id === logId
              ? { ...log, status: 'SUCCESS', details: `Order ID: ${data.result?.id} | Size: ${size}` }
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
    dailyPnl,
  };
}
