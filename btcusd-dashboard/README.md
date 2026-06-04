# 🚀 BTC Market & Liquidation Dashboard

A state-of-the-art, real-time Bitcoin market dashboard and autonomous trading bot built with Next.js 14/15 App Router. 

This application aggregates massive streams of live data across multiple cryptocurrency exchanges, processes on-chain blockchain metrics, generates an algorithmic trading signal, and executes automated trades using a highly polished, premium glassmorphism UI.

---

## ✨ Features

### 1. ⚡ Live Liquidation Engine
- **Multi-Exchange Websockets**: Connects simultaneously to Binance, Bybit, and OKX WebSocket feeds.
- **Real-Time Feed**: Instantly displays massive liquidations the millisecond they occur.
- **Aggregated Analytics**: Tracks total USD liquidations by side (Long vs Short) and isolates the largest rekt positions.
- **Whale Tracker**: Flags and visually emphasizes massive liquidation events > $100,000 USD.

### 2. 📊 On-Chain & Market Data
- **Global Long/Short Ratio**: Fetched from Binance Futures to gauge overall market bias.
- **Open Interest**: Live tracking of open Bitcoin contracts.
- **Mempool & Hashrate**: Integrates with `Mempool.space` and `Blockchain.info` APIs to track Bitcoin network congestion, fastest transaction fees, block heights, and network hashrate.
- **Whale Transactions**: Real-time alerts for unconfirmed large BTC movements across the blockchain.

### 3. 🤖 Algorithmic Signal Engine
- Uses a multi-factor weighting system to generate a `STRONG SELL`, `SELL`, `NEUTRAL`, `BUY`, or `STRONG BUY` signal.
- **Scoring Components**:
  - *Liquidation Pressure*: Analyzes immediate long/short squeeze imbalances.
  - *Long/Short Bias*: Evaluates top trader positioning vs retail positioning.
  - *On-Chain Activity*: Looks at network congestion and whale activity to predict volatility.
- **Visual Gauge**: Premium animated progress bar showing the live algorithm score.

### 4. ⚙️ Autonomous Trading Integration
- **Delta Exchange Integration**: Uses secure server-side Node.js native `crypto` HMAC-SHA256 request signing.
- **Auto-Trader UI**: Toggle the bot on or off directly from the dashboard.
- **Paper Trading vs Live**: Toggle simulation mode to test the engine safely, or switch to Live mode to execute real trades on Delta Exchange.
- **Safety Limits**: Default configuration executes minimum allowable contract sizes (1 contract) with a built-in 5-minute cooldown between trades.

### 5. 💎 Premium UI/UX Design
- **True Glassmorphism**: Cards feature deep blur overlays `backdrop-filter: blur(24px) saturate(150%)` simulating physical translucent glass over the background.
- **Ambient Mesh Background**: A beautiful, slow-moving particle/mesh gradient floating in the background.
- **Dynamic Glows**: Vibrant neon color palette with drop-shadow glows to emphasize critical data.
- **Micro-Animations**: Cards elevate on hover, liquidations smoothly slide in, and connection badges organically pulse.

---

## 🛠️ Tech Stack

- **Framework**: [Next.js](https://nextjs.org) (App Router)
- **Language**: TypeScript
- **Styling**: Pure CSS (`globals.css`) with CSS Variables & advanced animations
- **Data Fetching**: Native `fetch` with Next.js caching + Native Node.js `ws` (WebSockets)
- **Cryptography**: Node's built-in `crypto` for API signatures

---

## 🚀 Getting Started

### 1. Prerequisites
Ensure you have Node.js 18.17+ installed.

### 2. Environment Variables
If you intend to use the Live Auto-Trader, you must securely provide your Delta Exchange API credentials. While currently hardcoded safely for immediate local testing, you should move them to a `.env.local` file:
```env
DELTA_API_KEY=your_api_key_here
DELTA_API_SECRET=your_api_secret_here
```

### 3. Installation
```bash
npm install
# or
yarn install
# or
pnpm install
```

### 4. Start the Development Server
```bash
npm run dev
# or
yarn dev
# or
pnpm dev
```
Open [http://localhost:3000](http://localhost:3000) with your browser to see the result. The websockets will connect automatically.

---

## ⚠️ Disclaimer
**This software is for educational purposes only.** The autonomous trading functionality executes real financial trades. Use the "LIVE TRADING" feature entirely at your own risk. The creators assume no liability for financial losses incurred. Always use "PAPER TRADING" to test algorithms.
