import { NextResponse } from 'next/server';
import WebSocket from 'ws';
import { insertOneAsync, ensureIndexes } from '../../lib/db';
import {
  parseBinanceLiquidationEvent,
  parseBybitLiquidationEvent,
  parseOkxLiquidationEvent,
} from '../../lib/exchanges';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  // Bootstrap indexes on first connection
  ensureIndexes().catch(() => {});

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let isControllerClosed = false;

      const enqueue = (data: string) => {
        if (isControllerClosed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch {
          isControllerClosed = true;
        }
      };

      // Helper: persist a parsed liquidation event to MongoDB (fire-and-forget)
      const persistLiquidation = (event: Record<string, unknown>) => {
        insertOneAsync('liquidations', { ...event, _insertedAt: new Date() });
      };

      const heartbeat = setInterval(() => {
        enqueue(JSON.stringify({ type: 'heartbeat', time: Date.now() }));
      }, 15000);

      // --- BINANCE ---
      const binanceHeaders = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } };
      const binanceWs = new WebSocket('wss://fstream.binance.com/market/ws/btcusdt@forceOrder', binanceHeaders);
      binanceWs.on('error', () => {}); // swallow unhandled errors
      const binanceTradeWs = new WebSocket('wss://fstream.binance.com/market/ws/btcusdt@aggTrade', binanceHeaders);
      binanceTradeWs.on('error', () => {});
      
      binanceWs.on('open', () => {
        if (isControllerClosed) { try { binanceWs.close(); } catch {} return; }
        enqueue(JSON.stringify({ type: 'status', stream: 'binance-liq', connected: true }));
      });
      binanceWs.on('message', (data) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.e === 'forceOrder') {
            enqueue(JSON.stringify({ type: 'liquidation', source: 'binance', data: parsed }));
            // Persist to MongoDB
            try {
              const liqEvent = parseBinanceLiquidationEvent(parsed);
              persistLiquidation(liqEvent as unknown as Record<string, unknown>);
            } catch { /* ignore parse errors */ }
          }
        } catch (e) { /* ignore */ }
      });
      binanceWs.on('close', () => enqueue(JSON.stringify({ type: 'status', stream: 'binance-liq', connected: false })));

      let lastTradeTime = 0;
      binanceTradeWs.on('open', () => {
        if (isControllerClosed) { try { binanceTradeWs.close(); } catch {} return; }
        enqueue(JSON.stringify({ type: 'status', stream: 'price', connected: true }));
      });
      binanceTradeWs.on('message', (data) => {
        const now = Date.now();
        if (now - lastTradeTime < 500) return;
        lastTradeTime = now;
        try {
          const parsed = JSON.parse(data.toString());
          enqueue(JSON.stringify({ type: 'price', data: parsed }));
        } catch { /* ignore */ }
      });
      binanceTradeWs.on('close', () => enqueue(JSON.stringify({ type: 'status', stream: 'price', connected: false })));

      // --- BYBIT ---
      const bybitWs = new WebSocket('wss://stream.bybit.com/v5/public/linear');
      bybitWs.on('error', () => {});
      bybitWs.on('open', () => {
        if (isControllerClosed) { try { bybitWs.close(); } catch {} return; }
        enqueue(JSON.stringify({ type: 'status', stream: 'bybit-liq', connected: true }));
        bybitWs.send(JSON.stringify({ op: 'subscribe', args: ['allLiquidation.BTCUSDT'] }));
      });
      bybitWs.on('message', (data) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.topic === 'allLiquidation.BTCUSDT') {
            enqueue(JSON.stringify({ type: 'liquidation', source: 'bybit', data: parsed }));
            // Persist to MongoDB
            try {
              const liqEvent = parseBybitLiquidationEvent(parsed);
              persistLiquidation(liqEvent as unknown as Record<string, unknown>);
            } catch { /* ignore parse errors */ }
          }
        } catch (e) { /* ignore */ }
      });
      bybitWs.on('close', () => enqueue(JSON.stringify({ type: 'status', stream: 'bybit-liq', connected: false })));

      // --- OKX ---
      const okxWs = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
      okxWs.on('error', () => {});
      okxWs.on('open', () => {
        if (isControllerClosed) { try { okxWs.close(); } catch {} return; }
        enqueue(JSON.stringify({ type: 'status', stream: 'okx-liq', connected: true }));
        okxWs.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'liquidation-orders', instType: 'SWAP', instId: 'BTC-USDT-SWAP' }] }));
      });
      okxWs.on('message', (data) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.arg && parsed.arg.channel === 'liquidation-orders' && parsed.data) {
            enqueue(JSON.stringify({ type: 'liquidation', source: 'okx', data: parsed }));
            // Persist to MongoDB
            try {
              const liqEvents = parseOkxLiquidationEvent(parsed);
              for (const liqEvent of liqEvents) {
                persistLiquidation(liqEvent as unknown as Record<string, unknown>);
              }
            } catch { /* ignore parse errors */ }
          }
        } catch (e) { /* ignore */ }
      });
      okxWs.on('close', () => enqueue(JSON.stringify({ type: 'status', stream: 'okx-liq', connected: false })));

      // Cleanup
      const safeClose = (ws: WebSocket) => {
        try {
          if (ws.readyState === 1) { // WebSocket.OPEN
            ws.close();
          }
        } catch {}
      };

      const cleanup = () => {
        isControllerClosed = true;
        clearInterval(heartbeat);
        safeClose(binanceWs);
        safeClose(binanceTradeWs);
        safeClose(bybitWs);
        safeClose(okxWs);
      };

      request.signal.addEventListener('abort', cleanup);
    },
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
