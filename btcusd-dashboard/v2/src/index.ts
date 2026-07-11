/**
 * BTCUSD V2 Trading Bot — Entry Point
 *
 * This file is intentionally minimal. It bootstraps config, creates
 * initial state, and runs the tick loop. All trading logic lives in
 * the orchestrator and strategy modules.
 *
 * Architecture:
 *   index.ts → orchestrator.ts → strategies/*.ts
 *                               → optionsManager.ts
 *                               → riskManager.ts
 *                               → positionService.ts
 *                               → delta.ts
 */

import { loadConfig } from './config/index.js';
import { createInitialState } from './state.js';
import { runTick } from './orchestrator.js';
import { logger } from './logger.js';

const TICK_INTERVAL_MS = 15_000; // 15 seconds between ticks

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const config = loadConfig(process.env);
  let state = createInitialState();

  logger.info('v2 bot starting');

  if (config.BOT_DISABLED) {
    logger.info('Bot is disabled in config (BOT_DISABLED=true)');
    return;
  }

  while (true) {
    try {
      state = await runTick(config, state);
    } catch (err: any) {
      logger.error({ error: err.message }, 'Error in main loop');
    }

    await sleep(TICK_INTERVAL_MS);
  }
}

main().catch(err => {
  logger.fatal({ error: err }, 'Fatal error in bot');
  process.exit(1);
});
