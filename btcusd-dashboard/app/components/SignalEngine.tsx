import type { SignalResult } from '../lib/signals';

interface SignalEngineProps {
  signal: SignalResult;
}

export default function SignalEngine({ signal }: SignalEngineProps) {
  const getSignalColor = (s: string) => {
    switch (s) {
      case 'STRONG BUY': return 'var(--green)';
      case 'BUY': return '#a3e635'; // lighter green
      case 'NEUTRAL': return 'var(--amber)';
      case 'SELL': return '#fb923c'; // lighter red/orange
      case 'STRONG SELL': return 'var(--red)';
      default: return 'var(--text-primary)';
    }
  };

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">🤖 Trading Signal Engine</h2>
        <span className="card-badge" style={{ background: 'var(--purple)', color: '#fff', boxShadow: '0 0 10px var(--purple)' }}>v2 Algorithm</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', margin: '20px 0' }}>
        <div style={{
          fontSize: '36px',
          fontWeight: 800,
          color: getSignalColor(signal.overallSignal),
          textShadow: `0 0 20px ${getSignalColor(signal.overallSignal)}40`
        }}>
          {signal.overallSignal}
        </div>
        <div style={{ fontSize: '14px', color: 'var(--text-muted)', marginTop: '8px' }}>
          Confidence: <strong style={{ color: 'var(--text-primary)' }}>{signal.confidence}%</strong>
          <span style={{ marginLeft: '16px', color: 'var(--text-muted)' }}>
            Score: <strong style={{ color: getSignalColor(signal.overallSignal) }}>{signal.score > 0 ? '+' : ''}{signal.score.toFixed(3)}</strong>
          </span>
        </div>
        
        {/* Gauge Visual */}
        <div style={{ marginTop: '24px', width: '100%' }}>
          <div style={{
            height: '24px',
            background: 'rgba(0,0,0,0.4)',
            borderRadius: '12px',
            position: 'relative',
            overflow: 'hidden',
            boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.5)',
            border: '1px solid rgba(255,255,255,0.05)'
          }}>
            {/* Signal Cursor */}
            <div style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              width: '4px',
              background: '#fff',
              left: `min(max(${50 + (signal.score * 50)}%, 0%), 100%)`,
              transform: 'translateX(-50%)',
              zIndex: 10,
              boxShadow: '0 0 10px #fff, 0 0 20px #fff',
              transition: 'left 0.5s cubic-bezier(0.16, 1, 0.3, 1)',
              borderRadius: '2px'
            }} />
            
            {/* Gradients representing Sell/Neutral/Buy zones */}
            <div style={{ display: 'flex', width: '100%', height: '100%' }}>
              <div style={{ flex: 1, background: 'linear-gradient(90deg, rgba(255, 42, 85, 0.8), rgba(255, 42, 85, 0.2))' }} />
              <div style={{ flex: 1, background: 'rgba(255, 255, 255, 0.05)' }} />
              <div style={{ flex: 1, background: 'linear-gradient(90deg, rgba(0, 240, 152, 0.2), rgba(0, 240, 152, 0.8))' }} />
            </div>
          </div>

          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: '12px',
            fontSize: '11px',
            fontWeight: 600,
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '1px'
          }}>
            <span>Strong Sell (-1)</span>
            <span>Neutral (0)</span>
            <span>Strong Buy (+1)</span>
          </div>
        </div>
      </div>

      {/* Dynamic Component Breakdown — renders ALL active signal components */}
      <div style={{ marginTop: '24px' }}>
        <h3 style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '16px', letterSpacing: '1.5px', textTransform: 'uppercase' }}>
          Signal Drivers ({signal.components.length} active)
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {signal.components.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', padding: '16px 0' }}>
              Waiting for data to generate signals...
            </div>
          ) : (
            signal.components.map((comp) => (
              <SignalRow
                key={comp.name}
                label={comp.name}
                value={comp.score}
                weight={comp.weight}
                reason={comp.reason}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function SignalRow({ label, value, weight, reason }: { label: string; value: number; weight: number; reason: string }) {
  const isPositive = value > 0;
  const isNegative = value < 0;
  
  let color = 'var(--text-muted)';
  if (isPositive) color = 'var(--green)';
  if (isNegative) color = 'var(--red)';

  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '10px 14px',
      background: 'rgba(0,0,0,0.2)',
      borderRadius: 'var(--radius-xs)',
      border: '1px solid rgba(255,255,255,0.05)'
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '12px', color: 'var(--text-primary)', fontWeight: 500 }}>{label}</span>
          <span style={{
            fontSize: '9px',
            color: 'var(--text-muted)',
            background: 'rgba(255,255,255,0.05)',
            padding: '1px 6px',
            borderRadius: '8px',
            fontFamily: 'var(--font-mono)'
          }}>
            w:{(weight * 100).toFixed(0)}%
          </span>
        </div>
        <span style={{ fontSize: '10px', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {reason}
        </span>
      </div>
      <span style={{
        fontFamily: 'var(--font-mono)',
        fontSize: '15px',
        fontWeight: 700,
        color,
        textShadow: `0 0 10px ${color}80`,
        marginLeft: '12px',
        flexShrink: 0,
      }}>
        {value > 0 ? '+' : ''}{value.toFixed(2)}
      </span>
    </div>
  );
}
