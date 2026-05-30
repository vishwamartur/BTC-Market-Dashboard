'use client';

import type { LongShortRatio, TopTraderRatio } from '../lib/exchanges';

interface LongShortGaugeProps {
  longShortRatio: LongShortRatio | null;
  topTraderRatio: TopTraderRatio | null;
}

export default function LongShortGauge({ longShortRatio, topTraderRatio }: LongShortGaugeProps) {
  const longPct = longShortRatio ? parseFloat(longShortRatio.longAccount) * 100 : 50;
  const shortPct = longShortRatio ? parseFloat(longShortRatio.shortAccount) * 100 : 50;
  const ratio = longShortRatio ? parseFloat(longShortRatio.longShortRatio).toFixed(2) : '—';

  const topLong = topTraderRatio ? (parseFloat(topTraderRatio.longAccount) * 100).toFixed(1) : '—';
  const topShort = topTraderRatio ? (parseFloat(topTraderRatio.shortAccount) * 100).toFixed(1) : '—';
  const topRatio = topTraderRatio ? parseFloat(topTraderRatio.longShortRatio).toFixed(2) : '—';

  return (
    <div className="card grid-one-third" id="long-short-gauge">
      <div className="card-header">
        <span className="card-title">📊 Long / Short Ratio</span>
        <span className="card-badge polling">⟳ 30s</span>
      </div>

      <div className="gauge-container">
        {/* Main gauge bar */}
        <div className="gauge-visual">
          <div className="gauge-bar-bg">
            <div
              className="gauge-bar-long"
              style={{ width: `${longPct}%` }}
            >
              <span className="gauge-bar-label">{longPct.toFixed(1)}%</span>
            </div>
            <div className="gauge-bar-short">
              <span className="gauge-bar-label">{shortPct.toFixed(1)}%</span>
            </div>
          </div>

          <div className="gauge-labels">
            <div className="gauge-label">
              <span className="gauge-label-title">
                <span className="dot long"></span>
                Longs
              </span>
              <span className="gauge-label-value long">{longPct.toFixed(1)}%</span>
            </div>
            <div className="gauge-label" style={{ textAlign: 'right' }}>
              <span className="gauge-label-title" style={{ justifyContent: 'flex-end' }}>
                Shorts
                <span className="dot short"></span>
              </span>
              <span className="gauge-label-value short">{shortPct.toFixed(1)}%</span>
            </div>
          </div>
        </div>

        {/* Ratio value */}
        <div className="gauge-ratio">
          <div className="gauge-ratio-label">L/S Ratio</div>
          <div className="gauge-ratio-value">{ratio}</div>
        </div>

        {/* Top Trader section */}
        <div className="top-trader-section">
          <div className="top-trader-title">Top Traders Position Ratio</div>
          <div className="gauge-visual">
            <div className="gauge-bar-bg" style={{ height: '28px' }}>
              <div
                className="gauge-bar-long"
                style={{ width: `${topLong === '—' ? 50 : parseFloat(topLong)}%` }}
              >
                <span className="gauge-bar-label" style={{ fontSize: '11px' }}>{topLong}%</span>
              </div>
              <div className="gauge-bar-short">
                <span className="gauge-bar-label" style={{ fontSize: '11px' }}>{topShort}%</span>
              </div>
            </div>
          </div>
          <div style={{
            textAlign: 'center',
            marginTop: '8px',
            fontSize: '12px',
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
          }}>
            Ratio: {topRatio}
          </div>
        </div>
      </div>
    </div>
  );
}
