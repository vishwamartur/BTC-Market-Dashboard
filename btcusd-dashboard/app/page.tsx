'use client';

import { useLiquidationData } from './hooks/useLiquidationData';
import { useOnChainData } from './hooks/useOnChainData';
import { useAutonomousTrading } from './hooks/useAutonomousTrading';
import { useSignalEngine } from './hooks/useSignalEngine';

import PriceTicker from './components/PriceTicker';
import StatsCards from './components/StatsCards';
import LiquidationFeed from './components/LiquidationFeed';
import LongShortGauge from './components/LongShortGauge';
import OpenInterest from './components/OpenInterest';
import LiquidationChart from './components/LiquidationChart';
import OnChainAnalytics from './components/OnChainAnalytics';
import WhaleTracker from './components/WhaleTracker';
import SignalEngine from './components/SignalEngine';
import AutoTraderControl from './components/AutoTraderControl';
import PriceArbitrage from './components/PriceArbitrage';
import LiquidationHeatmap from './components/LiquidationHeatmap';
import TradePerformance from './components/TradePerformance';
import OIDivergence from './components/OIDivergence';
import WhaleFlows from './components/WhaleFlows';
import ClientIP from './components/ClientIP';

export default function Dashboard() {
  const {
    events,
    stats,
    chartData,
    longShortRatio,
    openInterest,
    topTraderRatio,
    ticker,
    price,
    prevPrice,
    wsStatus,
    lastUpdate,
    fundingRate,
    priceHistory,
    oiHistory,
  } = useLiquidationData();

  const {
    mempoolStats,
    mempoolFees,
    latestBlocks,
    hashrateData,
    whaleTransactions,
  } = useOnChainData(price);

  const signal = useSignalEngine({
    liquidationStats: stats,
    longShortRatioStr: longShortRatio?.longShortRatio,
    mempoolTxCount: mempoolStats?.count ?? null,
    fastestFee: mempoolFees?.fastestFee ?? null,
    whaleTransactions,
    hashrateData,
    fundingRate,
    recentPrices: priceHistory,
    oiHistory,
  });

  const {
    isEnabled,
    setIsEnabled,
    isPaperTrade,
    setIsPaperTrade,
    tradeLogs,
  } = useAutonomousTrading({ signal });

  return (
    <main className="dashboard">
      {/* Header */}
      <header className="dashboard-header" id="dashboard-header">
        <div>
          <h1 className="dashboard-title">
            <span>BTC</span> Market Dashboard
          </h1>
          <p className="dashboard-subtitle">
            Real-time Bitcoin futures liquidations & on-chain analytics
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <div className="connection-status">
            <span
              className={`status-dot ${wsStatus['binance-liq'] || wsStatus['bybit-liq'] || wsStatus['okx-liq'] ? 'connected' : ''}`}
            ></span>
            <span>
              {wsStatus['binance-liq'] || wsStatus['bybit-liq'] || wsStatus['okx-liq'] ? 'Exchanges Connected' : 'Connecting...'}
            </span>
            <span style={{ color: 'var(--text-muted)', margin: '0 4px' }}>|</span>
            <span
              className={`status-dot ${wsStatus.price ? 'connected' : ''}`}
            ></span>
            <span>
              {wsStatus.price ? 'Price Feed' : 'Price...'}
            </span>
          </div>
          <ClientIP />
        </div>
      </header>

      {/* Price Ticker - Full Width */}
      <PriceTicker price={price} prevPrice={prevPrice} ticker={ticker} />

      {/* Stats Row - Full Width */}
      <div style={{ marginTop: '20px' }}>
        <StatsCards stats={stats} />
      </div>

      {/* Signal & On-Chain Row */}
      <div className="dashboard-grid" style={{ marginTop: '20px', gridTemplateColumns: '1fr 2fr' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <PriceArbitrage />
          <SignalEngine signal={signal} />
          <AutoTraderControl 
            isEnabled={isEnabled}
            setIsEnabled={setIsEnabled}
            isPaperTrade={isPaperTrade}
            setIsPaperTrade={setIsPaperTrade}
            tradeLogs={tradeLogs}
          />
        </div>
        <OnChainAnalytics
          mempoolStats={mempoolStats}
          mempoolFees={mempoolFees}
          latestBlocks={latestBlocks}
          hashrateData={hashrateData}
        />
      </div>

      {/* Main Grid: Liquidations & Whales */}
      <div className="dashboard-grid" style={{ marginTop: '20px', gridTemplateColumns: '2fr 1fr' }}>
        <LiquidationFeed events={events} />
        <WhaleTracker whaleTransactions={whaleTransactions} />
      </div>

      {/* Gauges & Chart Row */}
      <div className="dashboard-grid" style={{ marginTop: '20px', gridTemplateColumns: '1fr 2fr' }}>
        <LongShortGauge
          longShortRatio={longShortRatio}
          topTraderRatio={topTraderRatio}
        />
        <LiquidationChart data={chartData} />
      </div>

      {/* Open Interest Row */}
      <div style={{ marginTop: '20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
        <OpenInterest openInterest={openInterest} price={price} />

        {/* Market Summary Card */}
        <div className="card" id="market-summary">
          <div className="card-header">
            <span className="card-title">🏦 Summary</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <SummaryRow
              label="Longs Liquidated"
              value={stats.totalLongLiquidations.toString()}
              color="var(--red)"
              icon="🔴"
            />
            <SummaryRow
              label="Shorts Liquidated"
              value={stats.totalShortLiquidations.toString()}
              color="var(--green)"
              icon="🟢"
            />
            <SummaryRow
              label="Total Events"
              value={(stats.totalLongLiquidations + stats.totalShortLiquidations).toString()}
              color="var(--amber)"
              icon="⚡"
            />
            <SummaryRow
              label="Long/Short Ratio"
              value={longShortRatio ? parseFloat(longShortRatio.longShortRatio).toFixed(3) : '—'}
              color="var(--blue)"
              icon="📊"
            />
            <SummaryRow
              label="Dominance"
              value={
                stats.totalLongLiquidations + stats.totalShortLiquidations > 0
                  ? `${((stats.totalLongLiquidations / (stats.totalLongLiquidations + stats.totalShortLiquidations)) * 100).toFixed(1)}% Longs`
                  : '—'
              }
              color="var(--purple)"
              icon="📈"
            />
          </div>
        </div>
      </div>

      {/* Historical Analytics - Row 1 */}
      <div className="dashboard-grid" style={{ marginTop: '20px', gridTemplateColumns: '1fr 1fr' }}>
        <LiquidationHeatmap />
        <TradePerformance />
      </div>

      {/* Historical Analytics - Row 2 */}
      <div className="dashboard-grid" style={{ marginTop: '20px', gridTemplateColumns: '1fr 1fr' }}>
        <OIDivergence />
        <WhaleFlows />
      </div>

      {/* Footer */}
      <footer style={{
        marginTop: '32px',
        paddingTop: '20px',
        borderTop: '1px solid var(--border-color)',
        textAlign: 'center',
        fontSize: '12px',
        color: 'var(--text-muted)',
        fontFamily: 'var(--font-mono)',
      }}>
        Data sourced from Binance Futures & Mempool.space · WebSocket + REST · Updates in real-time
      </footer>
    </main>
  );
}

function SummaryRow({
  label,
  value,
  color,
  icon,
}: {
  label: string;
  value: string;
  color: string;
  icon: string;
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '10px 14px',
      background: 'var(--bg-secondary)',
      borderRadius: 'var(--radius-xs)',
      border: '1px solid var(--border-color)',
    }}>
      <span style={{
        fontSize: '13px',
        color: 'var(--text-secondary)',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      }}>
        <span>{icon}</span>
        {label}
      </span>
      <span style={{
        fontFamily: 'var(--font-mono)',
        fontSize: '15px',
        fontWeight: 600,
        color,
      }}>
        {value}
      </span>
    </div>
  );
}
