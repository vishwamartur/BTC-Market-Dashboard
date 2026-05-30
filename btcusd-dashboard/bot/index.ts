import WebSocket from 'ws';
import { getDb, insertOneAsync, ensureIndexes } from '../app/lib/db';
import { placeDeltaOrder, setDeltaLeverage } from '../app/lib/delta';
import { fetchMempoolStats, fetchMempoolFees, fetchHashrate } from '../app/lib/mempool';
import { fetchUnconfirmedTransactions, classifyWhaleTransaction } from '../app/lib/blockchain';
import { generateTradingSignal, type SignalResult, type SignalInputs } from '../app/lib/signals';
import { parseBinanceLiquidationEvent, parseBybitLiquidationEvent, parseOkxLiquidationEvent } from '../app/lib/exchanges';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

// Configuration
const COOLDOWN_MS = 60000 * 5; // 5 mins
const BTCUSDT_PRODUCT_ID = 27;
const LEVERAGE = 20;
const BINANCE_FAPI = 'https://fapi.binance.com';

// State
let lastTradeTime = 0;
let isExecuting = false;
let currentPrice = 0;
let liquidationStats = {
  totalLongLiquidations: 0,
  totalShortLiquidations: 0,
  totalLongUsd: 0,
  totalShortUsd: 0,
  largestLiquidation: null as any,
};

let mempoolTxCount: number | null = null;
let fastestFee: number | null = null;
let hashrateTrend: 'UP' | 'DOWN' | 'FLAT' | null = null;
let whaleTransactions: any[] = [];
let longShortRatio: number | null = null;

async function fetchMarketData() {
  try {
    const lsRatioRes = await fetch(`${BINANCE_FAPI}/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=1`);
    if (lsRatioRes.ok) {
      const data = await lsRatioRes.json();
      if (Array.isArray(data) && data.length > 0) {
        longShortRatio = parseFloat(data[data.length - 1].longShortRatio);
      }
    }
  } catch (err) {
    console.error('[Bot] Market data fetch error:', err);
  }
}

async function fetchOnChainData() {
  try {
    const stats = await fetchMempoolStats();
    if (stats) mempoolTxCount = stats.count;

    const fees = await fetchMempoolFees();
    if (fees) fastestFee = fees.fastestFee;

    const hashrateData = await fetchHashrate();
    if (hashrateData && hashrateData.hashrates.length >= 2) {
      const recent = hashrateData.hashrates[hashrateData.hashrates.length - 1].avgHashrate;
      const prev = hashrateData.hashrates[hashrateData.hashrates.length - 2].avgHashrate;
      if (recent > prev * 1.02) hashrateTrend = 'UP';
      else if (recent < prev * 0.98) hashrateTrend = 'DOWN';
      else hashrateTrend = 'FLAT';
    }

    const unconfirmedTxs = await fetchUnconfirmedTransactions();
    if (unconfirmedTxs && unconfirmedTxs.txs && currentPrice > 0) {
      const db = await getDb();
      const collection = db.collection('whale_transactions');
      
      const newWhales = [];
      for (const tx of unconfirmedTxs.txs) {
        const whaleTx = classifyWhaleTransaction(tx, currentPrice);
        if (whaleTx) {
          newWhales.push(whaleTx);
          await collection.updateOne(
            { hash: whaleTx.hash },
            { $setOnInsert: { ...whaleTx, _insertedAt: new Date() } },
            { upsert: true }
          ).catch(() => {});
        }
      }
      // Keep only recent whales in memory for signal processing
      whaleTransactions = [...newWhales, ...whaleTransactions].slice(0, 100);
    }
  } catch (err) {
    console.error('[Bot] OnChain data fetch error:', err);
  }
}

async function evaluateSignal() {
  const inputs: SignalInputs = {
    liquidationStats,
    longShortRatio,
    mempoolTxCount,
    fastestFee,
    whaleTransactions,
    hashrateTrend,
  };

  const signal = generateTradingSignal(inputs);
  console.log(`[Bot] Evaluated Signal: ${signal.overallSignal} (Score: ${signal.score.toFixed(2)})`);

  let action: 'BUY' | 'SELL' | null = null;
  if (signal.overallSignal === 'STRONG BUY') {
    action = 'BUY';
  } else if (signal.overallSignal === 'STRONG SELL') {
    action = 'SELL';
  }

  if (action) {
    await executeTrade(action, signal.score);
  }
}

async function executeTrade(action: 'BUY' | 'SELL', signalScore: number) {
  if (isExecuting) return;
  const now = Date.now();
  if (now - lastTradeTime < COOLDOWN_MS) {
    console.log('[Bot] Skipping trade due to cooldown.');
    return;
  }

  isExecuting = true;
  lastTradeTime = now;
  const side = action === 'BUY' ? 'buy' : 'sell';

  try {
    const db = await getDb();
    const settingsDoc = await db.collection('bot_settings').findOne({ _id: 'config' });
    const isEnabled = settingsDoc?.isEnabled ?? false;
    const isPaperTrade = settingsDoc?.isPaperTrade ?? true;

    if (!isEnabled) {
      console.log(`[Bot] Skipping trade (${action}): Bot is globally disabled.`);
      isExecuting = false;
      return;
    }

    if (isPaperTrade) {
      console.log(`[Bot] [PAPER TRADE] ${action} executed.`);
      insertOneAsync('trades', {
        timestamp: new Date(),
        action,
        side,
        size: 1,
        isPaperTrade: true,
        status: 'SUCCESS',
        orderId: Math.floor(Math.random() * 1000000),
        productId: BTCUSDT_PRODUCT_ID,
      });
      isExecuting = false;
      return;
    }

    console.log(`[Bot] [REAL TRADE] Preparing ${action}...`);
    const DELTA_API_KEY = process.env.DELTA_API_KEY || '';
    const DELTA_API_SECRET = process.env.DELTA_API_SECRET || '';

    if (!DELTA_API_KEY || !DELTA_API_SECRET) {
      console.error('[Bot] Missing Delta API credentials');
      isExecuting = false;
      return;
    }

    await setDeltaLeverage(DELTA_API_KEY, DELTA_API_SECRET, BTCUSDT_PRODUCT_ID, LEVERAGE);

    let limitPrice: string | undefined;
    const tickerRes = await fetch('https://api.india.delta.exchange/v2/tickers/BTCUSD');
    const tickerData = await tickerRes.json();
    if (tickerData.success) {
      limitPrice = side === 'buy' ? tickerData.result.quotes.best_bid : tickerData.result.quotes.best_ask;
    }

    if (!limitPrice) throw new Error('Could not determine limit price');

    const result = await placeDeltaOrder(DELTA_API_KEY, DELTA_API_SECRET, BTCUSDT_PRODUCT_ID, 1, side, 'limit', limitPrice);

    if (result.success) {
      console.log(`[Bot] [REAL TRADE] Success! Order ID: ${result.result?.id}`);
      insertOneAsync('trades', {
        timestamp: new Date(),
        action, side, size: 1,
        isPaperTrade: false, status: 'SUCCESS',
        orderId: result.result?.id, productId: BTCUSDT_PRODUCT_ID, rawResult: result.result,
      });
    } else {
      console.error(`[Bot] [REAL TRADE] Failed:`, result.error);
      insertOneAsync('trades', {
        timestamp: new Date(), action, side, size: 1,
        isPaperTrade: false, status: 'FAILED',
        error: result.error, productId: BTCUSDT_PRODUCT_ID,
      });
    }
  } catch (error: any) {
    console.error(`[Bot] Execute trade error:`, error);
  } finally {
    isExecuting = false;
  }
}

function processLiquidation(liqEvent: any) {
  const isLong = liqEvent.side === 'SELL';
  if (isLong) {
    liquidationStats.totalLongLiquidations++;
    liquidationStats.totalLongUsd += liqEvent.usdValue;
  } else {
    liquidationStats.totalShortLiquidations++;
    liquidationStats.totalShortUsd += liqEvent.usdValue;
  }
  if (!liquidationStats.largestLiquidation || liqEvent.usdValue > liquidationStats.largestLiquidation.usdValue) {
    liquidationStats.largestLiquidation = liqEvent;
  }
  insertOneAsync('liquidations', { ...liqEvent, _insertedAt: new Date() });
}

function startWebSockets() {
  const binanceWs = new WebSocket('wss://fstream.binance.com/market/ws/btcusdt@forceOrder');
  binanceWs.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.e === 'forceOrder') {
        processLiquidation(parseBinanceLiquidationEvent(parsed));
      }
    } catch {}
  });

  const bybitWs = new WebSocket('wss://stream.bybit.com/v5/public/linear');
  bybitWs.on('open', () => bybitWs.send(JSON.stringify({ op: 'subscribe', args: ['allLiquidation.BTCUSDT'] })));
  bybitWs.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.topic === 'allLiquidation.BTCUSDT') {
        processLiquidation(parseBybitLiquidationEvent(parsed));
      }
    } catch {}
  });

  const binanceTradeWs = new WebSocket('wss://fstream.binance.com/market/ws/btcusdt@aggTrade');
  binanceTradeWs.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.p) currentPrice = parseFloat(parsed.p);
    } catch {}
  });
}

async function startBot() {
  console.log('[Bot] Starting Background Trading Bot...');
  await ensureIndexes();
  startWebSockets();
  
  setInterval(fetchMarketData, 15000);
  setInterval(fetchOnChainData, 30000);
  setInterval(evaluateSignal, 15000);

  // Initial fetch
  fetchMarketData();
  fetchOnChainData();
}

startBot();
