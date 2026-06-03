'use client';

import { useState, useEffect, useRef } from 'react';

interface TradePnlData {
  timestamp: string;
  cumulativePnl: number;
  realizedPnl: number;
  tradeNumber: number;
  rawFill?: any;
}

interface TradeStats {
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  cumulativePnl: number;
}

function formatUsd(val: number): string {
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(0)}K`;
  return `$${val.toFixed(0)}`;
}

export default function WalletPNLChart() {
  const [pnlSeries, setPnlSeries] = useState<TradePnlData[]>([]);
  const [stats, setStats] = useState<TradeStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/wallet/pnl?limit=200');
        const data = await res.json();
        
        if (!res.ok || !data.success) {
          setError(data.error || 'Failed to fetch PNL data');
          return;
        }
        
        setPnlSeries(data.pnlSeries || []);
        setStats(data.stats || null);
      } catch (err: any) {
        console.error('Wallet PNL fetch error:', err);
        setError(err.message || 'An error occurred while fetching PNL data.');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || pnlSeries.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const pad = { top: 20, right: 20, bottom: 30, left: 60 };
    const chartW = width - pad.left - pad.right;
    const chartH = height - pad.top - pad.bottom;

    ctx.clearRect(0, 0, width, height);

    // Find min and max PnL to scale the chart
    let minPnl = Math.min(0, ...pnlSeries.map(d => d.cumulativePnl));
    let maxPnl = Math.max(10, ...pnlSeries.map(d => d.cumulativePnl)); // Default max to 10 so it's not totally flat if everything is 0
    
    // Add some padding to max/min
    const range = maxPnl - minPnl;
    maxPnl += range * 0.1;
    minPnl -= range * 0.1;

    // Draw Y-axis grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748b';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';

    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (chartH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(width - pad.right, y);
      ctx.stroke();

      const val = maxPnl - (maxPnl - minPnl) * (i / 4);
      ctx.fillText(formatUsd(val), pad.left - 8, y + 4);
    }

    // Zero line
    const zeroY = pad.top + chartH - ((0 - minPnl) / (maxPnl - minPnl)) * chartH;
    if (zeroY >= pad.top && zeroY <= pad.top + chartH) {
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(pad.left, zeroY);
      ctx.lineTo(width - pad.right, zeroY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw PnL line
    ctx.beginPath();
    for (let i = 0; i < pnlSeries.length; i++) {
      const point = pnlSeries[i];
      const x = pad.left + (chartW / Math.max(1, pnlSeries.length - 1)) * i;
      const y = pad.top + chartH - ((point.cumulativePnl - minPnl) / (maxPnl - minPnl)) * chartH;

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    
    // Gradient fill under the line
    const currentPnl = pnlSeries[pnlSeries.length - 1]?.cumulativePnl || 0;
    const isPositive = currentPnl >= 0;
    
    ctx.lineWidth = 2;
    ctx.strokeStyle = isPositive ? 'var(--green)' : 'var(--red)';
    ctx.stroke();

    ctx.lineTo(pad.left + chartW, pad.top + chartH);
    ctx.lineTo(pad.left, pad.top + chartH);
    ctx.closePath();

    const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + chartH);
    if (isPositive) {
      gradient.addColorStop(0, 'rgba(0, 240, 152, 0.2)');
      gradient.addColorStop(1, 'rgba(0, 240, 152, 0)');
    } else {
      gradient.addColorStop(0, 'rgba(255, 42, 85, 0)');
      gradient.addColorStop(1, 'rgba(255, 42, 85, 0.2)');
    }
    ctx.fillStyle = gradient;
    ctx.fill();

  }, [pnlSeries]);

  return (
    <div className="card" id="wallet-pnl-chart">
      <div className="card-header">
        <span className="card-title">📈 Delta Realized P&L</span>
        {loading ? (
          <span className="card-badge polling">Updating...</span>
        ) : (
          <span className="card-badge live">Live</span>
        )}
      </div>

      {error ? (
        <div style={{ background: 'var(--red-dim)', color: 'var(--red)', padding: '16px', borderRadius: 'var(--radius-sm)', marginBottom: '24px', border: '1px solid var(--red)', fontSize: '14px' }}>
          {error}
        </div>
      ) : null}

      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px', marginBottom: '20px' }}>
          <div style={{ padding: '12px', background: 'rgba(0,0,0,0.3)', borderRadius: 'var(--radius-xs)', border: '1px solid rgba(255,255,255,0.05)', textAlign: 'center' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>Total PnL</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '20px', fontWeight: 700, color: stats.cumulativePnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
              {stats.cumulativePnl >= 0 ? '+' : ''}{formatUsd(stats.cumulativePnl)}
            </div>
          </div>
          <div style={{ padding: '12px', background: 'rgba(0,0,0,0.3)', borderRadius: 'var(--radius-xs)', border: '1px solid rgba(255,255,255,0.05)', textAlign: 'center' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>Win Rate</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '20px', fontWeight: 700, color: 'var(--blue)' }}>{stats.winRate}%</div>
          </div>
          <div style={{ padding: '12px', background: 'rgba(0,0,0,0.3)', borderRadius: 'var(--radius-xs)', border: '1px solid rgba(255,255,255,0.05)', textAlign: 'center' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>Profitable Trades</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '20px', fontWeight: 700, color: 'var(--green)' }}>{stats.winCount}</div>
          </div>
          <div style={{ padding: '12px', background: 'rgba(0,0,0,0.3)', borderRadius: 'var(--radius-xs)', border: '1px solid rgba(255,255,255,0.05)', textAlign: 'center' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>Losing Trades</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '20px', fontWeight: 700, color: 'var(--red)' }}>{stats.lossCount}</div>
          </div>
        </div>
      )}

      {loading && pnlSeries.length === 0 && !error ? (
        <div className="chart-empty">
          <div style={{ fontSize: '32px', opacity: 0.5 }}>📉</div>
          <p>Loading performance data...</p>
        </div>
      ) : pnlSeries.length <= 1 && !error ? (
        <div className="chart-empty">
          <div style={{ fontSize: '32px', opacity: 0.5 }}>📉</div>
          <p>No fill history found on Delta Exchange to plot P&L.</p>
        </div>
      ) : (
        <div style={{ position: 'relative', marginBottom: '32px' }}>
          <canvas ref={canvasRef} style={{ width: '100%', height: '240px', display: (pnlSeries.length > 1 && !error) ? 'block' : 'none' }} />
        </div>
      )}

      {pnlSeries.length > 1 && (
        <div style={{ marginTop: '24px', borderTop: '1px solid var(--border-color)', paddingTop: '20px' }}>
          <div className="card-title" style={{ marginBottom: '16px', fontSize: '13px' }}>📋 Recent Trade Logs</div>
          <div className="feed-container" style={{ maxHeight: '400px' }}>
            <table className="feed-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Symbol</th>
                  <th>Side</th>
                  <th>Size @ Price</th>
                  <th>Realized P&L</th>
                </tr>
              </thead>
              <tbody>
                {pnlSeries
                  .filter((p) => p.tradeNumber > 0)
                  .reverse()
                  .map((p, i) => (
                    <tr key={i} className="feed-row">
                      <td style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
                        {new Date(p.timestamp).toLocaleString()}
                      </td>
                      <td style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                        {p.rawFill?.symbol || p.rawFill?.contract_symbol || 'BTCUSDT'}
                      </td>
                      <td>
                        {p.rawFill?.side ? (
                          <span className={`side-badge ${p.rawFill.side.toLowerCase()}`}>
                            {p.rawFill.side.toUpperCase()}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>
                        {p.rawFill?.size ? `${p.rawFill.size}` : '—'} 
                        {p.rawFill?.price ? <span style={{color: 'var(--text-muted)'}}> @ ${p.rawFill.price}</span> : ''}
                      </td>
                      <td style={{ 
                        fontFamily: 'var(--font-mono)', 
                        fontWeight: 600,
                        fontSize: '15px',
                        color: p.realizedPnl > 0 ? 'var(--green)' : p.realizedPnl < 0 ? 'var(--red)' : 'var(--text-primary)'
                      }}>
                        {p.realizedPnl > 0 ? '+' : ''}{p.realizedPnl !== 0 ? formatUsd(p.realizedPnl) : '$0'}
                      </td>
                    </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
