/**
 * Long-lived process for a non-serverless host (for example Railway, Render,
 * or a container service). It owns WebSocket ingestion and writes the latest
 * durable signal state to MongoDB for the Next.js dashboard to read.
 */

import { getSignalEngine } from '../app/lib/signalEngine';

async function main() {
  const engine = getSignalEngine();
  await engine.initialize();
  console.log('[SignalWorker] Ready — publishing durable signal state');

  const shutdown = (signal: NodeJS.Signals) => {
    console.log(`[SignalWorker] ${signal} received; stopping`);
    engine.destroy();
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

void main().catch((error) => {
  console.error('[SignalWorker] Fatal startup error:', error);
  process.exitCode = 1;
});
