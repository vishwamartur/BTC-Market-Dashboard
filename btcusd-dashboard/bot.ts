import WebSocket from 'ws';
import { MongoClient, Db } from 'mongodb';
import { generateTradingSignal, SignalInputs } from './app/lib/signals';
import { placeDeltaOrder, setDeltaLeverage } from './app/lib/delta';
import { parseBinanceLiquidationEvent, parseBybitLiquidationEvent, parseOkxLiquidationEvent } from './app/lib/exchanges';
import { fetchMempoolStats, fetchMempoolFees, fetchHashrate, MempoolStats, MempoolFees, HashrateData } from './app/lib/mempool';
import { fetchUnconfirmedTransactions, classifyWhaleTransaction, WhaleTransaction } from './app/lib/blockchain';

// Load environment variables directly if running locally (node --env-file=.env.local bot.ts)
// In production, these should be set in your VPS environment
const MONGODB_URI = process.env.MONGODB_URI || '';
const DELTA_API_KEY = process.env.DELTA_API_KEY || '';
const DELTA_API_SECRET = process.env.DELTA_API_SECRET || '';

if (!MONGODB_URI || !DELTA_API_KEY || !DELTA_API_SECRET) {
  console.warn('⚠️ Missing crucial environment variables (MONGODB_URI, DELTA_API_KEY, DELTA_API_SECRET)');
}

const DB_NAME = 'btcusd';
const BTCUSDT_PRODUCT_ID = 27;
const LEVERAGE = 20;
const COOLDOWN_MS = 60000 * 5; // 5 minutes cooldown
const TICK_RATE_MS = 15000; // Check signals every 15s

let db: Db;
let mongoClient: MongoClient;

// Bot State
let lastTradeTime = 0;
let isExecuting = false;

// Market State (In-Memory)
const state = {
  liquidationStats: {
    totalLongLiquidations: 0,
    totalShortLiquidations: 0,
    totalLongUsd: 0,
    totalShortUsd: 0,
    largestLiquidation: null as any,
  },
  longShortRatio: null as number | null,
  mempoolTxCount: null as number | null,
  fastestFee: null as number | null,
  whaleTransactions: [] as WhaleTransaction[],
  hashrateData: null as HashrateData | null,
  price: 0,
};

async function initDB() {
  console.log('🔌 Connecting to MongoDB...');
  mongoClient = new MongoClient(MONGODB_URI, { maxPoolSize: 10 });
  await mongoClient.connect();
  db = mongoClient.db(DB_NAME);
  console.log('✅ Connected to MongoDB');
}

// --- DATA INGESTION ---

function startWebSockets() {
  console.log('📡 Starting WebSocket Listeners...');

  // Binance
  const binanceWs = new WebSocket('wss://fstream.binance.com/market/ws/btcusdt@forceOrder');
  binanceWs.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.e === 'forceOrder') {
        const liqEvent = parseBinanceLiquidationEvent(parsed);
        processLiquidation(liqEvent);
        db.collection('liquidations').insertOne({ ...liqEvent, _insertedAt: new Date() }).catch(() => {});
      }
    } catch (e) {}
  });

  const binanceTradeWs = new WebSocket('wss://fstream.binance.com/market/ws/btcusdt@aggTrade');
  binanceTradeWs.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.p) state.price = parseFloat(parsed.p);
    } catch (e) {}
  });

  // Bybit
  const bybitWs = new WebSocket('wss://stream.bybit.com/v5/public/linear');
  bybitWs.on('open', () => {
    bybitWs.send(JSON.stringify({ op: 'subscribe', args: ['allLiquidation.BTCUSDT'] }));
  });
  bybitWs.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.topic === 'allLiquidation.BTCUSDT') {
        const liqEvent = parseBybitLiquidationEvent(parsed);
        processLiquidation(liqEvent);
        db.collection('liquidations').insertOne({ ...liqEvent, _insertedAt: new Date() }).catch(() => {});
      }
    } catch (e) {}
  });

  function processLiquidation(event: any) {
    if (!event) return;
    const isLong = event.side === 'SELL';
    if (isLong) {
      state.liquidationStats.totalLongLiquidations++;
      state.liquidationStats.totalLongUsd += event.usdValue;
    } else {
      state.liquidationStats.totalShortLiquidations++;
      state.liquidationStats.totalShortUsd += event.usdValue;
    }
  }

  // Reconnect logic
  binanceWs.on('close', () => setTimeout(startWebSockets, 5000));
}

async function fetchMarketData() {
  try {
    const lsRatioRes = await fetch('https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=1');
    const lsRatio = await lsRatioRes.json();
    if (Array.isArray(lsRatio) && lsRatio.length > 0) {
      state.longShortRatio = parseFloat(lsRatio[lsRatio.length - 1].longShortRatio);
    }

    const mempoolStats = await fetchMempoolStats();
    state.mempoolTxCount = mempoolStats.count;

    const mempoolFees = await fetchMempoolFees();
    state.fastestFee = mempoolFees.fastestFee;

    const hashrate = await fetchHashrate();
    state.hashrateData = hashrate;

    const txs = await fetchUnconfirmedTransactions();
    if (txs.txs && state.price > 0) {
      const whales: WhaleTransaction[] = [];
      for (const tx of txs.txs) {
        const whaleTx = classifyWhaleTransaction(tx, state.price);
        if (whaleTx) whales.push(whaleTx);
      }
      state.whaleTransactions = whales;
    }

  } catch (err: any) {
    console.error('⚠️ Failed to fetch market data:', err.message);
  }
}

// --- TRADING LOGIC ---

async function checkAndExecuteTrade() {
  if (isExecuting) return;

  // 1. Check if Bot is enabled in DB
  const settings = await db.collection<{ _id: string, isEnabled: boolean, isPaperTrade: boolean }>('settings').findOne({ _id: 'botConfig' });
  const isEnabled = settings?.isEnabled ?? false; // Default off for safety
  const isPaperTrade = settings?.isPaperTrade ?? true;

  if (!isEnabled) return;

  // 2. Check Cooldown
  const now = Date.now();
  if (now - lastTradeTime < COOLDOWN_MS) return;

  // 3. Compute Signal
  let hashrateTrend: 'UP' | 'DOWN' | 'FLAT' | null = null;
  if (state.hashrateData && state.hashrateData.hashrates.length >= 2) {
    const recent = state.hashrateData.hashrates[state.hashrateData.hashrates.length - 1].avgHashrate;
    const prev = state.hashrateData.hashrates[state.hashrateData.hashrates.length - 2].avgHashrate;
    if (recent > prev * 1.02) hashrateTrend = 'UP';
    else if (recent < prev * 0.98) hashrateTrend = 'DOWN';
    else hashrateTrend = 'FLAT';
  }

  const inputs: SignalInputs = {
    liquidationStats: state.liquidationStats,
    longShortRatio: state.longShortRatio,
    mempoolTxCount: state.mempoolTxCount,
    fastestFee: state.fastestFee,
    whaleTransactions: state.whaleTransactions,
    hashrateTrend,
  };

  const signal = generateTradingSignal(inputs);
  
  let action: 'BUY' | 'SELL' | null = null;
  if (signal.overallSignal === 'STRONG BUY') action = 'BUY';
  else if (signal.overallSignal === 'STRONG SELL') action = 'SELL';

  if (action) {
    console.log(`\n🚀 [SIGNAL TRIGGERED] Action: ${action} | Score: ${signal.score}`);
    await executeTrade(action, signal.score, isPaperTrade);
  }
}

async function executeTrade(action: 'BUY' | 'SELL', score: number, isPaperTrade: boolean) {
  isExecuting = true;
  lastTradeTime = Date.now();
  const side = action === 'BUY' ? 'buy' : 'sell';
  const size = 1;

  console.log(`[TRADE] ${isPaperTrade ? 'PAPER' : 'REAL'} ${action} ${size} Contract(s)`);

  try {
    if (isPaperTrade) {
      await db.collection('trades').insertOne({
        timestamp: new Date(),
        action,
        side,
        size,
        isPaperTrade: true,
        status: 'SUCCESS',
        orderId: `paper_${Date.now()}`,
        productId: BTCUSDT_PRODUCT_ID,
      });
      console.log('✅ Paper trade saved');
      return;
    }

    // Real Trade Logic
    await setDeltaLeverage(DELTA_API_KEY, DELTA_API_SECRET, BTCUSDT_PRODUCT_ID, LEVERAGE);
    
    // Fetch Best Price
    let limitPrice: string | undefined;
    const tickerRes = await fetch('https://api.india.delta.exchange/v2/tickers/BTCUSD');
    const tickerData = await tickerRes.json();
    if (tickerData.success) {
      limitPrice = side === 'buy' ? tickerData.result.quotes.best_bid : tickerData.result.quotes.best_ask;
    }

    if (!limitPrice) throw new Error('Could not determine limit price');

    const result = await placeDeltaOrder(
      DELTA_API_KEY,
      DELTA_API_SECRET,
      BTCUSDT_PRODUCT_ID,
      size,
      side,
      'limit',
      limitPrice
    );

    if (result.success) {
      console.log('✅ Real Trade Filled:', result.result?.id);
      await db.collection('trades').insertOne({
        timestamp: new Date(),
        action,
        side,
        size,
        isPaperTrade: false,
        status: 'SUCCESS',
        orderId: result.result?.id,
        productId: BTCUSDT_PRODUCT_ID,
      });
    } else {
      throw new Error(result.error?.message || 'Exchange rejected order');
    }

  } catch (error: any) {
    console.error('❌ Trade execution failed:', error.message);
    await db.collection('trades').insertOne({
      timestamp: new Date(),
      action,
      side,
      size,
      isPaperTrade,
      status: 'FAILED',
      error: error.message,
      productId: BTCUSDT_PRODUCT_ID,
    });
  } finally {
    isExecuting = false;
  }
}

// --- MAIN LOOP ---

async function main() {
  console.log('=== Starting BTC Autonomous Trading Bot ===');
  await initDB();
  
  // Set default settings if not exists
  const settings = await db.collection<{ _id: string, isEnabled: boolean, isPaperTrade: boolean }>('settings').findOne({ _id: 'botConfig' });
  if (!settings) {
    await db.collection<{ _id: string, isEnabled: boolean, isPaperTrade: boolean }>('settings').insertOne({
      _id: 'botConfig',
      isEnabled: false,
      isPaperTrade: true
    });
  }

  startWebSockets();

  // Tick loop
  setInterval(async () => {
    await fetchMarketData();
    await checkAndExecuteTrade();
  }, TICK_RATE_MS);

  console.log(`🤖 Bot is running. Checking signals every ${TICK_RATE_MS/1000}s`);
}

main().catch(console.error);
