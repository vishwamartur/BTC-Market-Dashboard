'use client';

import { useState, useEffect, useRef } from 'react';

interface CostSummary {
  totalFills: number;
  totalFees: number;
  totalGst: number;
  totalCosts: number;
  totalMakerFees: number;
  totalTakerFees: number;
  makerCount: number;
  takerCount: number;
  totalRealizedPnl: number;
  netPnlAfterGst: number;
  grossWinRate: string;
  netWinRate: string;
  grossWins: number;
  grossLosses: number;
  netWins: number;
  netLosses: number;
  feeKilledTrades: number;
  feeToGrossRatio: string;
  avgFeePerTrade: number;
  avgCostPerTrade: number;
}

interface DailyCost {
  date: string;
  fees: number;
  gst: number;
  pnl: number;
  netPnl: number;
  trades: number;
}

interface TradeBreakdownEntry {
  timestamp: string;
  side: string;
  size: number;
  price: number;
  fee: number;
  gst: number;
  totalCost: number;
  realizedPnl: number;
  netPnl: number;
  role: string;
  isFeeKilled: boolean;
}

function formatUsd(val: number): string {
  const sign = val >= 0 ? '+' : '';
  return `${sign}$${Math.abs(val).toFixed(2)}`;
}

export default function CostAnalysis() {
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [dailyCosts, setDailyCosts] = useState<DailyCost[]>([]);
  const [trades, setTrades] = useState<TradeBreakdownEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/analytics/costs?limit=200');
        const data = await res.json();

        if (!res.ok || !data.success) {
          setError(data.error || 'Failed to fetch cost data');
          return;
        }

        setSummary(data.summary || null);
        setDailyCosts(data.dailyCosts || []);
        setTrades(data.tradeBreakdown || []);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'An error occurred');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 120000); // Refresh every 2 min
    return () => clearInterval(interval);
  }, []);

  // Draw gross vs net P&L bar chart
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || trades.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const pad = { top: 20, right: 20, bottom: 30, left: 55 };
    const chartW = w - pad.left - pad.right;
    const chartH = h - pad.top - pad.bottom;

    ctx.clearRect(0, 0, w, h);

    // Compute gross and net P&L per trade
    const tradeData = trades.map(t => ({
      gross: t.realizedPnl + t.fee, // add back fee for gross
      net: t.netPnl,
      isFeeKilled: t.isFeeKilled,
    }));

    const allValues = tradeData.flatMap(t => [t.gross, t.net]);
    let minVal = Math.min(0, ...allValues);
    let maxVal = Math.max(0.1, ...allValues);
    const range = maxVal - minVal;
    maxVal += range * 0.1;
    minVal -= range * 0.1;

    // Zero line
    const zeroY = pad.top + chartH - ((0 - minVal) / (maxVal - minVal)) * chartH;

    // Y-axis grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748b';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';

    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (chartH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
      const val = maxVal - (maxVal - minVal) * (i / 4);
      ctx.fillText(`$${val.toFixed(2)}`, pad.left - 6, y + 4);
    }

    // Zero line (dashed)
    if (zeroY >= pad.top && zeroY <= pad.top + chartH) {
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(pad.left, zeroY);
      ctx.lineTo(w - pad.right, zeroY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw bars
    const barGroupWidth = chartW / tradeData.length;
    const barWidth = Math.max(2, barGroupWidth * 0.35);
    const barGap = 2;

    for (let i = 0; i < tradeData.length; i++) {
      const td = tradeData[i];
      const groupX = pad.left + barGroupWidth * i;

      // Gross P&L bar (left)
      const grossHeight = Math.abs((td.gross / (maxVal - minVal)) * chartH);
      const grossY = td.gross >= 0 ? zeroY - grossHeight : zeroY;
      ctx.fillStyle = td.isFeeKilled
        ? 'rgba(240, 180, 0, 0.7)' // amber for fee-killed
        : td.gross >= 0
          ? 'rgba(0, 240, 152, 0.5)'
          : 'rgba(255, 42, 85, 0.5)';
      ctx.fillRect(groupX, grossY, barWidth, grossHeight);

      // Net P&L bar (right)
      const netHeight = Math.abs((td.net / (maxVal - minVal)) * chartH);
      const netY = td.net >= 0 ? zeroY - netHeight : zeroY;
      ctx.fillStyle = td.net >= 0
        ? 'rgba(0, 240, 152, 0.9)'
        : 'rgba(255, 42, 85, 0.9)';
      ctx.fillRect(groupX + barWidth + barGap, netY, barWidth, netHeight);
    }

    // Legend
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';

    // Gross legend
    ctx.fillStyle = 'rgba(0, 240, 152, 0.5)';
    ctx.fillRect(pad.left, pad.top - 14, 8, 8);
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('Gross P&L', pad.left + 12, pad.top - 6);

    // Net legend
    ctx.fillStyle = 'rgba(0, 240, 152, 0.9)';
    ctx.fillRect(pad.left + 80, pad.top - 14, 8, 8);
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('Net P&L', pad.left + 92, pad.top - 6);

    // Fee-killed legend
    ctx.fillStyle = 'rgba(240, 180, 0, 0.7)';
    ctx.fillRect(pad.left + 148, pad.top - 14, 8, 8);
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('Fee-Killed', pad.left + 160, pad.top - 6);
  }, [trades]);

  if (loading && !summary) {
    return (
      <div className="card" id="cost-analysis">
        <div className="card-header">
          <span className="card-title">💸 Cost Analysis</span>
          <span className="card-badge polling">Loading...</span>
        </div>
        <div className="chart-empty">
          <div style={{ fontSize: '32px', opacity: 0.5 }}>💸</div>
          <p>Loading cost data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="card" id="cost-analysis">
      <div className="card-header">
        <span className="card-title">💸 Fee & Cost Analysis</span>
        {loading ? (
          <span className="card-badge polling">Updating...</span>
        ) : error ? (
          <span className="card-badge" style={{ background: 'rgba(255,42,85,0.15)', color: 'var(--red)' }}>Error</span>
        ) : (
          <span className="card-badge live">Live</span>
        )}
      </div>

      {error && (
        <div style={{
          background: 'var(--red-dim)',
          color: 'var(--red)',
          padding: '12px',
          borderRadius: 'var(--radius-sm)',
          marginBottom: '16px',
          border: '1px solid var(--red)',
          fontSize: '13px',
        }}>
          {error}
        </div>
      )}

      {summary && (
        <>
          {/* Summary Stats Grid */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: '12px',
            marginBottom: '20px',
          }}>
            <StatBox
              label="Total Fees Paid"
              value={`$${summary.totalFees.toFixed(2)}`}
              color="var(--red)"
              sublabel={`${summary.totalFills} fills`}
            />
            <StatBox
              label="Total GST Paid"
              value={`$${summary.totalGst.toFixed(2)}`}
              color="var(--amber)"
              sublabel="15.25% on fees"
            />
            <StatBox
              label="Total Costs"
              value={`$${summary.totalCosts.toFixed(2)}`}
              color="var(--red)"
              sublabel="Fees + GST"
              highlight
            />
            <StatBox
              label="Fee-Killed Trades"
              value={summary.feeKilledTrades.toString()}
              color="var(--amber)"
              sublabel="Profit → Loss by fees"
              highlight={summary.feeKilledTrades > 0}
            />
          </div>

          {/* Win Rate Comparison */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: '12px',
            marginBottom: '20px',
          }}>
            <div style={{
              padding: '14px',
              background: 'rgba(0,0,0,0.3)',
              borderRadius: 'var(--radius-xs)',
              border: '1px solid rgba(255,255,255,0.05)',
              textAlign: 'center',
            }}>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '6px' }}>
                Gross Win Rate
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '24px', fontWeight: 700, color: 'var(--green)' }}>
                {summary.grossWinRate}%
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                {summary.grossWins}W / {summary.grossLosses}L
              </div>
            </div>
            <div style={{
              padding: '14px',
              background: 'rgba(0,0,0,0.3)',
              borderRadius: 'var(--radius-xs)',
              border: '1px solid rgba(255,255,255,0.05)',
              textAlign: 'center',
            }}>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '6px' }}>
                Net Win Rate (After Fees)
              </div>
              <div style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '24px',
                fontWeight: 700,
                color: parseFloat(summary.netWinRate) >= parseFloat(summary.grossWinRate) ? 'var(--green)' : 'var(--red)',
              }}>
                {summary.netWinRate}%
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                {summary.netWins}W / {summary.netLosses}L
              </div>
            </div>
            <div style={{
              padding: '14px',
              background: 'rgba(0,0,0,0.3)',
              borderRadius: 'var(--radius-xs)',
              border: '1px solid rgba(255,255,255,0.05)',
              textAlign: 'center',
            }}>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '6px' }}>
                Net P&L After GST
              </div>
              <div style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '24px',
                fontWeight: 700,
                color: summary.netPnlAfterGst >= 0 ? 'var(--green)' : 'var(--red)',
              }}>
                {formatUsd(summary.netPnlAfterGst)}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                Fee:PnL ratio: {summary.feeToGrossRatio}%
              </div>
            </div>
          </div>

          {/* Maker vs Taker breakdown */}
          <div style={{
            padding: '12px 14px',
            background: 'rgba(0, 191, 255, 0.05)',
            borderRadius: 'var(--radius-xs)',
            border: '1px solid rgba(0, 191, 255, 0.1)',
            marginBottom: '20px',
          }}>
            <div style={{
              fontSize: '10px',
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '1px',
              marginBottom: '8px',
            }}>
              Order Type Breakdown
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
              <div>
                <span style={{ color: 'var(--text-secondary)' }}>Maker: </span>
                <span style={{ color: 'var(--green)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                  {summary.makerCount} fills (${summary.totalMakerFees.toFixed(3)})
                </span>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)' }}>Taker: </span>
                <span style={{ color: 'var(--red)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                  {summary.takerCount} fills (${summary.totalTakerFees.toFixed(3)})
                </span>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)' }}>Avg Cost/Trade: </span>
                <span style={{ color: 'var(--amber)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                  ${summary.avgCostPerTrade.toFixed(3)}
                </span>
              </div>
            </div>
          </div>

          {/* Gross vs Net P&L Chart */}
          {trades.length > 1 && (
            <div style={{ marginBottom: '16px' }}>
              <div style={{
                fontSize: '11px',
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '1px',
                marginBottom: '10px',
              }}>
                Gross vs Net P&L per Fill
              </div>
              <canvas ref={canvasRef} style={{ width: '100%', height: '200px' }} />
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
  sublabel,
  highlight = false,
}: {
  label: string;
  value: string;
  color: string;
  sublabel?: string;
  highlight?: boolean;
}) {
  return (
    <div style={{
      padding: '12px',
      background: highlight ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.25)',
      borderRadius: 'var(--radius-xs)',
      border: highlight
        ? '1px solid rgba(255,255,255,0.1)'
        : '1px solid rgba(255,255,255,0.04)',
      textAlign: 'center',
    }}>
      <div style={{
        fontSize: '10px',
        color: 'var(--text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.8px',
        marginBottom: '4px',
      }}>
        {label}
      </div>
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: '18px',
        fontWeight: 700,
        color,
      }}>
        {value}
      </div>
      {sublabel && (
        <div style={{
          fontSize: '9px',
          color: 'var(--text-muted)',
          marginTop: '3px',
          opacity: 0.7,
        }}>
          {sublabel}
        </div>
      )}
    </div>
  );
}
