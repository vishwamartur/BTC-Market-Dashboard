'use client';

import type { OpenInterestData } from '../lib/exchanges';

interface OpenInterestProps {
  openInterest: OpenInterestData | null;
  price: number;
}

function formatNumber(num: number): string {
  if (num >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return num.toFixed(2);
}

function formatBtc(num: number): string {
  return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export default function OpenInterest({ openInterest, price }: OpenInterestProps) {
  const oiBtc = openInterest ? parseFloat(openInterest.openInterest) : 0;
  const oiUsd = oiBtc * (price > 0 ? price : 0);

  return (
    <div className="card" id="open-interest">
      <div className="card-header">
        <span className="card-title">📈 Open Interest</span>
        <span className="card-badge polling">⟳ 30s</span>
      </div>

      <div className="oi-container">
        <div className="oi-main">
          <div className="oi-label">Total Open Interest (USD)</div>
          <div className="oi-value">
            {oiUsd > 0 ? formatNumber(oiUsd) : (
              <span className="skeleton" style={{ display: 'inline-block', width: '160px', height: '32px' }} />
            )}
          </div>
        </div>

        <div className="oi-details">
          <div className="oi-detail-item">
            <div className="oi-detail-label">OI (BTC)</div>
            <div className="oi-detail-value">
              {oiBtc > 0 ? `₿ ${formatBtc(oiBtc)}` : '—'}
            </div>
          </div>
          <div className="oi-detail-item">
            <div className="oi-detail-label">BTC Price</div>
            <div className="oi-detail-value">
              {price > 0 ? `$${price.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—'}
            </div>
          </div>
        </div>

        {/* Decorative element */}
        <div style={{
          padding: '12px',
          background: 'var(--bg-secondary)',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border-color)',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          fontSize: '12px',
          color: 'var(--text-muted)',
        }}>
          <span style={{ fontSize: '16px' }}>💡</span>
          <span>Open Interest represents the total number of outstanding futures contracts that have not been settled.</span>
        </div>
      </div>
    </div>
  );
}
