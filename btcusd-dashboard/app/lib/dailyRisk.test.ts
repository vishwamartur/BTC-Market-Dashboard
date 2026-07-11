import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { calculateDailyRisk, getTradingDayStartMs, parseDeltaTimestampMs } from './dailyRisk';

describe('daily risk guard', () => {
  it('converts Delta microsecond timestamps to milliseconds', () => {
    assert.equal(parseDeltaTimestampMs('1725865012000000'), 1725865012000);
  });

  it('uses an Asia/Kolkata trading-day boundary by default', () => {
    const now = Date.UTC(2026, 6, 11, 1, 0, 0); // 06:30 IST
    assert.equal(getTradingDayStartMs(now), Date.UTC(2026, 6, 10, 18, 30, 0));
  });

  it('locks entries after the configured daily loss is reached', () => {
    const now = Date.UTC(2026, 6, 11, 6, 0, 0);
    const risk = calculateDailyRisk([
      { created_at: String((now - 60_000) * 1000), realized_pnl: '-125.50' },
      { created_at: String((now - 120_000) * 1000), realized_pnl: '10' },
    ], now, 100);
    assert.equal(risk.available, true);
    assert.equal(risk.realizedPnlUsd, -115.5);
    assert.equal(risk.lossLimitReached, true);
  });

  it('counts an opening fill commission when no P&L is realized yet', () => {
    const now = Date.UTC(2026, 6, 11, 6, 0, 0);
    const risk = calculateDailyRisk([
      { created_at: String((now - 60_000) * 1000), commission: '0.50' },
    ], now, 100);
    assert.equal(risk.available, true);
    assert.equal(risk.realizedPnlUsd, -0.5);
  });

  it('reads product-specific P&L from meta_data.new_position', () => {
    const now = Date.UTC(2026, 6, 11, 6, 0, 0);
    const risk = calculateDailyRisk([
      {
        created_at: String((now - 60_000) * 1000),
        commission: '0.25',
        meta_data: { new_position: { realized_pnl: '4.50' } },
      },
    ], now, 100);
    assert.equal(risk.realizedPnlUsd, 4.25);
  });
});
