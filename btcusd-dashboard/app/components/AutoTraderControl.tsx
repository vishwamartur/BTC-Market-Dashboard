import React from 'react';
import type { TradeLog } from '../hooks/useAutonomousTrading';
import type { ActivePosition } from '../lib/positions';

interface AutoTraderControlProps {
  isEnabled: boolean;
  setIsEnabled: (enabled: boolean) => void;
  tradeLogs: TradeLog[];
  activePosition: ActivePosition | null;
  isPositionLoaded: boolean;
  isClosingPosition: boolean;
  closeActivePosition: (reason?: string) => Promise<void>;
}

export default function AutoTraderControl({
  isEnabled,
  setIsEnabled,
  tradeLogs,
  activePosition,
  isPositionLoaded,
  isClosingPosition,
  closeActivePosition,
}: AutoTraderControlProps) {
  const positionColor = activePosition?.side === 'LONG' ? 'var(--green)' : 'var(--red)';

  return (
    <div className="card">
      <div className="card-header" style={{ justifyContent: 'space-between', marginBottom: '16px' }}>
        <h2 className="card-title">⚙️ Auto-Trader</h2>
        <div style={{ display: 'flex', gap: '8px' }}>
          <div
            style={{
              padding: '6px 12px',
              borderRadius: 'var(--radius-xs)',
              border: '1px solid var(--red)',
              background: 'var(--red-dim)',
              color: 'var(--red)',
              fontSize: '11px',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              boxShadow: '0 0 10px var(--red-dim)',
            }}
            title="WARNING: Live funds will be used"
          >
            LIVE TRADING
          </div>
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
        <div style={{
          padding: '12px',
          background: 'rgba(0,0,0,0.3)',
          border: `1px solid ${activePosition ? positionColor : 'var(--border-color)'}`,
          borderRadius: 'var(--radius-sm)',
          marginBottom: '16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
        }}>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '6px' }}>
              Delta BTC Position
            </div>
            {!isPositionLoaded ? (
              <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Syncing position...</div>
            ) : activePosition ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ color: positionColor, fontFamily: 'var(--font-mono)', fontWeight: 700 }}>
                  {activePosition.side} {activePosition.size} contracts
                </span>
                <span style={{ color: 'var(--text-muted)', fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
                  Entry: {activePosition.entryPrice ? activePosition.entryPrice.toFixed(2) : '--'}
                  {activePosition.unrealizedPnl !== null ? ` | uPnL: ${activePosition.unrealizedPnl.toFixed(2)}` : ''}
                </span>
              </div>
            ) : (
              <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>No open BTC position</div>
            )}
          </div>

          {activePosition && (
            <button
              onClick={() => {
                if (window.confirm('Close the open BTC position with a reduce-only market order?')) {
                  void closeActivePosition('Manual close from dashboard');
                }
              }}
              disabled={isClosingPosition}
              style={{
                padding: '8px 12px',
                borderRadius: 'var(--radius-xs)',
                border: '1px solid var(--red)',
                background: isClosingPosition ? 'rgba(255,255,255,0.06)' : 'var(--red-dim)',
                color: isClosingPosition ? 'var(--text-muted)' : 'var(--red)',
                cursor: isClosingPosition ? 'not-allowed' : 'pointer',
                fontSize: '11px',
                fontWeight: 700,
                whiteSpace: 'nowrap',
              }}
            >
              {isClosingPosition ? 'CLOSING...' : 'CLOSE POSITION'}
            </button>
          )}
        </div>

        <div style={{ marginTop: '16px', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
          Bot executes trades on Delta Exchange when the v2 Signal Engine reaches <strong>STRONG BUY</strong> or <strong>STRONG SELL</strong> for 3+ consecutive evaluations. Existing positions are synced from Delta and closed on opposite strong signals. Daily loss limit: $100. Cooldown: 5 min.
        </div>

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
                borderLeft: `2px solid ${getActionColor(log.action)}`,
                background: 'rgba(255,255,255,0.02)',
                borderRadius: '0 4px 4px 0'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span style={{ color: getActionColor(log.action), fontWeight: 600 }}>
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
                    {log.status}
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

function getActionColor(action: TradeLog['action']) {
  return action === 'BUY' || action === 'CLOSE_SHORT' ? 'var(--green)' : 'var(--red)';
}
