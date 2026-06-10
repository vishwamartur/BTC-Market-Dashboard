'use client';

import { useState, useEffect, useRef } from 'react';
import {
  calculateBreakEven,
  calculateExpectedNetValue,
  calculatePositionSize,
  DEFAULT_RISK_CONFIG,
  type BreakEvenResult,
} from '../lib/riskManager';

interface FeeBreakevenCardProps {
  currentPrice: number;
  signalConfidence: number;
  signalScore: number;
  signalDirection: string;
}

export default function FeeBreakevenCard({
  currentPrice,
  signalConfidence,
  signalScore,
  signalDirection,
}: FeeBreakevenCardProps) {
  const config = DEFAULT_RISK_CONFIG;

  // Calculate all fee-aware metrics
  const positionSize = calculatePositionSize(signalConfidence, currentPrice, config);
  const breakEvenTaker = currentPrice > 0 && positionSize > 0
    ? calculateBreakEven(positionSize, currentPrice, config, false)
    : null;
  const breakEvenMaker = currentPrice > 0 && positionSize > 0
    ? calculateBreakEven(positionSize, currentPrice, config, true)
    : null;

  const eNet = calculateExpectedNetValue(signalConfidence, config);
  const expectedProfitUsd = breakEvenTaker
    ? eNet * breakEvenTaker.notionalUsd
    : 0;
  const profitAfterFees = breakEvenTaker
    ? expectedProfitUsd - breakEvenTaker.roundTripCostUsd
    : 0;
  const feeEfficiency = breakEvenTaker && breakEvenTaker.roundTripCostUsd > 0
    ? expectedProfitUsd / breakEvenTaker.roundTripCostUsd
    : 0;

  const isTradeViable = feeEfficiency >= config.minBreakEvenMultiple;
  const hasSignal = signalDirection !== 'NEUTRAL' && signalConfidence >= config.minConfidence;

  // Animated gauge
  const gaugeRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = gaugeRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const cx = w / 2;
    const cy = h - 10;
    const radius = Math.min(cx, cy) - 10;

    ctx.clearRect(0, 0, w, h);

    // Background arc
    ctx.beginPath();
    ctx.arc(cx, cy, radius, Math.PI, 0, false);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 12;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Value arc
    const maxEff = 3.0; // max display efficiency
    const effClamped = Math.min(Math.max(feeEfficiency, 0), maxEff);
    const effAngle = Math.PI + (effClamped / maxEff) * Math.PI;

    ctx.beginPath();
    ctx.arc(cx, cy, radius, Math.PI, effAngle, false);

    // Color gradient: red (0) → yellow (1) → green (2+)
    let gaugeColor = '#ff2a55'; // red
    if (feeEfficiency >= 2.0) gaugeColor = '#00f098'; // green
    else if (feeEfficiency >= 1.5) gaugeColor = '#00bfff'; // blue
    else if (feeEfficiency >= 1.0) gaugeColor = '#f0b400'; // amber
    else if (feeEfficiency >= 0.5) gaugeColor = '#ff6b35'; // orange

    ctx.strokeStyle = gaugeColor;
    ctx.lineWidth = 12;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Center text
    ctx.fillStyle = gaugeColor;
    ctx.font = 'bold 22px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${feeEfficiency.toFixed(1)}×`, cx, cy - 8);

    // Label
    ctx.fillStyle = '#64748b';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillText('FEE EFFICIENCY', cx, cy + 8);

    // Scale labels
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillStyle = '#475569';
    ctx.textAlign = 'left';
    ctx.fillText('0×', cx - radius - 5, cy + 8);
    ctx.textAlign = 'right';
    ctx.fillText(`${maxEff}×`, cx + radius + 5, cy + 8);

    // Threshold marker at 1.5×
    const thresholdAngle = Math.PI + (1.5 / maxEff) * Math.PI;
    const mx = cx + Math.cos(thresholdAngle) * (radius + 16);
    const my = cy + Math.sin(thresholdAngle) * (radius + 16);
    ctx.fillStyle = '#f0b400';
    ctx.font = '8px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('MIN', mx, my);
  }, [feeEfficiency]);

  const formatUsd = (val: number) => {
    const prefix = val >= 0 ? '+' : '';
    return `${prefix}$${Math.abs(val).toFixed(2)}`;
  };

  return (
    <div className="card" id="fee-breakeven-card">
      <div className="card-header">
        <span className="card-title">💰 Fee & Breakeven Calculator</span>
        <span
          className="card-badge"
          style={{
            background: isTradeViable && hasSignal
              ? 'rgba(0, 240, 152, 0.15)'
              : 'rgba(255, 42, 85, 0.15)',
            color: isTradeViable && hasSignal ? 'var(--green)' : 'var(--red)',
            border: `1px solid ${isTradeViable && hasSignal ? 'rgba(0, 240, 152, 0.3)' : 'rgba(255, 42, 85, 0.3)'}`,
          }}
        >
          {!hasSignal ? 'No Signal' : isTradeViable ? '✓ Trade Viable' : '✗ Fees Too High'}
        </span>
      </div>

      {/* Fee Efficiency Gauge */}
      <div style={{ display: 'flex', justifyContent: 'center', margin: '8px 0 16px' }}>
        <canvas
          ref={gaugeRef}
          style={{ width: '180px', height: '100px' }}
        />
      </div>

      {/* Metrics Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <MetricBox
          label="Position Size"
          value={`${positionSize} contracts`}
          color="var(--text-primary)"
        />
        <MetricBox
          label="Notional"
          value={breakEvenTaker ? `$${breakEvenTaker.notionalUsd.toFixed(2)}` : '—'}
          color="var(--text-primary)"
        />
        <MetricBox
          label="Round-trip Fee"
          value={breakEvenTaker ? `$${breakEvenTaker.feeUsd.toFixed(3)}` : '—'}
          color="var(--amber)"
          sublabel="Trading fee"
        />
        <MetricBox
          label="GST (15.25%)"
          value={breakEvenTaker ? `$${breakEvenTaker.gstUsd.toFixed(3)}` : '—'}
          color="var(--amber)"
          sublabel="On trading fee"
        />
        <MetricBox
          label="Total Cost"
          value={breakEvenTaker ? `$${breakEvenTaker.roundTripCostUsd.toFixed(3)}` : '—'}
          color="var(--red)"
          sublabel="Fee + GST"
          highlight
        />
        <MetricBox
          label="Break-even Move"
          value={breakEvenTaker ? `${breakEvenTaker.breakEvenMovePct.toFixed(3)}%` : '—'}
          color="var(--blue)"
          sublabel="Min move to profit"
        />
        <MetricBox
          label="Expected Profit"
          value={formatUsd(expectedProfitUsd)}
          color={expectedProfitUsd >= 0 ? 'var(--green)' : 'var(--red)'}
          sublabel={`E[net] = ${(eNet * 100).toFixed(3)}%`}
        />
        <MetricBox
          label="Net After Fees"
          value={formatUsd(profitAfterFees)}
          color={profitAfterFees >= 0 ? 'var(--green)' : 'var(--red)'}
          sublabel="Profit − costs"
          highlight
        />
      </div>

      {/* Maker vs Taker comparison */}
      {breakEvenTaker && breakEvenMaker && (
        <div style={{
          marginTop: '14px',
          padding: '10px 12px',
          background: 'rgba(0, 191, 255, 0.05)',
          borderRadius: 'var(--radius-xs)',
          border: '1px solid rgba(0, 191, 255, 0.1)',
        }}>
          <div style={{
            fontSize: '10px',
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '1px',
            marginBottom: '8px',
          }}>
            Taker vs Maker Fee Comparison
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
            <div>
              <span style={{ color: 'var(--text-secondary)' }}>Taker (0.05%): </span>
              <span style={{ color: 'var(--red)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                ${breakEvenTaker.roundTripCostUsd.toFixed(3)}
              </span>
            </div>
            <div>
              <span style={{ color: 'var(--text-secondary)' }}>Maker (0.02%): </span>
              <span style={{ color: 'var(--green)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                ${breakEvenMaker.roundTripCostUsd.toFixed(3)}
              </span>
            </div>
            <div>
              <span style={{ color: 'var(--text-secondary)' }}>Savings: </span>
              <span style={{ color: 'var(--green)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                ${(breakEvenTaker.roundTripCostUsd - breakEvenMaker.roundTripCostUsd).toFixed(3)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Signal status */}
      <div style={{
        marginTop: '12px',
        fontSize: '11px',
        color: 'var(--text-muted)',
        fontFamily: 'var(--font-mono)',
        display: 'flex',
        justifyContent: 'space-between',
        padding: '8px 0',
        borderTop: '1px solid var(--border-color)',
      }}>
        <span>Signal: {signalDirection} ({signalConfidence}%)</span>
        <span>Min confidence: {config.minConfidence}%</span>
        <span>Cooldown: {config.cooldownMs / 60000}m</span>
      </div>
    </div>
  );
}

function MetricBox({
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
      padding: '10px 12px',
      background: highlight ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.2)',
      borderRadius: 'var(--radius-xs)',
      border: highlight
        ? '1px solid rgba(255,255,255,0.1)'
        : '1px solid rgba(255,255,255,0.04)',
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
        fontSize: '15px',
        fontWeight: 700,
        color,
      }}>
        {value}
      </div>
      {sublabel && (
        <div style={{
          fontSize: '9px',
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
          marginTop: '2px',
          opacity: 0.7,
        }}>
          {sublabel}
        </div>
      )}
    </div>
  );
}
