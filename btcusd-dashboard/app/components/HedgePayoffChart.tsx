'use client';

import { useState, useEffect, useRef } from 'react';

interface PayoffPoint {
  price: number;
  pnl: number;
}

interface PnlHistoryPoint {
  timestamp: string;
  cumulativePnl: number;
  realizedPnl: number;
  label: string;
}

interface HedgePayoffData {
  success: boolean;
  error?: string;
  hasHedge: boolean;
  currentPrice: number;
  strike: number | null;
  breakevens: { lower: number; upper: number } | null;
  maxProfit: number | null;
  currentUnrealizedPnl: number;
  totalRealizedPnl: number;
  payoffCurve: PayoffPoint[];
  pnlHistory: PnlHistoryPoint[];
  metadata: {
    callSymbol: string | null;
    putSymbol: string | null;
    size: number | null;
    entryNotional: number | null;
    expiryTime: number | null;
  };
  timestamp: number;
}

function formatUsd(val: number): string {
  const abs = Math.abs(val);
  if (abs >= 1_000_000) return `$${(val / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(val / 1_000).toFixed(1)}K`;
  return `$${val.toFixed(0)}`;
}

function formatPrice(val: number): string {
  return `$${val.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export default function HedgePayoffChart() {
  const [data, setData] = useState<HedgePayoffData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const payoffCanvasRef = useRef<HTMLCanvasElement>(null);
  const historyCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch('/api/hedge/payoff');
        const json = await res.json();
        if (!res.ok || !json.success) {
          setError(json.error || 'Failed to fetch hedge payoff data');
          return;
        }
        setData(json);
        setError(null);
      } catch (err) {
        console.error('Hedge payoff fetch error:', err);
        const message = err instanceof Error ? err.message : 'An error occurred while fetching hedge payoff data.';
        setError(message);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const canvas = payoffCanvasRef.current;
    if (!canvas || !data || data.payoffCurve.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const pad = { top: 20, right: 24, bottom: 32, left: 64 };
    const chartW = width - pad.left - pad.right;
    const chartH = height - pad.top - pad.bottom;

    ctx.clearRect(0, 0, width, height);

    const prices = data.payoffCurve.map((p) => p.price);
    const pnls = data.payoffCurve.map((p) => p.pnl);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const minPnl = Math.min(0, ...pnls);
    const maxPnl = Math.max(10, ...pnls);
    const pnlRange = maxPnl - minPnl || 1;

    // Grid lines
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

      const val = maxPnl - pnlRange * (i / 4);
      ctx.fillText(formatUsd(val), pad.left - 8, y + 4);
    }

    // Zero line
    const zeroY = pad.top + chartH - ((0 - minPnl) / pnlRange) * chartH;
    if (zeroY >= pad.top && zeroY <= pad.top + chartH) {
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(pad.left, zeroY);
      ctx.lineTo(width - pad.right, zeroY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // X-axis labels (price)
    ctx.textAlign = 'center';
    for (let i = 0; i <= 4; i++) {
      const x = pad.left + (chartW / 4) * i;
      const price = minPrice + (maxPrice - minPrice) * (i / 4);
      ctx.fillText(formatPrice(price), x, pad.top + chartH + 18);
    }

    // Helpers to map price/pnl to canvas coordinates
    const priceToX = (price: number) => pad.left + ((price - minPrice) / (maxPrice - minPrice || 1)) * chartW;
    const pnlToY = (pnl: number) => pad.top + chartH - ((pnl - minPnl) / pnlRange) * chartH;

    // Payoff line — render in segments colored by per-segment sign
    for (let i = 1; i < data.payoffCurve.length; i++) {
      const prev = data.payoffCurve[i - 1];
      const curr = data.payoffCurve[i];
      const avgPnl = (prev.pnl + curr.pnl) / 2;

      ctx.beginPath();
      ctx.moveTo(priceToX(prev.price), pnlToY(prev.pnl));
      ctx.lineTo(priceToX(curr.price), pnlToY(curr.pnl));
      ctx.lineWidth = 2;
      ctx.strokeStyle = avgPnl >= 0 ? 'var(--green)' : 'var(--red)';
      ctx.stroke();
    }

    // Gradient fill under the entire curve
    ctx.beginPath();
    for (let i = 0; i < data.payoffCurve.length; i++) {
      const p = data.payoffCurve[i];
      const x = priceToX(p.price);
      const y = pnlToY(p.pnl);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineTo(pad.left + chartW, pad.top + chartH);
    ctx.lineTo(pad.left, pad.top + chartH);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + chartH);
    if (data.currentUnrealizedPnl >= 0) {
      gradient.addColorStop(0, 'rgba(0, 240, 152, 0.2)');
      gradient.addColorStop(1, 'rgba(0, 240, 152, 0)');
    } else {
      gradient.addColorStop(0, 'rgba(255, 42, 85, 0)');
      gradient.addColorStop(1, 'rgba(255, 42, 85, 0.2)');
    }
    ctx.fillStyle = gradient;
    ctx.fill();

    // Strike line
    if (data.strike !== null) {
      const x = pad.left + ((data.strike - minPrice) / (maxPrice - minPrice || 1)) * chartW;
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, pad.top + chartH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(`Strike ${formatPrice(data.strike)}`, x, pad.top - 6);
    }

    // Current price line
    if (data.currentPrice > 0) {
      const x = pad.left + ((data.currentPrice - minPrice) / (maxPrice - minPrice || 1)) * chartW;
      ctx.strokeStyle = 'var(--blue)';
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, pad.top + chartH);
      ctx.stroke();
      ctx.fillStyle = 'var(--blue)';
      ctx.textAlign = 'center';
      ctx.fillText(`Spot ${formatPrice(data.currentPrice)}`, x, pad.top - 6);
    }

    // Breakeven markers
    if (data.breakevens !== null) {
      ctx.strokeStyle = 'var(--amber)';
      ctx.setLineDash([4, 4]);
      ctx.fillStyle = 'var(--amber)';
      ctx.textAlign = 'center';

      const markers = [
        { price: data.breakevens.lower, label: 'BE Low' },
        { price: data.breakevens.upper, label: 'BE High' },
      ];

      for (const marker of markers) {
        const x = pad.left + ((marker.price - minPrice) / (maxPrice - minPrice || 1)) * chartW;
        ctx.beginPath();
        ctx.moveTo(x, pad.top);
        ctx.lineTo(x, pad.top + chartH);
        ctx.stroke();
        ctx.fillText(`${marker.label} ${formatPrice(marker.price)}`, x, pad.top - 6);
      }

      ctx.setLineDash([]);
    }
  }, [data]);

  useEffect(() => {
    const canvas = historyCanvasRef.current;
    if (!canvas || !data || data.pnlHistory.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const pad = { top: 16, right: 24, bottom: 28, left: 56 };
    const chartW = width - pad.left - pad.right;
    const chartH = height - pad.top - pad.bottom;

    ctx.clearRect(0, 0, width, height);

    const pnls = data.pnlHistory.map((p) => p.cumulativePnl);
    const minPnl = Math.min(0, ...pnls);
    const maxPnl = Math.max(10, ...pnls);
    const pnlRange = maxPnl - minPnl || 1;

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.fillStyle = '#64748b';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';

    for (let i = 0; i <= 3; i++) {
      const y = pad.top + (chartH / 3) * i;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(width - pad.right, y);
      ctx.stroke();

      const val = maxPnl - pnlRange * (i / 3);
      ctx.fillText(formatUsd(val), pad.left - 8, y + 4);
    }

    // Zero line
    const zeroY = pad.top + chartH - ((0 - minPnl) / pnlRange) * chartH;
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, zeroY);
    ctx.lineTo(width - pad.right, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Line
    ctx.beginPath();
    for (let i = 0; i < data.pnlHistory.length; i++) {
      const p = data.pnlHistory[i];
      const x = pad.left + (chartW / Math.max(1, data.pnlHistory.length - 1)) * i;
      const y = pad.top + chartH - ((p.cumulativePnl - minPnl) / pnlRange) * chartH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineWidth = 2;
    const finalPnl = data.pnlHistory[data.pnlHistory.length - 1]?.cumulativePnl || 0;
    ctx.strokeStyle = finalPnl >= 0 ? 'var(--green)' : 'var(--red)';
    ctx.stroke();

    // Gradient fill
    ctx.lineTo(pad.left + chartW, pad.top + chartH);
    ctx.lineTo(pad.left, pad.top + chartH);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + chartH);
    if (finalPnl >= 0) {
      gradient.addColorStop(0, 'rgba(0, 240, 152, 0.2)');
      gradient.addColorStop(1, 'rgba(0, 240, 152, 0)');
    } else {
      gradient.addColorStop(0, 'rgba(255, 42, 85, 0)');
      gradient.addColorStop(1, 'rgba(255, 42, 85, 0.2)');
    }
    ctx.fillStyle = gradient;
    ctx.fill();
  }, [data]);

  return (
    <div className="card" id="hedge-payoff-chart">
      <div className="card-header">
        <span className="card-title">🛡️ Hedge Payoff</span>
        {loading ? (
          <span className="card-badge polling">Updating...</span>
        ) : (
          <span className="card-badge live">Live</span>
        )}
      </div>

      {error && (
        <div
          style={{
            background: 'var(--red-dim)',
            color: 'var(--red)',
            padding: '16px',
            borderRadius: 'var(--radius-sm)',
            marginBottom: '24px',
            border: '1px solid var(--red)',
            fontSize: '14px',
          }}
        >
          {error}
        </div>
      )}

      {data && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
            gap: '16px',
            marginBottom: '20px',
          }}
        >
          <StatBox label="Max Profit" value={data.maxProfit} color="var(--green)" />
          <StatBox label="Lower Break" value={data.breakevens?.lower} color="var(--text-primary)" formatter={formatPrice} />
          <StatBox label="Upper Break" value={data.breakevens?.upper} color="var(--text-primary)" formatter={formatPrice} />
          <StatBox label="Unrealized P&L" value={data.currentUnrealizedPnl} color={data.currentUnrealizedPnl >= 0 ? 'var(--green)' : 'var(--red)'} />
          <StatBox label="Realized P&L" value={data.totalRealizedPnl} color={data.totalRealizedPnl >= 0 ? 'var(--green)' : 'var(--red)'} />
        </div>
      )}

      {loading && !data ? (
        <div className="chart-empty">
          <div style={{ fontSize: '32px', opacity: 0.5 }}>🛡️</div>
          <p>Loading hedge payoff data...</p>
        </div>
      ) : data && !data.hasHedge && data.pnlHistory.length === 0 ? (
        <div className="chart-empty">
          <div style={{ fontSize: '32px', opacity: 0.5 }}>🛡️</div>
          <p>No active hedge or historical option activity found.</p>
        </div>
      ) : (
        <>
          <div style={{ position: 'relative', marginBottom: '24px' }}>
            <canvas ref={payoffCanvasRef} style={{ width: '100%', height: '260px', display: 'block' }} />
          </div>

          {data && data.pnlHistory.length > 0 && (
            <div style={{ position: 'relative' }}>
              <div className="card-title" style={{ marginBottom: '12px', fontSize: '13px' }}>
                📈 Hedge P&L History
              </div>
              <canvas ref={historyCanvasRef} style={{ width: '100%', height: '160px', display: 'block' }} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatBox({
  label,
  value,
  color,
  formatter = formatUsd,
}: {
  label: string;
  value: number | null | undefined;
  color: string;
  formatter?: (n: number) => string;
}) {
  return (
    <div
      style={{
        padding: '12px',
        background: 'rgba(0,0,0,0.3)',
        borderRadius: 'var(--radius-xs)',
        border: '1px solid rgba(255,255,255,0.05)',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          fontSize: '11px',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '1px',
          marginBottom: '4px',
        }}
      >
        {label}
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '18px', fontWeight: 700, color }}>
        {value !== null && value !== undefined ? formatter(value) : '—'}
      </div>
    </div>
  );
}
