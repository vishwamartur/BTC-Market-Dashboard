import React from 'react';
import type { TradeLog } from '../hooks/useAutonomousTrading';

interface AutoTraderControlProps {
  isEnabled: boolean;
  setIsEnabled: (enabled: boolean) => void;
  isPaperTrade: boolean;
  setIsPaperTrade: (paper: boolean) => void;
  tradeLogs: TradeLog[];
}

export default function AutoTraderControl({
  isEnabled,
  setIsEnabled,
  isPaperTrade,
  setIsPaperTrade,
  tradeLogs,
}: AutoTraderControlProps) {
  return (
    <div className="card">
      <div className="card-header" style={{ justifyContent: 'space-between', marginBottom: '16px' }}>
        <h2 className="card-title">⚙️ Auto-Trader</h2>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button
            onClick={() => setIsPaperTrade(!isPaperTrade)}
            style={{
              padding: '6px 14px',
              borderRadius: '20px',
              border: `1px solid ${isPaperTrade ? 'var(--blue)' : 'var(--red)'}`,
              background: isPaperTrade ? 'var(--blue-dim)' : 'var(--red-dim)',
              color: isPaperTrade ? 'var(--blue)' : 'var(--red)',
              cursor: 'pointer',
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '0.5px',
              transition: 'all 0.2s',
              boxShadow: `0 0 10px ${isPaperTrade ? 'var(--blue-dim)' : 'var(--red-dim)'}`
            }}
            title={isPaperTrade ? "Running in simulation mode" : "WARNING: Live funds will be used"}
          >
            {isPaperTrade ? 'PAPER TRADING' : 'LIVE TRADING'}
          </button>
          <button
            onClick={() => setIsEnabled(!isEnabled)}
            style={{
              padding: '6px 14px',
              borderRadius: '20px',
              border: isEnabled ? '1px solid var(--green)' : '1px solid var(--border-color)',
              background: isEnabled ? 'var(--green-dim)' : 'rgba(0,0,0,0.4)',
              color: isEnabled ? 'var(--green)' : 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '0.5px',
              transition: 'all 0.2s',
              boxShadow: isEnabled ? '0 0 10px var(--green-dim)' : 'none'
            }}
          >
            {isEnabled ? 'ENABLED' : 'DISABLED'}
          </button>
        </div>
      </div>

      <div style={{ padding: '16px 0 0 0' }}>
        <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px', lineHeight: '1.5' }}>
          Bot will automatically buy or sell 1 contract on Delta Exchange when the Signal Engine reaches a <strong>STRONG BUY</strong> or <strong>STRONG SELL</strong>. Minimum cooldown between trades is 5 minutes.
        </p>

        <div style={{
          maxHeight: '150px',
          overflowY: 'auto',
          background: 'var(--bg-secondary)',
          borderRadius: 'var(--radius-sm)',
          padding: '8px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px'
        }}>
          {tradeLogs.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '11px', padding: '20px 0' }}>
              No trades executed yet.
            </div>
          ) : (
            tradeLogs.map((log) => (
              <div key={log.id} style={{
                fontSize: '11px',
                padding: '6px 8px',
                borderLeft: `2px solid ${log.action === 'BUY' ? 'var(--green)' : 'var(--red)'}`,
                background: 'rgba(255,255,255,0.02)',
                borderRadius: '0 4px 4px 0'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span style={{ color: log.action === 'BUY' ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                    {log.action}
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {log.timestamp.toLocaleTimeString()}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    Signal: {log.signalScore.toFixed(2)}
                  </span>
                  <span style={{
                    color: log.status === 'SUCCESS' ? 'var(--green)' : log.status === 'FAILED' ? 'var(--red)' : 'var(--amber)'
                  }}>
                    {log.status} {log.isPaperTrade ? '(PAPER)' : ''}
                  </span>
                </div>
                {log.details && (
                  <div style={{ color: 'var(--text-muted)', marginTop: '4px', fontStyle: 'italic', wordBreak: 'break-all' }}>
                    {log.details}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
