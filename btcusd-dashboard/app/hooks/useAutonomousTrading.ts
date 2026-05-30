'use client';

import { useState, useEffect, useCallback } from 'react';

export interface TradeLog {
  id: string;
  timestamp: Date;
  action: 'BUY' | 'SELL';
  signalScore: number;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  details?: string;
  isPaperTrade: boolean;
}

export function useAutonomousTrading() {
  const [isEnabled, setIsEnabledState] = useState(false);
  const [isPaperTrade, setIsPaperTradeState] = useState(true);
  const [tradeLogs, setTradeLogs] = useState<TradeLog[]>([]);

  // Fetch initial settings & trades
  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/bot-settings');
      if (res.ok) {
        const data = await res.json();
        setIsEnabledState(data.isEnabled);
        setIsPaperTradeState(data.isPaperTrade);
      }
    } catch (e) {
      console.error('Failed to fetch bot settings');
    }
  }, []);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch('/api/trades?limit=50');
      if (!res.ok) return;
      const data = await res.json();

      if (data.trades) {
        const historicalLogs: TradeLog[] = data.trades.map((t: any) => ({
          id: t.orderId || t._id || Math.random().toString(),
          timestamp: new Date(t.timestamp),
          action: t.action,
          signalScore: t.signalScore || 0,
          status: t.status,
          details: t.orderId ? `Order ID: ${t.orderId}` : (typeof t.error === 'object' && t.error !== null ? JSON.stringify(t.error) : (t.error as string)) || undefined,
          isPaperTrade: t.isPaperTrade,
        }));
        setTradeLogs(historicalLogs);
      }
    } catch (err) {
      console.error('Failed to fetch historical trades', err);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
    fetchLogs();

    // Poll for new trades every 10 seconds since they are now executed on the backend
    const interval = setInterval(fetchLogs, 10000);
    return () => clearInterval(interval);
  }, [fetchSettings, fetchLogs]);

  const setIsEnabled = async (enabled: boolean) => {
    setIsEnabledState(enabled);
    try {
      await fetch('/api/bot-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isEnabled: enabled, isPaperTrade }),
      });
    } catch (e) {
      console.error('Failed to save bot settings');
    }
  };

  const setIsPaperTrade = async (paper: boolean) => {
    setIsPaperTradeState(paper);
    try {
      await fetch('/api/bot-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isEnabled, isPaperTrade: paper }),
      });
    } catch (e) {
      console.error('Failed to save bot settings');
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
