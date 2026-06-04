import WebSocket from 'ws';
import {
  parseBinanceLiquidationEvent,
  parseBybitLiquidationEvent,
  parseOkxLiquidationEvent,
} from './exchanges';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StreamMessage {
  type: 'status' | 'price' | 'liquidation' | 'heartbeat';
  stream?: string;
  source?: string;
  connected?: boolean;
  data?: unknown;
  time?: number;
}

export type StreamSubscriber = (msg: StreamMessage) => void;

/** A parsed liquidation event ready for MongoDB persistence. */
export interface PendingLiquidation {
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// WebSocket Manager (Singleton)
// ---------------------------------------------------------------------------

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const PRICE_THROTTLE_MS = 500;

class WsManager {
  private subscribers = new Set<StreamSubscriber>();
  private sockets: Map<string, WebSocket> = new Map();
  private reconnectAttempts: Map<string, number> = new Map();
  private started = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Liquidation batching
  private pendingLiquidations: PendingLiquidation[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushCallback: ((docs: PendingLiquidation[]) => void) | null = null;

  // Price throttling
  private lastPriceTime = 0;

  /** Register a flush callback for batched liquidation writes. */
  setFlushCallback(cb: (docs: PendingLiquidation[]) => void) {
    this.flushCallback = cb;
  }

  /** Subscribe to the shared message stream. */
  subscribe(fn: StreamSubscriber): () => void {
    this.subscribers.add(fn);
    this.ensureStarted();
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /** Number of active subscribers. */
  get subscriberCount() {
    return this.subscribers.size;
  }

  // -----------------------------------------------------------------------
  // Internal: broadcasting
  // -----------------------------------------------------------------------

  private broadcast(msg: StreamMessage) {
    for (const fn of this.subscribers) {
      try {
        fn(msg);
      } catch {
        // subscriber errors must never crash the manager
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal: WebSocket lifecycle
  // -----------------------------------------------------------------------

  private ensureStarted() {
    if (this.started) return;
    this.started = true;

    console.log('[WsManager] Starting shared WebSocket connections');

    // Heartbeat for SSE keep-alive
    this.heartbeatTimer = setInterval(() => {
      this.broadcast({ type: 'heartbeat', time: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);

    // Liquidation batch flush every 5 seconds
    this.flushTimer = setInterval(() => this.flushLiquidations(), 5000);

    // Connect to all exchanges
    this.connectBinanceLiq();
    this.connectBinanceTrade();
    this.connectBybit();
    this.connectOkx();
  }

  private scheduleReconnect(name: string, connectFn: () => void) {
    const attempts = this.reconnectAttempts.get(name) || 0;
    const delayMs = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempts), RECONNECT_MAX_MS);
    this.reconnectAttempts.set(name, attempts + 1);
    console.log(`[WsManager] Reconnecting ${name} in ${delayMs}ms (attempt ${attempts + 1})`);
    setTimeout(() => connectFn(), delayMs);
  }

  private resetReconnect(name: string) {
    this.reconnectAttempts.set(name, 0);
  }

  // -----------------------------------------------------------------------
  // Binance Liquidations
  // -----------------------------------------------------------------------

  private connectBinanceLiq() {
    const name = 'binance-liq';
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

    try {
      const ws = new WebSocket(
        'wss://fstream.binance.com/market/ws/btcusdt@forceOrder',
        { headers }
      );
      this.sockets.set(name, ws);

      ws.on('open', () => {
        this.resetReconnect(name);
        this.broadcast({ type: 'status', stream: name, connected: true });
      });

      ws.on('message', (raw) => {
        try {
          const parsed = JSON.parse(raw.toString());
          if (parsed.e === 'forceOrder') {
            this.broadcast({ type: 'liquidation', source: 'binance', data: parsed });
            try {
              const liq = parseBinanceLiquidationEvent(parsed);
              this.pendingLiquidations.push({ ...liq, _insertedAt: new Date() } as unknown as PendingLiquidation);
            } catch { /* ignore parse errors */ }
          }
        } catch { /* ignore */ }
      });

      ws.on('close', () => {
        this.broadcast({ type: 'status', stream: name, connected: false });
        this.scheduleReconnect(name, () => this.connectBinanceLiq());
      });

      ws.on('error', () => {}); // swallow — close event handles reconnect
    } catch {
      this.scheduleReconnect(name, () => this.connectBinanceLiq());
    }
  }

  // -----------------------------------------------------------------------
  // Binance Aggregated Trades (Price)
  // -----------------------------------------------------------------------

  private connectBinanceTrade() {
    const name = 'price';
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

    try {
      const ws = new WebSocket(
        'wss://fstream.binance.com/market/ws/btcusdt@aggTrade',
        { headers }
      );
      this.sockets.set(name, ws);

      ws.on('open', () => {
        this.resetReconnect(name);
        this.broadcast({ type: 'status', stream: name, connected: true });
      });

      ws.on('message', (raw) => {
        const now = Date.now();
        if (now - this.lastPriceTime < PRICE_THROTTLE_MS) return;
        this.lastPriceTime = now;
        try {
          const parsed = JSON.parse(raw.toString());
          this.broadcast({ type: 'price', data: parsed });
        } catch { /* ignore */ }
      });

      ws.on('close', () => {
        this.broadcast({ type: 'status', stream: name, connected: false });
        this.scheduleReconnect(name, () => this.connectBinanceTrade());
      });

      ws.on('error', () => {});
    } catch {
      this.scheduleReconnect(name, () => this.connectBinanceTrade());
    }
  }

  // -----------------------------------------------------------------------
  // Bybit Liquidations
  // -----------------------------------------------------------------------

  private connectBybit() {
    const name = 'bybit-liq';

    try {
      const ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');
      this.sockets.set(name, ws);

      ws.on('open', () => {
        this.resetReconnect(name);
        this.broadcast({ type: 'status', stream: name, connected: true });
        ws.send(JSON.stringify({ op: 'subscribe', args: ['allLiquidation.BTCUSDT'] }));
      });

      ws.on('message', (raw) => {
        try {
          const parsed = JSON.parse(raw.toString());
          if (parsed.topic === 'allLiquidation.BTCUSDT') {
            this.broadcast({ type: 'liquidation', source: 'bybit', data: parsed });
            try {
              const liq = parseBybitLiquidationEvent(parsed);
              this.pendingLiquidations.push({ ...liq, _insertedAt: new Date() } as unknown as PendingLiquidation);
            } catch { /* ignore parse errors */ }
          }
        } catch { /* ignore */ }
      });

      ws.on('close', () => {
        this.broadcast({ type: 'status', stream: name, connected: false });
        this.scheduleReconnect(name, () => this.connectBybit());
      });

      ws.on('error', () => {});
    } catch {
      this.scheduleReconnect(name, () => this.connectBybit());
    }
  }

  // -----------------------------------------------------------------------
  // OKX Liquidations
  // -----------------------------------------------------------------------

  private connectOkx() {
    const name = 'okx-liq';

    try {
      const ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
      this.sockets.set(name, ws);

      ws.on('open', () => {
        this.resetReconnect(name);
        this.broadcast({ type: 'status', stream: name, connected: true });
        ws.send(JSON.stringify({
          op: 'subscribe',
          args: [{ channel: 'liquidation-orders', instType: 'SWAP', instId: 'BTC-USDT-SWAP' }],
        }));
      });

      ws.on('message', (raw) => {
        try {
          const parsed = JSON.parse(raw.toString());
          if (parsed.arg && parsed.arg.channel === 'liquidation-orders' && parsed.data) {
            this.broadcast({ type: 'liquidation', source: 'okx', data: parsed });
            try {
              const liqEvents = parseOkxLiquidationEvent(parsed);
              for (const liq of liqEvents) {
                this.pendingLiquidations.push({ ...liq, _insertedAt: new Date() } as unknown as PendingLiquidation);
              }
            } catch { /* ignore parse errors */ }
          }
        } catch { /* ignore */ }
      });

      ws.on('close', () => {
        this.broadcast({ type: 'status', stream: name, connected: false });
        this.scheduleReconnect(name, () => this.connectOkx());
      });

      ws.on('error', () => {});
    } catch {
      this.scheduleReconnect(name, () => this.connectOkx());
    }
  }

  // -----------------------------------------------------------------------
  // Liquidation batching
  // -----------------------------------------------------------------------

  private flushLiquidations() {
    if (this.pendingLiquidations.length === 0) return;
    const batch = this.pendingLiquidations.splice(0);
    if (this.flushCallback) {
      this.flushCallback(batch);
    }
  }

  // -----------------------------------------------------------------------
  // Cleanup (for tests / graceful shutdown)
  // -----------------------------------------------------------------------

  destroy() {
    this.flushLiquidations();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    for (const ws of this.sockets.values()) {
      try { ws.close(); } catch { /* ignore */ }
    }
    this.sockets.clear();
    this.subscribers.clear();
    this.started = false;
  }
}

// ---------------------------------------------------------------------------
// Global singleton (survives Next.js hot reloads)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-namespace
declare global {
  // eslint-disable-next-line no-var
  var _wsManager: WsManager | undefined;
}

export function getWsManager(): WsManager {
  if (!global._wsManager) {
    global._wsManager = new WsManager();
  }
  return global._wsManager;
}
