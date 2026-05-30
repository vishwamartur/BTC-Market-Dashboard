import type { MempoolStats, MempoolFees, BlockData, HashrateData } from '../lib/mempool';

interface OnChainAnalyticsProps {
  mempoolStats: MempoolStats | null;
  mempoolFees: MempoolFees | null;
  latestBlocks: BlockData[];
  hashrateData: HashrateData | null;
}

export default function OnChainAnalytics({
  mempoolStats,
  mempoolFees,
  latestBlocks,
  hashrateData,
}: OnChainAnalyticsProps) {
  const formatHashrate = (hr: number) => {
    return (hr / 1e18).toFixed(2) + ' EH/s'; // Exahashes
  };

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">🔗 On-Chain Analytics</h2>
        <span className="badge" style={{ background: 'var(--amber)', color: '#000' }}>Live</span>
      </div>

      <div className="stats-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px' }}>
        <div className="stat-card">
          <div className="stat-label">Unconfirmed TXs</div>
          <div className="stat-value">{mempoolStats ? mempoolStats.count.toLocaleString() : '—'}</div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Next Block Fee</div>
          <div className="stat-value" style={{ color: 'var(--amber)' }}>
            {mempoolFees ? `${mempoolFees.fastestFee} sat/vB` : '—'}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Network Hashrate</div>
          <div className="stat-value" style={{ color: 'var(--blue)' }}>
            {hashrateData ? formatHashrate(hashrateData.currentHashrate) : '—'}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Latest Block</div>
          <div className="stat-value">
            {latestBlocks.length > 0 ? `#${latestBlocks[0].height.toLocaleString()}` : '—'}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
            {latestBlocks.length > 0 ? `${latestBlocks[0].tx_count} TXs` : ''}
          </div>
        </div>
      </div>
    </div>
  );
}
