'use client';

import { useState, useEffect } from 'react';
import type { SignalResult } from '../lib/signals';

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
  signal?: SignalResult;
}

export function useAutonomousTrading({ signal }: UseAutonomousTradingProps = {}) {
  const [isEnabled, setIsEnabledLocal] = useState(false);
  const [isPaperTrade, setIsPaperTradeLocal] = useState(true);
  const [tradeLogs, setTradeLogs] = useState<TradeLog[]>([]);

  // Fetch initial settings
  useEffect(() => {
    fetch('/api/bot-settings')
      .then(res => res.json())
      .then(data => {
        if (data.isEnabled !== undefined) setIsEnabledLocal(data.isEnabled);
        if (data.isPaperTrade !== undefined) setIsPaperTradeLocal(data.isPaperTrade);
      })
      .catch(console.error);
  }, []);

  // Update settings in backend
  const updateSettings = async (updates: { isEnabled?: boolean; isPaperTrade?: boolean }) => {
    try {
      const current = { isEnabled, isPaperTrade, ...updates };
      await fetch('/api/bot-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(current)
      });
      if (updates.isEnabled !== undefined) setIsEnabledLocal(updates.isEnabled);
      if (updates.isPaperTrade !== undefined) setIsPaperTradeLocal(updates.isPaperTrade);
    } catch (err) {
      console.error('Failed to update settings:', err);
    }
  };

  const setIsEnabled = (val: boolean) => updateSettings({ isEnabled: val });
  const setIsPaperTrade = (val: boolean) => updateSettings({ isPaperTrade: val });

  // Poll trades
  useEffect(() => {
    const fetchTrades = async () => {
      try {
        const res = await fetch('/api/trades?limit=50');
        if (!res.ok) return;
        const data = await res.json();

        if (data.trades) {
          const historicalLogs: TradeLog[] = data.trades.map((t: any) => ({
            id: t.orderId || Math.random().toString(36).substr(2, 9),
            timestamp: new Date(t.timestamp),
            action: t.action,
            signalScore: t.signalScore || 0, // Score might not be saved in DB currently
            status: t.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
            details: t.orderId ? `Order ID: ${t.orderId}` : t.error,
            isPaperTrade: t.isPaperTrade,
          }));
          setTradeLogs(historicalLogs);
        }
      } catch (err) {
        // ignore
      }
    };

    fetchTrades();
    const interval = setInterval(fetchTrades, 15000); // Poll trades every 15s
    return () => clearInterval(interval);
  }, []);

  return {
    isEnabled,
    setIsEnabled,
    isPaperTrade,
    setIsPaperTrade,
    tradeLogs,
  };
}
