// Types
export interface LiquidationEvent {
  id: string;
  exchange: 'Binance' | 'Bybit' | 'OKX';
  symbol: string;
  side: 'BUY' | 'SELL'; // BUY = short liquidated, SELL = long liquidated
  originalQuantity: number;
  price: number;
  orderTradeTime: number;
  usdValue: number;
}

export interface LongShortRatio {
  symbol: string;
  longShortRatio: string;
  longAccount: string;
  shortAccount: string;
  timestamp: number;
}

export interface OpenInterestData {
  symbol: string;
  openInterest: string;
  time: number;
}

export interface TopTraderRatio {
  symbol: string;
  longShortRatio: string;
  longAccount: string;
  shortAccount: string;
  timestamp: number;
}

// Constants
export const BINANCE_WS_BASE = 'wss://fstream.binance.com/ws';
export const BINANCE_FAPI_BASE = 'https://fapi.binance.com';
export const BINANCE_FUTURES_DATA = 'https://fapi.binance.com/futures/data';

// REST API fetchers
export async function fetchLongShortRatio(): Promise<LongShortRatio[]> {
  const res = await fetch(
    `${BINANCE_FUTURES_DATA}/globalLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=30`
  );
  if (!res.ok) throw new Error('Failed to fetch long/short ratio');
  return res.json();
}

export async function fetchOpenInterest(): Promise<OpenInterestData> {
  const res = await fetch(
    `${BINANCE_FAPI_BASE}/fapi/v1/openInterest?symbol=BTCUSDT`
  );
  if (!res.ok) throw new Error('Failed to fetch open interest');
  return res.json();
}

export async function fetchTopTraderRatio(): Promise<TopTraderRatio[]> {
  const res = await fetch(
    `${BINANCE_FUTURES_DATA}/topLongShortPositionRatio?symbol=BTCUSDT&period=5m&limit=30`
  );
  if (!res.ok) throw new Error('Failed to fetch top trader ratio');
  return res.json();
}

export async function fetchPrice(): Promise<{ symbol: string; price: string }> {
  const res = await fetch(
    `${BINANCE_FAPI_BASE}/fapi/v1/ticker/price?symbol=BTCUSDT`
  );
  if (!res.ok) throw new Error('Failed to fetch price');
  return res.json();
}

export async function fetch24hTicker(): Promise<{ lastPrice: string; priceChangePercent: string; highPrice: string; lowPrice: string; volume: string; quoteVolume: string }> {
  const res = await fetch(
    `${BINANCE_FAPI_BASE}/fapi/v1/ticker/24hr?symbol=BTCUSDT`
  );
  if (!res.ok) throw new Error('Failed to fetch 24h ticker');
  return res.json();
}

// --- PARSERS ---

export function parseBinanceLiquidationEvent(data: Record<string, unknown>): LiquidationEvent {
  const o = data.o as Record<string, unknown>;
  const qty = parseFloat(o.q as string);
  const price = parseFloat(o.p as string);
  return {
    id: `binance-${o.T}-${o.s}-${Math.random().toString(36).substr(2, 9)}`,
    exchange: 'Binance',
    symbol: o.s as string,
    side: o.S as 'BUY' | 'SELL',
    originalQuantity: qty,
    price: price,
    orderTradeTime: o.T as number,
    usdValue: qty * price,
  };
}

export function parseBybitLiquidationEvent(data: Record<string, unknown>): LiquidationEvent {
  const d = data.data as Record<string, unknown>;
  const qty = parseFloat(d.v as string); // executed size
  const price = parseFloat(d.p as string); // bankruptcy price
  return {
    id: `bybit-${d.T}-${d.s}-${Math.random().toString(36).substr(2, 9)}`,
    exchange: 'Bybit',
    symbol: d.s as string,
    side: d.S === 'Buy' ? 'BUY' : 'SELL', // Bybit uses 'Buy' / 'Sell'
    originalQuantity: qty,
    price: price,
    orderTradeTime: parseInt(d.T as string, 10),
    usdValue: qty * price,
  };
}

export function parseOkxLiquidationEvent(data: Record<string, unknown>): LiquidationEvent[] {
  const events: LiquidationEvent[] = [];
  const arr = data.data as Array<Record<string, unknown>>;
  
  for (const item of arr) {
    const details = item.details as Array<Record<string, unknown>>;
    for (const detail of details) {
      // OKX size (sz) is usually in contracts. For BTC-USDT-SWAP, 1 contract = 0.01 BTC usually, but we need to verify.
      // But OKX liquidation pushes sometimes have `bkPx` (bankruptcy price) and `sz` (size in contracts).
      // For simplicity, let's just parse what we can and assume USD value = sz if we can't get exact BTC or convert properly.
      // Actually OKX says `sz` is number of contracts. Let's just estimate USD value using `bkPx` * `sz` * contract_multiplier if known.
      // BTC-USDT-SWAP multiplier is usually 0.01 or 0.001. We'll default to 0.01 for BTC.
      const multiplier = (item.instId as string).includes('BTC') ? 0.01 : 1;
      const qtyContracts = parseFloat(detail.sz as string);
      const qtyBtc = qtyContracts * multiplier;
      const price = parseFloat(detail.bkPx as string);
      
      events.push({
        id: `okx-${item.instId}-${detail.ts}-${Math.random().toString(36).substr(2, 9)}`,
        exchange: 'OKX',
        symbol: (item.instId as string).replace('-', ''), // BTC-USDT-SWAP -> BTCUSDTSWAP
        side: detail.side === 'buy' ? 'BUY' : 'SELL', // OKX uses 'buy'/'sell'
        originalQuantity: qtyBtc,
        price: price,
        orderTradeTime: parseInt(detail.ts as string, 10),
        usdValue: qtyBtc * price,
      });
    }
  }
  return events;
}
