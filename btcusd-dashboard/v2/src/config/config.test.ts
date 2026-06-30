import { describe, it, expect } from 'vitest';
import { loadConfig } from './index.js';

describe('loadConfig', () => {
  it('rejects missing keys', () => {
    expect(() => loadConfig({})).toThrow(/DELTA_API_KEY/);
  });

  it('applies defaults', () => {
    const cfg = loadConfig({
      DELTA_API_KEY: 'k', DELTA_API_SECRET: 's',
      MONGODB_URI: 'mongodb://localhost', HEARTBEAT_URL: 'https://x.com',
    });
    expect(cfg.DELTA_BASE_URL).toBe('https://api.india.delta.exchange');
    expect(cfg.BOT_DISABLED).toBe(false);
    expect(cfg.ACCOUNT_BALANCE_USD).toBe(1000);
  });

  it('coerces BOT_DISABLED=true', () => {
    const cfg = loadConfig({
      DELTA_API_KEY: 'k', DELTA_API_SECRET: 's', MONGODB_URI: 'm',
      HEARTBEAT_URL: 'https://h.com', BOT_DISABLED: 'true',
    });
    expect(cfg.BOT_DISABLED).toBe(true);
  });
});
