'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { SignalResult, SignalStrength } from '../lib/signals';
import { shouldTrade, canTrade, DEFAULT_RISK_CONFIG, type RiskConfig } from '../lib/riskManager';
import type { ActivePosition } from '../lib/positions';

export type TradeAction = 'BUY' | 'SELL' | 'CLOSE_LONG' | 'CLOSE_SHORT';

export interface TradeLog {
  id: string;
  timestamp: Date;
  action: TradeAction;
  signalScore: number;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  details?: string;
  size?: number;
}

interface UseAutonomousTradingProps {
  signal: SignalResult;
}

const RISK_CONFIG: RiskConfig = DEFAULT_RISK_CONFIG;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeTradeAction(action: unknown): TradeAction {
  if (action === 'SELL' || action === 'CLOSE_LONG' || action === 'CLOSE_SHORT') {
    return action;
  }
  return 'BUY';
}

export function useAutonomousTrading({ signal }: UseAutonomousTradingProps) {
  // SAFETY: default to disabled — user must explicitly enable
  const [isEnabled, setIsEnabled] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [tradeLogs, setTradeLogs] = useState<TradeLog[]>([]);
  const [activePosition, setActivePosition] = useState<ActivePosition | null>(null);
  const [isPositionLoaded, setIsPositionLoaded] = useState(false);
  const [isClosingPosition, setIsClosingPosition] = useState(false);

  useEffect(() => {
    let savedEnabled: boolean | null = null;
    try {
      const rawEnabled = localStorage.getItem('autoTrader_isEnabled');
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
      localStorage.setItem('autoTrader_isEnabled', JSON.stringify(isEnabled));
    }
  }, [isEnabled, isLoaded]);
  const [dailyPnl] = useState(0);
  
  const lastTradeTimeRef = useRef<number>(0);
  const isExecutingRef = useRef<boolean>(false);
  const lastSignalRef = useRef<SignalStrength>('NEUTRAL');
  const consecutiveSignalCountRef = useRef<number>(0);

  const refreshPosition = useCallback(async () => {
    try {
      const res = await fetch('/api/position');
      const data = await res.json();
      if (res.ok && data.success) {
        setActivePosition(data.position ?? null);
      }
    } catch (err) {
      console.error('Failed to refresh open position:', err);
    } finally {
      setIsPositionLoaded(true);
    }
  }, []);

  const executeTrade = useCallback(async (action: 'BUY' | 'SELL', signalScore: number, size: number = 1) => {
    isExecutingRef.current = true;
    lastTradeTimeRef.current = Date.now();

    const logId = Math.random().toString(36).substr(2, 9);
    
    const newLog: TradeLog = {
      id: logId,
      timestamp: new Date(),
      action,
      signalScore,
      status: 'PENDING',
      size,
    };

    setTradeLogs((prev) => [newLog, ...prev].slice(0, 50)); // Keep last 50

    try {
      const res = await fetch('/api/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
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
        void refreshPosition();
      } else {
        throw new Error(data.error?.code || data.error || 'Unknown error');
      }
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      setTradeLogs((prev) =>
        prev.map((log) =>
          log.id === logId
            ? { ...log, status: 'FAILED', details: message }
            : log
        )
      );
    } finally {
      isExecutingRef.current = false;
    }
  }, [refreshPosition]);

  const closeActivePosition = useCallback(async (reason = 'Manual close') => {
    if (isExecutingRef.current) return;

    if (!activePosition) {
      await refreshPosition();
      return;
    }

    isExecutingRef.current = true;
    setIsClosingPosition(true);
    lastTradeTimeRef.current = Date.now();

    const action: TradeAction = activePosition.side === 'LONG' ? 'CLOSE_LONG' : 'CLOSE_SHORT';
    const logId = Math.random().toString(36).substr(2, 9);

    const newLog: TradeLog = {
      id: logId,
      timestamp: new Date(),
      action,
      signalScore: signal.score,
      status: 'PENDING',
      size: activePosition.size,
      details: reason,
    };

    setTradeLogs((prev) => [newLog, ...prev].slice(0, 50));

    try {
      const res = await fetch('/api/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'CLOSE_POSITION',
          reason,
        }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        setTradeLogs((prev) =>
          prev.map((log) =>
            log.id === logId
              ? {
                  ...log,
                  status: 'SUCCESS',
                  details: data.closed
                    ? `Closed ${activePosition.side} | Order ID: ${data.result?.id}`
                    : data.message || 'No open position to close',
                }
              : log
          )
        );
        await refreshPosition();
      } else {
        throw new Error(data.error?.code || data.error || 'Unknown error');
      }
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      setTradeLogs((prev) =>
        prev.map((log) =>
          log.id === logId
            ? { ...log, status: 'FAILED', details: message }
            : log
        )
      );
    } finally {
      setIsClosingPosition(false);
      isExecutingRef.current = false;
    }
  }, [activePosition, refreshPosition, signal.score]);

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
            action: normalizeTradeAction(t.action),
            signalScore: 0,
            status: (t.status as string) === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
            details: t.orderId ? `Order ID: ${t.orderId}` : (typeof t.error === 'object' && t.error !== null ? JSON.stringify(t.error) : (t.error as string)) || undefined,
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
    queueMicrotask(() => {
      void refreshPosition();
    });
    const interval = setInterval(refreshPosition, 15000);
    return () => clearInterval(interval);
  }, [refreshPosition]);

  useEffect(() => {
    // Check if trading is enabled and signal is strong enough
    if (!isEnabled || !isPositionLoaded || isExecutingRef.current) return;

    // Signal debounce: require same signal direction for 3 consecutive evaluations
    if (signal.overallSignal === lastSignalRef.current) {
      consecutiveSignalCountRef.current++;
    } else {
      consecutiveSignalCountRef.current = 1;
      lastSignalRef.current = signal.overallSignal;
    }

    // Need at least 3 consecutive same-direction signals before acting
    if (consecutiveSignalCountRef.current < 3) return;

    // Use risk manager to determine if and how much to trade
    const decision = shouldTrade({
      overallSignal: signal.overallSignal,
      confidence: signal.confidence,
      score: signal.score,
    }, RISK_CONFIG);

    if (activePosition) {
      const shouldCloseLong = activePosition.side === 'LONG' && decision.action === 'SELL';
      const shouldCloseShort = activePosition.side === 'SHORT' && decision.action === 'BUY';

      if (shouldCloseLong || shouldCloseShort) {
        const reason = `Opposite ${signal.overallSignal} signal`;
        queueMicrotask(() => {
          void closeActivePosition(reason);
        });
      }
      return;
    }

    const now = Date.now();
    const timeSinceLastTrade = now - lastTradeTimeRef.current;

    // Enforce cooldown for entries only. Exits above are always allowed.
    if (timeSinceLastTrade < RISK_CONFIG.cooldownMs) return;

    // Check daily loss circuit breaker for new entries only.
    if (!canTrade(dailyPnl, RISK_CONFIG)) {
      console.log('[AUTO-TRADER] Daily loss limit reached, trading halted');
      return;
    }

    if (decision.action && decision.size > 0) {
      const { action, size } = decision;
      const score = signal.score;
      queueMicrotask(() => {
        void executeTrade(action, score, size);
      });
    }
  }, [
    signal.overallSignal,
    isEnabled,
    isPositionLoaded,
    activePosition,
    signal.score,
    signal.confidence,
    dailyPnl,
    executeTrade,
    closeActivePosition,
  ]);

  return {
    isEnabled,
    setIsEnabled,
    tradeLogs,
    dailyPnl,
    activePosition,
    isPositionLoaded,
    isClosingPosition,
    closeActivePosition,
    refreshPosition,
  };
}
