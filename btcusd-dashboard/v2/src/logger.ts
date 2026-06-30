import pino from 'pino';
import { loadConfig } from './config/index.js';

export const logger = pino({
  level: loadConfig(process.env).LOG_LEVEL,
  base: { service: 'v2-bot' },
  timestamp: pino.stdTimeFunctions.isoTime,
});
