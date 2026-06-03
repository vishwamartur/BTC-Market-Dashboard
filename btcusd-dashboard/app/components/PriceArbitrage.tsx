'use client';

import { usePriceArbitrage, type ArbLog } from '../hooks/usePriceArbitrage';
import { DEFAULT_ARB_CONFIG } from '../lib/priceArbitrage';

export default function PriceArbitrage() {
  const {
    isEnabled,
    setIsEnabled,
    prices,
    latencies,
    spreadPct,
    position,
    logs
  } = usePriceArbitrage();

  const isOpportunity = Math.abs(spreadPct) >= DEFAULT_ARB_CONFIG.entryThresholdPct;

  return (
    <div className="card" id="price-arbitrage">
      <div className="card-header" style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <h2 className="card-title">⚖️ Price Arb Engine</h2>
          {isEnabled ? (
            <span className="card-badge live">ACTIVE</span>
          ) : (
            <span className="card-badge" style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>PAUSED</span>
          )}
        </div>
        
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
            }}
          >
            LIVE
          </div>
          <button
            onClick={() => setIsEnabled(!isEnabled)}
            style={{
              padding: '6px 16px',
              borderRadius: 'var(--radius-xs)',
              border: 'none',
              background: isEnabled ? 'rgba(255, 42, 85, 0.2)' : 'var(--purple)',
              color: isEnabled ? 'var(--red)' : '#fff',
              fontSize: '11px',
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: isEnabled ? 'none' : '0 0 15px var(--purple-dim)',
            }}
          >
            {isEnabled ? 'STOP' : 'START ARB'}
          </button>
        </div>
      </div>

      <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '20px', lineHeight: '1.5' }}>
        Automatically captures price deviations between Binance (Global) and Delta (India). 
        Buys Delta when cheaper, shorts Delta when expensive. Target: <strong>±{DEFAULT_ARB_CONFIG.entryThresholdPct}%</strong>
      </p>

      {/* Price Tickers */}
      <div style={{ display: 'flex', gap: '16px', marginBottom: '24px' }}>
        <PriceBox label="Binance (Ref)" price={prices.binance} latency={latencies.binance} />
        <PriceBox label="Bybit" price={prices.bybit} latency={latencies.bybit} />
        <PriceBox label="Delta (Trade)" price={prices.delta} latency={latencies.delta} highlight />
      </div>

      {/* Spread Gauge */}
      <div style={{ 
        padding: '20px', 
        background: 'rgba(0,0,0,0.3)', 
        borderRadius: 'var(--radius-sm)',
        border: `1px solid ${isOpportunity ? 'var(--amber)' : 'rgba(255,255,255,0.05)'}`,
        boxShadow: isOpportunity ? 'inset 0 0 20px rgba(255, 170, 0, 0.1)' : 'none',
        marginBottom: '24px'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
          <span style={{ fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' }}>
            Live Spread (Delta - Binance)
          </span>
          <span style={{ 
            fontFamily: 'var(--font-mono)', 
            fontSize: '16px', 
            fontWeight: 700,
            color: spreadPct > 0 ? 'var(--red)' : spreadPct < 0 ? 'var(--green)' : 'var(--text-primary)'
          }}>
            {spreadPct > 0 ? '+' : ''}{spreadPct.toFixed(3)}%
          </span>
        </div>

        {/* Visual Bar */}
        <div style={{ position: 'relative', height: '12px', background: 'rgba(255,255,255,0.05)', borderRadius: '6px', overflow: 'hidden' }}>
           <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: '1px', background: 'rgba(255,255,255,0.2)', zIndex: 2 }} />
           
           {/* Entry Threshold Markers */}
           <div style={{ position: 'absolute', left: `calc(50% - ${DEFAULT_ARB_CONFIG.entryThresholdPct * 100}%)`, top: 0, bottom: 0, width: '1px', background: 'var(--green)', opacity: 0.5, zIndex: 2 }} />
           <div style={{ position: 'absolute', left: `calc(50% + ${DEFAULT_ARB_CONFIG.entryThresholdPct * 100}%)`, top: 0, bottom: 0, width: '1px', background: 'var(--red)', opacity: 0.5, zIndex: 2 }} />

           <div style={{
             position: 'absolute',
             top: 0, bottom: 0,
             width: '6px',
             background: '#fff',
             left: `clamp(0%, calc(50% + ${spreadPct * 100}%), 100%)`,
             transform: 'translateX(-50%)',
             borderRadius: '3px',
             boxShadow: '0 0 10px #fff',
             transition: 'left 0.2s ease'
           }}/>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px', fontSize: '10px', color: 'var(--text-muted)' }}>
            <span>Delta Cheaper (BUY)</span>
            <span>Parity</span>
            <span>Delta Premium (SELL)</span>
        </div>
      </div>

      {/* Active Position */}
      {position && (
        <div style={{ 
          padding: '16px', 
          background: position.side === 'BUY_DELTA' ? 'var(--green-dim)' : 'var(--red-dim)',
          border: `1px solid ${position.side === 'BUY_DELTA' ? 'rgba(0, 240, 152, 0.3)' : 'rgba(255, 42, 85, 0.3)'}`,
          borderRadius: 'var(--radius-sm)',
          marginBottom: '24px'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
               <span style={{ 
                 padding: '4px 8px', 
                 background: position.side === 'BUY_DELTA' ? 'var(--green)' : 'var(--red)',
                 color: '#000',
                 fontSize: '11px',
                 fontWeight: 700,
                 borderRadius: '4px'
               }}>
                 {position.side === 'BUY_DELTA' ? 'LONG DELTA' : 'SHORT DELTA'}
               </span>
               <span style={{ fontSize: '13px', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
                 {position.size}x @ {position.entryPrice.toFixed(2)}
               </span>
            </div>
            
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Entry Spread</div>
              <div style={{ fontSize: '14px', fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
                {position.entrySpread.toFixed(3)}%
              </div>
            </div>
          </div>
          <div style={{ marginTop: '12px', fontSize: '12px', color: 'var(--text-secondary)' }}>
            Waiting for spread to converge to {DEFAULT_ARB_CONFIG.exitThresholdPct}%...
          </div>
        </div>
      )}

      {/* Trade Log */}
      <div>
        <h3 style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px', textTransform: 'uppercase' }}>Recent Arb Actions</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '150px', overflowY: 'auto' }}>
          {logs.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-muted)', fontSize: '12px' }}>
              No arbitrage opportunities taken yet.
            </div>
          ) : (
            logs.map(log => <LogItem key={log.id} log={log} />)
          )}
        </div>
      </div>
    </div>
  );
}

function PriceBox({ label, price, latency, highlight = false }: { label: string, price: number | null, latency?: number | null, highlight?: boolean }) {
  let latencyColor = 'var(--text-muted)';
  if (latency) {
    if (latency < 200) latencyColor = 'var(--green)';
    else if (latency < 500) latencyColor = 'var(--amber)';
    else latencyColor = 'var(--red)';
  }

  return (
    <div style={{ 
      flex: 1, 
      padding: '12px', 
      background: highlight ? 'rgba(0, 191, 255, 0.05)' : 'rgba(0,0,0,0.2)', 
      border: `1px solid ${highlight ? 'rgba(0, 191, 255, 0.2)' : 'rgba(255,255,255,0.05)'}`,
      borderRadius: 'var(--radius-xs)',
      textAlign: 'center',
      position: 'relative'
    }}>
      <div style={{ fontSize: '10px', color: highlight ? 'var(--blue)' : 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>
        {label}
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '16px', fontWeight: highlight ? 700 : 500, color: 'var(--text-primary)' }}>
        {price ? price.toFixed(1) : '---'}
      </div>
      <div style={{ 
        position: 'absolute', 
        top: '4px', 
        right: '6px', 
        fontSize: '9px', 
        fontFamily: 'var(--font-mono)', 
        color: latencyColor,
        display: 'flex',
        alignItems: 'center',
        gap: '2px'
      }}>
        {latency ? `${latency}ms` : '---'}
        {latency && <span style={{ width: '4px', height: '4px', borderRadius: '50%', background: latencyColor, display: 'inline-block' }} />}
      </div>
    </div>
  );
}

function LogItem({ log }: { log: ArbLog }) {
  const isBuy = log.action === 'BUY_DELTA';
  const isSell = log.action === 'SELL_DELTA';
  const isClose = log.action.startsWith('CLOSE');

  let color = 'var(--text-secondary)';
  if (isBuy) color = 'var(--green)';
  if (isSell) color = 'var(--red)';
  if (isClose) color = 'var(--amber)';

  return (
    <div style={{ 
      display: 'flex', 
      justifyContent: 'space-between', 
      alignItems: 'center',
      padding: '8px 12px',
      background: 'rgba(0,0,0,0.2)',
      borderRadius: '4px',
      borderLeft: `3px solid ${color}`
    }}>
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          {log.time.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute:'2-digit', second:'2-digit' })}
        </span>
        <span style={{ fontSize: '12px', fontWeight: 600, color }}>{log.action.replace('_', ' ')}</span>
      </div>
      
      <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
        <span style={{ fontSize: '12px', fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
          Spread: {log.spread > 0 ? '+' : ''}{log.spread.toFixed(3)}%
        </span>
        {log.pnl !== undefined && (
          <span style={{ 
            fontSize: '12px', 
            fontWeight: 700, 
            fontFamily: 'var(--font-mono)',
            color: log.pnl > 0 ? 'var(--green)' : 'var(--red)'
          }}>
            {log.pnl > 0 ? '+' : ''}{log.pnl.toFixed(2)}
          </span>
        )}
      </div>
    </div>
  );
}
