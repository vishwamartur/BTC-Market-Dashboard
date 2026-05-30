'use client';

import { useState, useEffect, useRef } from 'react';

interface OiDataPoint {
  timestamp: number;
  price: number | null;
  openInterest: number | null;
  longShortRatio: number | null;
}

function formatUsdShort(val: number): string {
  if (val >= 1_000_000_000) return `$${(val / 1_000_000_000).toFixed(2)}B`;
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(0)}K`;
  return `$${val.toFixed(0)}`;
}

export default function OIDivergence() {
  const [data, setData] = useState<OiDataPoint[]>([]);
  const [hours, setHours] = useState(72);
  const [loading, setLoading] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/analytics/oi?hours=${hours}`);
        if (!res.ok) return;
        const resData = await res.json();
        setData(resData.data || []);
      } catch (err) {
        console.error('OI divergence fetch error:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [hours]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || data.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const validData = data.filter(d => d.price !== null && d.openInterest !== null);
    if (validData.length === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const pad = { top: 20, right: 60, bottom: 30, left: 60 };
    const chartW = width - pad.left - pad.right;
    const chartH = height - pad.top - pad.bottom;

    ctx.clearRect(0, 0, width, height);

    // Find min and max for scaling
    const prices = validData.map(d => d.price!);
    const ois = validData.map(d => d.openInterest!);
    
    let minPrice = Math.min(...prices);
    let maxPrice = Math.max(...prices);
    const pRange = maxPrice - minPrice || 1;
    minPrice -= pRange * 0.05;
    maxPrice += pRange * 0.05;

    let minOi = Math.min(...ois);
    let maxOi = Math.max(...ois);
    const oRange = maxOi - minOi || 1;
    minOi -= oRange * 0.05;
    maxOi += oRange * 0.05;

    // Grid and axes
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.font = '10px "JetBrains Mono", monospace';

    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (chartH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(width - pad.right, y);
      ctx.stroke();

      // Left axis (Price)
      ctx.fillStyle = 'var(--text-muted)';
      ctx.textAlign = 'right';
      const pVal = maxPrice - (maxPrice - minPrice) * (i / 4);
      ctx.fillText(formatUsdShort(pVal), pad.left - 8, y + 4);

      // Right axis (OI)
      ctx.fillStyle = 'var(--blue)';
      ctx.textAlign = 'left';
      const oVal = maxOi - (maxOi - minOi) * (i / 4);
      ctx.fillText(formatUsdShort(oVal), width - pad.right + 8, y + 4);
    }

    // Draw Price Line (White)
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.lineWidth = 2;
    for (let i = 0; i < validData.length; i++) {
      const d = validData[i];
      const x = pad.left + (chartW / Math.max(1, validData.length - 1)) * i;
      const y = pad.top + chartH - ((d.price! - minPrice) / (maxPrice - minPrice)) * chartH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw OI Line (Blue)
    ctx.beginPath();
    ctx.strokeStyle = 'var(--blue)';
    ctx.lineWidth = 2;
    for (let i = 0; i < validData.length; i++) {
      const d = validData[i];
      const x = pad.left + (chartW / Math.max(1, validData.length - 1)) * i;
      const y = pad.top + chartH - ((d.openInterest! - minOi) / (maxOi - minOi)) * chartH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Time labels at bottom
    ctx.fillStyle = 'var(--text-muted)';
    ctx.textAlign = 'center';
    const timeFormat = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' });
    
    if (validData.length > 0) {
      ctx.fillText(timeFormat.format(new Date(validData[0].timestamp)), pad.left, height - 10);
      ctx.fillText(timeFormat.format(new Date(validData[Math.floor(validData.length / 2)].timestamp)), pad.left + chartW / 2, height - 10);
      ctx.fillText(timeFormat.format(new Date(validData[validData.length - 1].timestamp)), pad.left + chartW, height - 10);
    }

  }, [data]);

  return (
    <div className="card" id="oi-divergence">
      <div className="card-header">
        <span className="card-title">📈 Open Interest vs Price</span>
        <div style={{ display: 'flex', gap: '8px' }}>
          {[24, 72, 168].map((h) => (
            <button
              key={h}
              onClick={() => setHours(h)}
              style={{
                padding: '4px 12px',
                borderRadius: '12px',
                border: `1px solid ${hours === h ? 'var(--blue)' : 'var(--border-color)'}`,
                background: hours === h ? 'var(--blue-dim)' : 'transparent',
                color: hours === h ? 'var(--blue)' : 'var(--text-muted)',
                fontSize: '11px',
                fontFamily: 'var(--font-mono)',
                cursor: 'pointer',
                fontWeight: 600,
                transition: 'var(--transition-fast)',
              }}
            >
              {h / 24}D
            </button>
          ))}
        </div>
      </div>

      {loading && data.length === 0 ? (
        <div className="chart-empty">
          <div style={{ fontSize: '32px', opacity: 0.5 }}>📊</div>
          <p>Loading OI divergence data...</p>
        </div>
      ) : data.length === 0 ? (
        <div className="chart-empty">
          <div style={{ fontSize: '32px', opacity: 0.5 }}>📊</div>
          <p>Not enough market snapshots yet...</p>
        </div>
      ) : (
        <>
          <div style={{ position: 'relative' }}>
            <canvas ref={canvasRef} style={{ width: '100%', height: '260px' }} />
          </div>
          <div className="chart-legend">
            <div className="chart-legend-item">
              <span className="chart-legend-dot" style={{ background: '#fff', color: '#fff' }} />
              BTC Price
            </div>
            <div className="chart-legend-item">
              <span className="chart-legend-dot" style={{ background: 'var(--blue)', color: 'var(--blue)' }} />
              Open Interest
            </div>
          </div>
        </>
      )}
    </div>
  );
}
