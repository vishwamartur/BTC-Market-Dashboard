'use client';

import { useState, useEffect, useRef } from 'react';

interface HeatmapCell {
  _id: { dayOfWeek: number; hour: number };
  totalUsd: number;
  count: number;
  longUsd: number;
  shortUsd: number;
}

interface DailyData {
  _id: { year: number; month: number; day: number };
  totalUsd: number;
  longUsd: number;
  shortUsd: number;
  count: number;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOUR_LABELS = Array.from({ length: 24 }, (_, i) =>
  i === 0 ? '12a' : i < 12 ? `${i}a` : i === 12 ? '12p' : `${i - 12}p`
);

function formatUsd(val: number): string {
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(0)}K`;
  return `$${val.toFixed(0)}`;
}

export default function LiquidationHeatmap() {
  const [heatmap, setHeatmap] = useState<HeatmapCell[]>([]);
  const [daily, setDaily] = useState<DailyData[]>([]);
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; content: string } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dailyCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/analytics/heatmap?days=${days}`);
        if (!res.ok) return;
        const data = await res.json();
        setHeatmap(data.heatmap || []);
        setDaily(data.daily || []);
      } catch (err) {
        console.error('Heatmap fetch error:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [days]);

  // Draw heatmap grid
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || heatmap.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const leftPad = 44;
    const topPad = 28;
    const cellW = (width - leftPad - 8) / 24;
    const cellH = (height - topPad - 8) / 7;

    ctx.clearRect(0, 0, width, height);

    // Find max for color scale
    const maxVal = Math.max(...heatmap.map(h => h.totalUsd), 1);

    // Build lookup
    const lookup = new Map<string, HeatmapCell>();
    for (const cell of heatmap) {
      lookup.set(`${cell._id.dayOfWeek}-${cell._id.hour}`, cell);
    }

    // Draw hour labels
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'center';
    for (let h = 0; h < 24; h++) {
      if (h % 3 === 0) {
        ctx.fillText(HOUR_LABELS[h], leftPad + h * cellW + cellW / 2, topPad - 10);
      }
    }

    // Draw day labels
    ctx.textAlign = 'right';
    for (let d = 0; d < 7; d++) {
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(DAY_LABELS[d], leftPad - 8, topPad + d * cellH + cellH / 2 + 4);
    }

    // Draw cells
    for (let d = 1; d <= 7; d++) {
      for (let h = 0; h < 24; h++) {
        const cell = lookup.get(`${d}-${h}`);
        const val = cell ? cell.totalUsd : 0;
        const intensity = val / maxVal;

        const x = leftPad + h * cellW;
        const y = topPad + (d - 1) * cellH;

        // Color: low = dark blue, high = bright red/amber
        if (intensity === 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.03)';
        } else if (intensity < 0.3) {
          const r = Math.round(0 + intensity * 300);
          const g = Math.round(100 + intensity * 200);
          const b = Math.round(180);
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${0.3 + intensity * 0.5})`;
        } else if (intensity < 0.7) {
          const r = Math.round(200 + intensity * 55);
          const g = Math.round(170 - intensity * 100);
          const b = Math.round(0);
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${0.5 + intensity * 0.3})`;
        } else {
          ctx.fillStyle = `rgba(255, ${Math.round(42 + (1 - intensity) * 100)}, ${Math.round(55 + (1 - intensity) * 50)}, ${0.7 + intensity * 0.3})`;
        }

        ctx.beginPath();
        ctx.roundRect(x + 1, y + 1, cellW - 2, cellH - 2, 3);
        ctx.fill();

        // Show count in intense cells
        if (cell && cell.count > 0 && cellW > 18 && cellH > 18) {
          ctx.fillStyle = intensity > 0.5 ? '#ffffff' : '#94a3b8';
          ctx.font = `${Math.min(10, cellW * 0.4)}px "JetBrains Mono", monospace`;
          ctx.textAlign = 'center';
          ctx.fillText(String(cell.count), x + cellW / 2, y + cellH / 2 + 4);
        }
      }
    }
  }, [heatmap]);

  // Draw daily bar chart
  useEffect(() => {
    const canvas = dailyCanvasRef.current;
    if (!canvas || daily.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const pad = { top: 20, right: 16, bottom: 40, left: 60 };
    const chartW = width - pad.left - pad.right;
    const chartH = height - pad.top - pad.bottom;

    ctx.clearRect(0, 0, width, height);

    const maxVal = Math.max(...daily.map(d => d.longUsd + d.shortUsd), 1);
    const barW = Math.max(8, (chartW / daily.length) - 4);

    // Y-axis gridlines
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (chartH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(width - pad.right, y);
      ctx.stroke();

      ctx.fillStyle = '#64748b';
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      const label = formatUsd(maxVal * (1 - i / 4));
      ctx.fillText(label, pad.left - 8, y + 4);
    }

    // Bars
    for (let i = 0; i < daily.length; i++) {
      const d = daily[i];
      const x = pad.left + (chartW / daily.length) * i + ((chartW / daily.length) - barW) / 2;

      // Long (red) stacked on short (green)
      const longH = (d.longUsd / maxVal) * chartH;
      const shortH = (d.shortUsd / maxVal) * chartH;

      // Short bar (bottom - green)
      ctx.fillStyle = 'rgba(0, 240, 152, 0.7)';
      ctx.beginPath();
      ctx.roundRect(x, pad.top + chartH - shortH, barW / 2 - 1, shortH, [0, 0, 3, 3]);
      ctx.fill();

      // Long bar (top - red)
      ctx.fillStyle = 'rgba(255, 42, 85, 0.7)';
      ctx.beginPath();
      ctx.roundRect(x + barW / 2 + 1, pad.top + chartH - longH, barW / 2 - 1, longH, [3, 3, 0, 0]);
      ctx.fill();

      // X-axis date label
      const dateStr = `${d._id.month}/${d._id.day}`;
      ctx.fillStyle = '#64748b';
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(dateStr, x + barW / 2, height - pad.bottom + 16);
    }
  }, [daily]);

  const handleHeatmapHover = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || heatmap.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const leftPad = 44;
    const topPad = 28;
    const cellW = (rect.width - leftPad - 8) / 24;
    const cellH = (rect.height - topPad - 8) / 7;

    const hour = Math.floor((x - leftPad) / cellW);
    const dayIdx = Math.floor((y - topPad) / cellH);

    if (hour < 0 || hour >= 24 || dayIdx < 0 || dayIdx >= 7) {
      setTooltip(null);
      return;
    }

    const dayOfWeek = dayIdx + 1;
    const cell = heatmap.find(h => h._id.dayOfWeek === dayOfWeek && h._id.hour === hour);

    if (cell) {
      setTooltip({
        x: e.clientX,
        y: e.clientY,
        content: `${DAY_LABELS[dayIdx]} ${HOUR_LABELS[hour]} — ${cell.count} liqs — ${formatUsd(cell.totalUsd)} (L: ${formatUsd(cell.longUsd)} / S: ${formatUsd(cell.shortUsd)})`,
      });
    } else {
      setTooltip({
        x: e.clientX,
        y: e.clientY,
        content: `${DAY_LABELS[dayIdx]} ${HOUR_LABELS[hour]} — No data`,
      });
    }
  };

  const totalLiqs = heatmap.reduce((sum, h) => sum + h.count, 0);
  const totalVol = heatmap.reduce((sum, h) => sum + h.totalUsd, 0);

  return (
    <div className="card" id="liquidation-heatmap">
      <div className="card-header">
        <span className="card-title">🔥 Liquidation Heatmap</span>
        <div style={{ display: 'flex', gap: '8px' }}>
          {[3, 7, 14, 30].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              style={{
                padding: '4px 12px',
                borderRadius: '12px',
                border: `1px solid ${days === d ? 'var(--amber)' : 'var(--border-color)'}`,
                background: days === d ? 'var(--amber-dim)' : 'transparent',
                color: days === d ? 'var(--amber)' : 'var(--text-muted)',
                fontSize: '11px',
                fontFamily: 'var(--font-mono)',
                cursor: 'pointer',
                fontWeight: 600,
                transition: 'var(--transition-fast)',
              }}
            >
              {d}D
            </button>
          ))}
        </div>
      </div>

      {/* Summary stats */}
      <div style={{ display: 'flex', gap: '16px', marginBottom: '20px' }}>
        <div style={{
          flex: 1, padding: '12px', background: 'rgba(0,0,0,0.3)', borderRadius: 'var(--radius-xs)',
          border: '1px solid rgba(255,255,255,0.05)', textAlign: 'center'
        }}>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>Total Events</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '20px', fontWeight: 700, color: 'var(--amber)' }}>{totalLiqs.toLocaleString()}</div>
        </div>
        <div style={{
          flex: 1, padding: '12px', background: 'rgba(0,0,0,0.3)', borderRadius: 'var(--radius-xs)',
          border: '1px solid rgba(255,255,255,0.05)', textAlign: 'center'
        }}>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>Total Volume</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '20px', fontWeight: 700, color: 'var(--blue)' }}>{formatUsd(totalVol)}</div>
        </div>
      </div>

      {loading && heatmap.length === 0 ? (
        <div className="chart-empty">
          <div style={{ fontSize: '32px', opacity: 0.5 }}>📊</div>
          <p>Loading heatmap data...</p>
        </div>
      ) : heatmap.length === 0 ? (
        <div className="chart-empty">
          <div style={{ fontSize: '32px', opacity: 0.5 }}>🔥</div>
          <p>No liquidation data yet — accumulating...</p>
        </div>
      ) : (
        <>
          <div style={{ position: 'relative' }}>
            <canvas
              ref={canvasRef}
              style={{ width: '100%', height: '220px', cursor: 'crosshair' }}
              onMouseMove={handleHeatmapHover}
              onMouseLeave={() => setTooltip(null)}
            />
            {tooltip && (
              <div style={{
                position: 'fixed',
                left: tooltip.x + 12,
                top: tooltip.y - 32,
                padding: '6px 12px',
                background: 'rgba(0,0,0,0.9)',
                border: '1px solid var(--border-color)',
                borderRadius: '8px',
                fontSize: '11px',
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-primary)',
                pointerEvents: 'none',
                zIndex: 100,
                whiteSpace: 'nowrap',
              }}>
                {tooltip.content}
              </div>
            )}
          </div>

          {/* Daily bar chart */}
          {daily.length > 0 && (
            <div style={{ marginTop: '20px' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '8px', fontWeight: 600 }}>
                Daily Breakdown
              </div>
              <canvas ref={dailyCanvasRef} style={{ width: '100%', height: '160px' }} />
              <div className="chart-legend">
                <div className="chart-legend-item">
                  <span className="chart-legend-dot long" />
                  Long Liqs
                </div>
                <div className="chart-legend-item">
                  <span className="chart-legend-dot short" />
                  Short Liqs
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
