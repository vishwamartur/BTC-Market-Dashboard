'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import ClientIP from '../components/ClientIP';
import WalletPNLChart from '../components/WalletPNLChart';
import CostAnalysis from '../components/CostAnalysis';

interface WalletBalance {
  asset_id: number;
  asset_symbol: string;
  balance: string;
  available_balance: string;
  [key: string]: any;
}

export default function WalletPage() {
  const [balances, setBalances] = useState<WalletBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  useEffect(() => {
    let mounted = true;

    async function fetchWallet() {
      try {
        const res = await fetch('/api/wallet');
        const data = await res.json();
        
        if (mounted) {
          if (data.success) {
            setBalances(data.balances || []);
            setLastUpdate(new Date(data.timestamp));
            setError(null);
          } else {
            setError(data.error || 'Failed to fetch balances');
          }
          setLoading(false);
        }
      } catch (err: any) {
        if (mounted) {
          setError(err.message || 'An error occurred');
          setLoading(false);
        }
      }
    }

    fetchWallet();
    const interval = setInterval(fetchWallet, 5000); // Poll every 5 seconds

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  return (
    <main className="dashboard">
      <header className="dashboard-header">
        <div>
          <h1 className="dashboard-title">
            <span>Live</span> Wallet Balance
          </h1>
          <p className="dashboard-subtitle">
            Real-time tracking of Delta Exchange wallet balances
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <Link href="/" style={{
            color: 'var(--text-secondary)',
            textDecoration: 'none',
            fontFamily: 'var(--font-mono)',
            fontSize: '14px',
            border: '1px solid var(--border-color)',
            padding: '8px 16px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--bg-secondary)',
            transition: 'all var(--transition-fast)'
          }}
          onMouseOver={(e) => {
            e.currentTarget.style.background = 'var(--bg-card)';
            e.currentTarget.style.color = 'var(--text-primary)';
            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.15)';
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.background = 'var(--bg-secondary)';
            e.currentTarget.style.color = 'var(--text-secondary)';
            e.currentTarget.style.borderColor = 'var(--border-color)';
          }}>
            ← Back to Dashboard
          </Link>
          <ClientIP />
        </div>
      </header>

      {error && (
        <div style={{ background: 'var(--red-dim)', color: 'var(--red)', padding: '16px', borderRadius: 'var(--radius-sm)', marginBottom: '24px', border: '1px solid var(--red)' }}>
          Error: {error}
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <span className="card-title">💼 Spot & Futures Balances</span>
          {loading ? (
            <span className="card-badge polling">Loading...</span>
          ) : (
            <span className="card-badge live">Live</span>
          )}
        </div>

        <div className="feed-container" style={{ maxHeight: 'none' }}>
          <table className="feed-table">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Total Balance</th>
                <th>Available Balance</th>
              </tr>
            </thead>
            <tbody>
              {balances.length === 0 && !loading && (
                <tr>
                  <td colSpan={3} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                    No balances found
                  </td>
                </tr>
              )}
              {balances.map((b, i) => (
                <tr key={i} className="feed-row">
                  <td>
                    <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '16px' }}>{b.asset_symbol}</span>
                  </td>
                  <td>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '18px' }}>
                      {parseFloat(b.balance).toFixed(4)}
                    </span>
                  </td>
                  <td>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '18px', color: 'var(--green)' }}>
                      {parseFloat(b.available_balance).toFixed(4)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        
        {lastUpdate && (
          <div style={{ marginTop: '20px', fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', textAlign: 'right' }}>
            Last updated: {lastUpdate.toLocaleTimeString()}
          </div>
        )}
      </div>

      <div style={{ marginTop: '24px' }}>
        <WalletPNLChart />
      </div>

      <div style={{ marginTop: '24px' }}>
        <CostAnalysis />
      </div>
    </main>
  );
}
