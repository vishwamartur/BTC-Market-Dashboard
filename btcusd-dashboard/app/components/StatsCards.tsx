'use client';

import { useEffect, useRef } from 'react';
import type { LiquidationStats } from '../hooks/useLiquidationData';
import type { LiquidationEvent } from '../lib/exchanges';

interface StatsCardsProps {
  stats: LiquidationStats;
}

function formatUsd(value: number): string {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function AnimatedValue({ value, className }: { value: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const prevValue = useRef(value);

  useEffect(() => {
    if (prevValue.current !== value && ref.current) {
      ref.current.classList.remove('animate-count');
      void ref.current.offsetWidth; // trigger reflow
      ref.current.classList.add('animate-count');
      prevValue.current = value;
    }
  }, [value]);

  return (
    <div ref={ref} className={`stat-value ${className || ''}`}>
      {value}
    </div>
  );
}

function formatLargest(event: LiquidationEvent | null): string {
  if (!event) return '$0';
  return formatUsd(event.usdValue);
}

export default function StatsCards({ stats }: StatsCardsProps) {
  const totalUsd = stats.totalLongUsd + stats.totalShortUsd;
  const totalCount = stats.totalLongLiquidations + stats.totalShortLiquidations;

  return (
    <div className="stats-row grid-full" id="stats-cards">
      <div className="stat-card long-liq">
        <span className="stat-icon">🔴</span>
        <div className="stat-label">Long Liquidations</div>
        <AnimatedValue value={formatUsd(stats.totalLongUsd)} />
        <div className="stat-count">{stats.totalLongLiquidations} positions</div>
      </div>

      <div className="stat-card short-liq">
        <span className="stat-icon">🟢</span>
        <div className="stat-label">Short Liquidations</div>
        <AnimatedValue value={formatUsd(stats.totalShortUsd)} />
        <div className="stat-count">{stats.totalShortLiquidations} positions</div>
      </div>

      <div className="stat-card total-liq">
        <span className="stat-icon">💰</span>
        <div className="stat-label">Total Liquidated</div>
        <AnimatedValue value={formatUsd(totalUsd)} />
        <div className="stat-count">{totalCount} total events</div>
      </div>

      <div className="stat-card largest-liq">
        <span className="stat-icon">🔥</span>
        <div className="stat-label">Largest Single</div>
        <AnimatedValue value={formatLargest(stats.largestLiquidation)} />
        <div className="stat-count">
          {stats.largestLiquidation
            ? `${stats.largestLiquidation.side === 'SELL' ? 'Long' : 'Short'} @ $${stats.largestLiquidation.price.toLocaleString()}`
            : 'No events yet'}
        </div>
      </div>
    </div>
  );
}
