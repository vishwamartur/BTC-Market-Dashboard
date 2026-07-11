'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { SignalResult } from '../lib/signals';
import type { ActivePosition } from '../lib/positions';
import type { DailyRiskSnapshot } from '../lib/dailyRisk';

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
  currentPrice?: number;
}

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
  // This durable setting is consumed by the always-on trade worker, not this
  // browser tab. Closing the dashboard therefore cannot stop the strategy.
  const [isEnabled, setIsEnabledState] = useState(false);
  const [tradeLogs, setTradeLogs] = useState<TradeLog[]>([]);
  const [activePosition, setActivePosition] = useState<ActivePosition | null>(null);
  const [isPositionLoaded, setIsPositionLoaded] = useState(false);
  const [isClosingPosition, setIsClosingPosition] = useState(false);

  const [dailyRisk, setDailyRisk] = useState<DailyRiskSnapshot | null>(null);
  const dailyPnl = dailyRisk?.realizedPnlUsd ?? 0;
  const isExecutingRef = useRef<boolean>(false);

  const setIsEnabled = useCallback((enabled: boolean) => {
    setIsEnabledState(enabled);
    void fetch('/api/autotrader/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }).then(async (res) => {
      if (!res.ok) throw new Error('Could not update durable auto-trader setting');
      const config = await res.json() as { enabled: boolean };
      setIsEnabledState(config.enabled);
    }).catch((error) => {
      console.error('Failed to update auto-trader setting:', error);
      setIsEnabledState(false);
    });
  }, []);

  useEffect(() => {
    let active = true;
    void fetch('/api/autotrader/config', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error('Could not load durable auto-trader setting');
        return res.json() as Promise<{ enabled: boolean }>;
      })
      .then((config) => {
        if (active) setIsEnabledState(config.enabled);
      })
      .catch((error) => console.error('Failed to load auto-trader setting:', error));
    return () => { active = false; };
  }, []);

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

  const refreshDailyRisk = useCallback(async () => {
    try {
      const res = await fetch('/api/risk/daily', { cache: 'no-store' });
      const data = await res.json() as DailyRiskSnapshot;
      setDailyRisk(data);
    } catch {
      // A missing risk snapshot blocks entries below; exits remain available.
      setDailyRisk(null);
    }
  }, []);

  const closeActivePosition = useCallback(async (reason = 'Manual close') => {
    if (isExecutingRef.current) return;

    if (!activePosition) {
      await refreshPosition();
      return;
    }

    isExecutingRef.current = true;
    setIsClosingPosition(true);
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
          requestId: logId,
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
    const initial = setTimeout(() => {
      void refreshDailyRisk();
    }, 0);
    const interval = setInterval(() => {
      void refreshDailyRisk();
    }, 60_000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [refreshDailyRisk]);

  return {
    isEnabled,
    setIsEnabled,
    tradeLogs,
    dailyPnl,
    dailyRisk,
    activePosition,
    isPositionLoaded,
    isClosingPosition,
    closeActivePosition,
    refreshPosition,
  };
}
