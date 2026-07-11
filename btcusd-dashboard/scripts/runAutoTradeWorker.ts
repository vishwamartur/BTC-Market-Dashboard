/**
 * Durable auto-trading loop. Run this alongside `signal-worker` on an
 * always-on Node host; browser tabs only control its Mongo-backed setting.
 */

import { getAutoTraderConfig, recordSignalEvaluation, recordWorkerHeartbeat } from '../app/lib/autotraderConfig';
import { getDeltaPositions } from '../app/lib/delta';
import { normalizeDeltaPosition } from '../app/lib/positions';
import { refreshSignalDataQuality } from '../app/lib/signalQuality';
import { readSignalState } from '../app/lib/signalState';

const TICK_MS = 5000;
const BTCUSD_PRODUCT_ID = 27;
const DASHBOARD_URL = (process.env.DASHBOARD_URL || process.env.TRADING_ALLOWED_ORIGIN || '').replace(/\/$/, '');
const WORKER_ORIGIN = process.env.TRADING_ALLOWED_ORIGIN || DASHBOARD_URL;
const DELTA_API_KEY = process.env.DELTA_API_KEY || '';
const DELTA_API_SECRET = process.env.DELTA_API_SECRET || '';

function actionForSignal(overallSignal: string): 'BUY' | 'SELL' | null {
  if (overallSignal === 'STRONG BUY') return 'BUY';
  if (overallSignal === 'STRONG SELL') return 'SELL';
  return null;
}

async function requestTrade(action: 'BUY' | 'SELL' | 'CLOSE_POSITION', requestId: string, reason: string) {
  const response = await fetch(`${DASHBOARD_URL}/api/trade`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: WORKER_ORIGIN,
    },
    body: JSON.stringify({ action, requestId, reason }),
  });
  const data = await response.json().catch(() => null) as { error?: unknown } | null;
  if (!response.ok && response.status !== 409) {
    console.warn(`[AutoTradeWorker] ${action} rejected (${response.status}):`, data?.error ?? 'unknown error');
  }
}

async function tick() {
  await recordWorkerHeartbeat();
  const config = await getAutoTraderConfig();
  if (!config?.enabled) return;
  if (!DASHBOARD_URL || !WORKER_ORIGIN || !DELTA_API_KEY || !DELTA_API_SECRET) {
    console.warn('[AutoTradeWorker] Missing DASHBOARD_URL/TRADING_ALLOWED_ORIGIN or Delta credentials; execution paused');
    return;
  }

  const state = await readSignalState();
  if (!state || Date.now() - state.computedAt > 15_000) return;
  const evaluation = await recordSignalEvaluation(state.latestSignal.timestamp, state.latestSignal.overallSignal);
  if (!evaluation?.enabled) return;
  const quality = refreshSignalDataQuality(state.latestSignal.dataQuality);
  if (!quality?.isReady || (state.latestSignal.confluenceCount ?? 0) < 3) return;

  const action = actionForSignal(state.latestSignal.overallSignal);
  if (!action) return;
  if (evaluation.consecutiveSignalCount < 3) return;

  const positions = await getDeltaPositions(DELTA_API_KEY, DELTA_API_SECRET, BTCUSD_PRODUCT_ID);
  if (!positions.success) {
    console.warn('[AutoTradeWorker] Could not verify the current Delta position');
    return;
  }
  const position = normalizeDeltaPosition(positions.result, BTCUSD_PRODUCT_ID);
  const requestId = `worker-${state.latestSignal.timestamp}-${action}`;

  if (position) {
    const isOpposite = (position.side === 'LONG' && action === 'SELL')
      || (position.side === 'SHORT' && action === 'BUY');
    if (isOpposite) {
      await requestTrade('CLOSE_POSITION', requestId, `Opposite ${state.latestSignal.overallSignal} signal`);
    }
    return;
  }

  await requestTrade(action, requestId, `Worker signal ${state.latestSignal.overallSignal}`);
}

async function main() {
  if (!DASHBOARD_URL) {
    console.error('[AutoTradeWorker] DASHBOARD_URL is required');
    process.exitCode = 1;
    return;
  }

  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (error) {
      console.error('[AutoTradeWorker] Tick failed:', error);
    } finally {
      running = false;
    }
  };

  await run();
  const interval = setInterval(() => { void run(); }, TICK_MS);
  const shutdown = (signal: NodeJS.Signals) => {
    clearInterval(interval);
    console.log(`[AutoTradeWorker] ${signal} received; stopping`);
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  console.log('[AutoTradeWorker] Ready');
}

void main();
