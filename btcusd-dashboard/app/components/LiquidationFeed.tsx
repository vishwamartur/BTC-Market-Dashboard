'use client';

import { useRef, useEffect } from 'react';
import type { LiquidationEvent } from '../lib/exchanges';

interface LiquidationFeedProps {
  events: LiquidationEvent[];
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatUsd(value: number): string {
  if (value == null) return '---';
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function formatBtc(qty: number): string {
  if (qty == null) return '---';
  if (qty >= 1) return qty.toFixed(3);
  if (qty >= 0.01) return qty.toFixed(4);
  return qty.toFixed(5);
}

function getExchangeColor(exchange: string): string {
  switch(exchange) {
    case 'Binance': return 'var(--amber)'; // Binance Yellow
    case 'Bybit': return 'var(--amber)'; // Bybit's yellowish-orange. Let's use amber for now, maybe we can use custom inline color
    case 'OKX': return '#ffffff'; // OKX White
    default: return 'var(--text-primary)';
  }
}

export default function LiquidationFeed({ events }: LiquidationFeedProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  }, [events.length]);

  return (
    <div className="card grid-two-thirds" id="liquidation-feed">
      <div className="card-header">
        <span className="card-title">⚡ Live Liquidations</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span className="card-badge live">● LIVE</span>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {events.length} events
          </span>
        </div>
      </div>

      <div className="feed-container" ref={containerRef}>
        {events.length === 0 ? (
          <div className="empty-feed">
            <div className="empty-icon">📡</div>
            <p>Waiting for liquidation events<span className="waiting-dots"></span></p>
            <p style={{ fontSize: '12px', marginTop: '8px', color: 'var(--text-muted)' }}>
              Connected to Binance, Bybit, & OKX WebSockets
            </p>
          </div>
        ) : (
          <table className="feed-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Exchange</th>
                <th>Side</th>
                <th>Price</th>
                <th>Size (BTC)</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event, index) => {
                const isLong = event.side === 'SELL';
                const isLarge = event.usdValue > 100_000;
                return (
                  <tr
                    key={event.id}
                    className={`feed-row ${isLong ? 'long' : 'short'} ${index === 0 ? 'flash' : ''}`}
                  >
                    <td>{formatTime(event.orderTradeTime)}</td>
                    <td>
                      <span style={{
                        fontSize: '11px',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        background: 'rgba(255,255,255,0.1)',
                        color: event.exchange === 'Binance' ? '#FCD535' : event.exchange === 'Bybit' ? '#FFB11A' : '#FFFFFF',
                        fontWeight: 'bold',
                        letterSpacing: '0.5px',
                        textTransform: 'uppercase'
                      }}>
                        {event.exchange}
                      </span>
                    </td>
                    <td>
                      <span className={`side-badge ${isLong ? 'long' : 'short'}`}>
                        {isLong ? '🔴 LONG' : '🟢 SHORT'}
                      </span>
                    </td>
                    <td>${event.price?.toLocaleString('en-US', { minimumFractionDigits: 1 }) || '---'}</td>
                    <td>{formatBtc(event.originalQuantity)}</td>
                    <td>
                      <span className={`usd-value ${isLarge ? 'large' : ''}`}>
                        {formatUsd(event.usdValue)}
                        {isLarge && ' 🔥'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
