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
        <span className="card-badge" style={{ background: 'var(--purple)', color: '#fff', boxShadow: '0 0 10px var(--purple)' }}>Algorithm</span>
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

      {/* Component Breakdown */}
      <div style={{ marginTop: '24px' }}>
        <h3 style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '16px', letterSpacing: '1.5px', textTransform: 'uppercase' }}>
          Signal Drivers
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <SignalRow label="Liquidation Pressure" value={signal.components.find(c => c.name === 'Liquidation Pressure')?.score || 0} />
          <SignalRow label="Long/Short Bias" value={signal.components.find(c => c.name === 'Long/Short Bias')?.score || 0} />
          <SignalRow label="On-Chain Activity" value={signal.components.find(c => c.name === 'On-Chain Activity')?.score || 0} />
        </div>
      </div>
    </div>
  );
}

function SignalRow({ label, value }: { label: string; value: number }) {
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
      padding: '12px 16px',
      background: 'rgba(0,0,0,0.2)',
      borderRadius: 'var(--radius-xs)',
      border: '1px solid rgba(255,255,255,0.05)'
    }}>
      <span style={{ fontSize: '13px', color: 'var(--text-primary)', fontWeight: 500 }}>{label}</span>
      <span style={{
        fontFamily: 'var(--font-mono)',
        fontSize: '15px',
        fontWeight: 700,
        color,
        textShadow: `0 0 10px ${color}80`
      }}>
        {value > 0 ? '+' : ''}{value.toFixed(2)}
      </span>
    </div>
  );
}
