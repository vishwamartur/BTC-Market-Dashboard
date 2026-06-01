'use client';

import { useRef, useEffect, useCallback } from 'react';
import type { ChartDataPoint } from '../hooks/useLiquidationData';

interface LiquidationChartProps {
  data: ChartDataPoint[];
}

export default function LiquidationChart({ data }: LiquidationChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const drawChart = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Handle high DPI displays
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const padding = { top: 20, right: 20, bottom: 40, left: 60 };
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;

    if (chartW <= 0 || chartH <= 0) return;

    // Clear
    ctx.clearRect(0, 0, width, height);

    if (data.length === 0) return;

    // Find max value
    const maxVal = Math.max(
      ...data.map((d) => Math.max(Number(d.longUsd) || 0, Number(d.shortUsd) || 0)),
      1
    );

    const barGroupWidth = chartW / data.length;
    const barWidth = Math.max(barGroupWidth * 0.3, 4);
    const gap = 3;

    // Draw grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padding.top + (chartH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();

      // Y-axis labels
      const val = maxVal - (maxVal / 4) * i;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      let label = '';
      if (val >= 1_000_000) label = `$${(val / 1_000_000).toFixed(1)}M`;
      else if (val >= 1_000) label = `$${(val / 1_000).toFixed(0)}K`;
      else label = `$${val.toFixed(0)}`;
      ctx.fillText(label, padding.left - 8, y);
    }

    // Draw bars
    data.forEach((point, i) => {
      const x = padding.left + barGroupWidth * i + barGroupWidth / 2;

      // Long (red) bar
      const lUsd = Number(point.longUsd) || 0;
      const longH = Math.max(0.1, (lUsd / maxVal) * chartH);
      const startYLong = padding.top + chartH - longH;
      const longGrad = ctx.createLinearGradient(0, isFinite(startYLong) ? startYLong : padding.top + chartH, 0, padding.top + chartH);
      longGrad.addColorStop(0, 'rgba(255, 59, 92, 0.9)');
      longGrad.addColorStop(1, 'rgba(255, 59, 92, 0.3)');
      ctx.fillStyle = longGrad;
      ctx.beginPath();
      ctx.roundRect(
        x - barWidth - gap / 2,
        padding.top + chartH - longH,
        barWidth,
        longH,
        [3, 3, 0, 0]
      );
      ctx.fill();

      // Short (green) bar
      const sUsd = Number(point.shortUsd) || 0;
      const shortH = Math.max(0.1, (sUsd / maxVal) * chartH);
      const startYShort = padding.top + chartH - shortH;
      const shortGrad = ctx.createLinearGradient(0, isFinite(startYShort) ? startYShort : padding.top + chartH, 0, padding.top + chartH);
      shortGrad.addColorStop(0, 'rgba(0, 230, 138, 0.9)');
      shortGrad.addColorStop(1, 'rgba(0, 230, 138, 0.3)');
      ctx.fillStyle = shortGrad;
      ctx.beginPath();
      ctx.roundRect(
        x + gap / 2,
        padding.top + chartH - shortH,
        barWidth,
        shortH,
        [3, 3, 0, 0]
      );
      ctx.fill();

      // X-axis labels
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      if (data.length <= 10 || i % 2 === 0) {
        ctx.fillText(point.time, x, padding.top + chartH + 10);
      }
    });
  }, [data]);

  useEffect(() => {
    drawChart();
    const handleResize = () => drawChart();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [drawChart]);

  return (
    <div className="card grid-full" id="liquidation-chart">
      <div className="card-header">
        <span className="card-title">📉 Liquidation History</span>
        <span className="card-badge live">● LIVE</span>
      </div>

      {data.length === 0 ? (
        <div className="chart-empty">
          <span style={{ fontSize: '32px', opacity: 0.4 }}>📊</span>
          <span>Chart will populate as liquidation events come in</span>
        </div>
      ) : (
        <>
          <div className="chart-container">
            <canvas
              ref={canvasRef}
              className="chart-canvas"
              style={{ width: '100%', height: '100%' }}
            />
          </div>
          <div className="chart-legend">
            <div className="chart-legend-item">
              <div className="chart-legend-dot long"></div>
              <span>Long Liquidations</span>
            </div>
            <div className="chart-legend-item">
              <div className="chart-legend-dot short"></div>
              <span>Short Liquidations</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
