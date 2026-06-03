# BTC-Market-Dashboard 🚀

A real-time, comprehensive Bitcoin (BTC) market analytics and automated trading dashboard. Built with Next.js, it aggregates live exchange data, on-chain metrics, and liquidation heatmaps to power an autonomous trading engine on Delta Exchange India.

## 🌟 Features

### 📊 Advanced Market Analytics
- **Live Orderflow & Liquidations:** Real-time stream of market liquidations across major exchanges (Binance, Bybit, OKX).
- **Whale Tracking:** Detects large volume transactions and computes a Whale Flow bias.
- **Open Interest (OI) Divergence:** Monitors futures market leverage, calculating long/short gauges and top-trader positioning.
- **On-Chain Metrics:** Integrates Mempool data for active addresses, transaction fees, and hash rate insights.

### 🤖 Autonomous Trading Engine (Autobot)
- **Signal Engine:** Evaluates market conditions (Liquidation Heat, Whale Flows, OI Divergence, Technicals) to generate a dynamic trading score (-1.0 to +1.0).
- **Automated Execution:** Triggers `STRONG BUY` or `STRONG SELL` signals when extreme market conditions are met.
- **Position Lifecycle:** Syncs open Delta BTC positions, blocks duplicate entries, and exits existing positions with reduce-only close orders on manual close or opposite strong signals.
- **Delta Exchange Integration:** Automatically places exact **Maker Limit Orders** at the absolute best bid/ask with pre-configured **20x Leverage**.
- **Risk Management:** 5-minute hard cooldowns between trades, fixed minimal contract sizes, and live Delta execution safeguards.

### 🗄️ Historical Data Persistence
- **MongoDB Atlas Integration:** Stores all historical trades, executed orders, and deep market snapshots for long-term backtesting and UI rendering.

## 🛠️ Tech Stack

- **Frontend:** Next.js 14, React, TypeScript, Vanilla CSS (Glassmorphism & Neon Dark Mode UI)
- **Backend:** Next.js App Router (API Routes), Node.js, WebSockets
- **Database:** MongoDB Atlas
- **APIs Used:** 
  - Delta Exchange India API (Live Trading & Auth)
  - Binance Futures API (Market Data & OI)
  - Mempool.space API (On-Chain Data)
  - Coinglass / Custom WebSocket Streams (Liquidations)

## 🚀 Getting Started

### Prerequisites
- Node.js (v18+)
- MongoDB Atlas Cluster
- Delta Exchange India Account (API Key + Secret with Trading Permissions)

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/vishwamartur/BTC-Market-Dashboard.git
   cd BTC-Market-Dashboard/btcusd-dashboard
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Setup your environment variables by creating a `.env.local` file:
   ```env
   MONGODB_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/?appName=Cluster0
   DELTA_API_KEY=your_delta_exchange_api_key
   DELTA_API_SECRET=your_delta_exchange_api_secret
   DELTA_BASE_URL=https://api.india.delta.exchange
   ```

4. Run the development server:
   ```bash
   npm run dev
   ```

5. Open [http://localhost:3000](http://localhost:3000) in your browser.

## ⚠️ Disclaimer
**This software is for educational purposes only.** Do not risk money which you are afraid to lose. USE THE SOFTWARE AT YOUR OWN RISK. The creators assume no responsibility for your trading results. Live trading can create real financial losses.
