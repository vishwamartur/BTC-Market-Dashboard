'use client';

import { useState, useEffect, useRef } from 'react';

interface WhaleDailyData {
  date: string;
  inflowBtc: number;
  inflowUsd: number;
  inflowCount: number;
  outflowBtc: number;
  outflowUsd: number;
  outflowCount: number;
  netFlowBtc: number;
}

export default function WhaleFlows() {
  const [dailyFlows, setDailyFlows] = useState<WhaleDailyData[]>([]);
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/analytics/whales?days=${days}`);
        if (!res.ok) return;
        const resData = await res.json();
        setDailyFlows(resData.daily || []);
      } catch (err) {
        console.error('Whale flows fetch error:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [days]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || dailyFlows.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const pad = { top: 20, right: 20, bottom: 30, left: 50 };
    const chartW = width - pad.left - pad.right;
    const chartH = height - pad.top - pad.bottom;

    ctx.clearRect(0, 0, width, height);

    // Find min and max for scaling Net Flow and Inflow/Outflow
    const maxFlow = Math.max(
      ...dailyFlows.map(d => Math.max(d.inflowBtc, d.outflowBtc, Math.abs(d.netFlowBtc)))
    );
    const limit = maxFlow * 1.2 || 100; // Leave some headroom

    const zeroY = pad.top + chartH / 2;

    // Draw Y-axis grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748b';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';

    for (let i = -2; i <= 2; i++) {
      const y = zeroY - (chartH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(width - pad.right, y);
      ctx.stroke();

      const val = (limit / 2) * i;
      ctx.fillText(`${val > 0 ? '+' : ''}${Math.round(val)} ₿`, pad.left - 8, y + 4);
    }

    // Zero line highlight
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.beginPath();
    ctx.moveTo(pad.left, zeroY);
    ctx.lineTo(width - pad.right, zeroY);
    ctx.stroke();

    const barW = Math.max(4, (chartW / dailyFlows.length) * 0.4);

    // Draw bars
    for (let i = 0; i < dailyFlows.length; i++) {
      const d = dailyFlows[i];
      const x = pad.left + (chartW / dailyFlows.length) * i + ((chartW / dailyFlows.length) - barW * 2.5) / 2;

      // Inflow (Positive - Green)
      const inH = (d.inflowBtc / limit) * (chartH / 2);
      ctx.fillStyle = 'rgba(0, 240, 152, 0.6)';
      ctx.beginPath();
      ctx.roundRect(x, zeroY - inH, barW, inH, [3, 3, 0, 0]);
      ctx.fill();

      // Outflow (Negative - Red)
      const outH = (d.outflowBtc / limit) * (chartH / 2);
      ctx.fillStyle = 'rgba(255, 42, 85, 0.6)';
      ctx.beginPath();
      ctx.roundRect(x + barW + 2, zeroY, barW, outH, [0, 0, 3, 3]);
      ctx.fill();

      // Date labels
      ctx.fillStyle = 'var(--text-muted)';
      ctx.textAlign = 'center';
      const [_, m, day] = d.date.split('-');
      ctx.fillText(`${m}/${day}`, x + barW, height - 10);
    }

    // Draw Net Flow Line (Blue)
    ctx.beginPath();
    ctx.strokeStyle = 'var(--blue)';
    ctx.lineWidth = 2;
    for (let i = 0; i < dailyFlows.length; i++) {
      const d = dailyFlows[i];
      const x = pad.left + (chartW / dailyFlows.length) * i + (chartW / dailyFlows.length) / 2;
      const y = zeroY - (d.netFlowBtc / limit) * (chartH / 2);
      
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw points on the net flow line
    for (let i = 0; i < dailyFlows.length; i++) {
      const d = dailyFlows[i];
      const x = pad.left + (chartW / dailyFlows.length) * i + (chartW / dailyFlows.length) / 2;
      const y = zeroY - (d.netFlowBtc / limit) * (chartH / 2);
      
      ctx.fillStyle = 'var(--bg-primary)';
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

  }, [dailyFlows]);

  return (
    <div className="card" id="whale-flows">
      <div className="card-header">
        <span className="card-title">🐋 Whale Flows</span>
        <div style={{ display: 'flex', gap: '8px' }}>
          {[7, 14, 30].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              style={{
                padding: '4px 12px',
                borderRadius: '12px',
                border: `1px solid ${days === d ? 'var(--purple)' : 'var(--border-color)'}`,
                background: days === d ? 'var(--purple-dim)' : 'transparent',
                color: days === d ? 'var(--purple)' : 'var(--text-muted)',
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

      {loading && dailyFlows.length === 0 ? (
        <div className="chart-empty">
          <div style={{ fontSize: '32px', opacity: 0.5 }}>🐋</div>
          <p>Loading whale flows...</p>
        </div>
      ) : dailyFlows.length === 0 ? (
        <div className="chart-empty">
          <div style={{ fontSize: '32px', opacity: 0.5 }}>🐋</div>
          <p>No whale data collected yet...</p>
        </div>
      ) : (
        <>
          <div style={{ position: 'relative' }}>
            <canvas ref={canvasRef} style={{ width: '100%', height: '240px' }} />
          </div>
          <div className="chart-legend">
            <div className="chart-legend-item">
              <span className="chart-legend-dot short" />
              Inflow to Exchanges
            </div>
            <div className="chart-legend-item">
              <span className="chart-legend-dot long" />
              Outflow from Exchanges
            </div>
            <div className="chart-legend-item">
              <span className="chart-legend-dot" style={{ background: 'var(--blue)', color: 'var(--blue)' }} />
              Net Flow (Outflow - Inflow)
            </div>
          </div>
        </>
      )}
    </div>
  );
}
