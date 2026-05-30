'use client';

import { useMemo } from 'react';

interface PriceTickerProps {
  price: number;
  prevPrice: number;
  ticker: {
    lastPrice: string;
    priceChangePercent: string;
    highPrice: string;
    lowPrice: string;
    volume: string;
    quoteVolume: string;
  } | null;
}

function formatNumber(num: number, decimals = 2): string {
  return num.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatVolume(num: number): string {
  if (num >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  return `$${formatNumber(num, 0)}`;
}

export default function PriceTicker({ price, prevPrice, ticker }: PriceTickerProps) {
  const displayPrice = price > 0 ? price : (ticker ? parseFloat(ticker.lastPrice) : 0);
  const priceDirection = useMemo(() => {
    if (price > prevPrice) return 'up';
    if (price < prevPrice) return 'down';
    return 'neutral';
  }, [price, prevPrice]);

  const changePercent = ticker ? parseFloat(ticker.priceChangePercent) : 0;
  const isPositive = changePercent >= 0;

  return (
    <div className="card grid-full" id="price-ticker">
      <div className="price-section">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '4px' }}>
            <span style={{ fontSize: '24px' }}>₿</span>
            <span style={{ fontFamily: 'var(--font-heading)', fontSize: '14px', color: 'var(--text-muted)', fontWeight: 500 }}>
              BTC / USDT Perpetual
            </span>
          </div>
          <div className="price-main">
            <span className={`price-value ${priceDirection}`}>
              {displayPrice > 0 ? `$${formatNumber(displayPrice)}` : (
                <span className="skeleton" style={{ display: 'inline-block', width: '200px', height: '42px' }} />
              )}
            </span>
            {ticker && (
              <span className={`price-change ${isPositive ? 'positive' : 'negative'}`}>
                {isPositive ? '▲' : '▼'} {Math.abs(changePercent).toFixed(2)}%
              </span>
            )}
          </div>
        </div>

        <div className="price-meta">
          <div className="price-meta-item">
            <div className="price-meta-label">24h High</div>
            <div className="price-meta-value" style={{ color: 'var(--green)' }}>
              {ticker ? `$${formatNumber(parseFloat(ticker.highPrice))}` : '—'}
            </div>
          </div>
          <div className="price-meta-item">
            <div className="price-meta-label">24h Low</div>
            <div className="price-meta-value" style={{ color: 'var(--red)' }}>
              {ticker ? `$${formatNumber(parseFloat(ticker.lowPrice))}` : '—'}
            </div>
          </div>
          <div className="price-meta-item">
            <div className="price-meta-label">24h Volume</div>
            <div className="price-meta-value">
              {ticker ? formatVolume(parseFloat(ticker.quoteVolume)) : '—'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
