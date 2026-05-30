import type { WhaleTransaction } from '../lib/blockchain';

interface WhaleTrackerProps {
  whaleTransactions: WhaleTransaction[];
}

export default function WhaleTracker({ whaleTransactions }: WhaleTrackerProps) {
  let inflowVol = 0;
  let outflowVol = 0;
  
  for (const tx of whaleTransactions) {
    if (tx.type === 'INFLOW') inflowVol += tx.amountBtc;
    if (tx.type === 'OUTFLOW') outflowVol += tx.amountBtc;
  }
  
  const totalFlow = inflowVol + outflowVol;
  const inflowPct = totalFlow > 0 ? (inflowVol / totalFlow) * 100 : 50;
  const outflowPct = totalFlow > 0 ? (outflowVol / totalFlow) * 100 : 50;

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">🐋 Whale Tracker (&gt;10 BTC)</h2>
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Unconfirmed</span>
      </div>

      <div style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '13px' }}>
          <span style={{ color: 'var(--red)' }}>Inflows (Bearish): {inflowVol.toFixed(1)} BTC</span>
          <span style={{ color: 'var(--green)' }}>Outflows (Bullish): {outflowVol.toFixed(1)} BTC</span>
        </div>
        <div className="gauge-bar">
          <div className="gauge-fill long" style={{ width: `${inflowPct}%`, background: 'var(--red)' }}></div>
          <div className="gauge-fill short" style={{ width: `${outflowPct}%`, background: 'var(--green)' }}></div>
        </div>
      </div>

      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        maxHeight: '200px',
        overflowY: 'auto',
        paddingRight: '4px'
      }}>
        {whaleTransactions.length === 0 && (
          <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '20px 0' }}>
            Scanning for whales...
          </div>
        )}
        {whaleTransactions.map((tx) => (
          <div key={tx.hash} style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '8px 12px',
            background: 'var(--bg-secondary)',
            borderRadius: 'var(--radius-xs)',
            borderLeft: `4px solid ${
              tx.type === 'INFLOW' ? 'var(--red)' : 
              tx.type === 'OUTFLOW' ? 'var(--green)' : 
              'var(--blue)'
            }`
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span style={{ fontWeight: 600, fontSize: '14px' }}>{tx.amountBtc.toFixed(2)} BTC</span>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                {new Date(tx.time).toLocaleTimeString()}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' }}>
              <span style={{ 
                fontSize: '12px', 
                color: tx.type === 'INFLOW' ? 'var(--red)' : tx.type === 'OUTFLOW' ? 'var(--green)' : 'var(--blue)',
                fontWeight: 600
              }}>
                {tx.type}
              </span>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                ${(tx.usdValue / 1e6).toFixed(2)}M
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
