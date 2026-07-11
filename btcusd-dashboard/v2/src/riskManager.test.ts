import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { shouldTrade, DEFAULT_RISK_CONFIG } from './riskManager.js';

describe('shouldTrade — confluence gate', () => {
  it('rejects a signal with insufficient confluence', () => {
    const result = shouldTrade(
      { overallSignal: 'STRONG BUY', confidence: 75, score: 0.6, confluenceCount: 1 },
      DEFAULT_RISK_CONFIG,
      50_000
    );
    assert.equal(result.action, null);
    assert.equal(result.size, 0);
  });

  it('allows a signal that meets the confluence threshold', () => {
    const result = shouldTrade(
      { overallSignal: 'STRONG BUY', confidence: 75, score: 0.6, confluenceCount: 4 },
      DEFAULT_RISK_CONFIG,
      50_000
    );
    assert.equal(result.action, 'BUY');
    assert.ok((result.size ?? 0) > 0);
  });

  it('allows legacy signals without confluenceCount for backward compatibility', () => {
    const result = shouldTrade(
      { overallSignal: 'STRONG BUY', confidence: 75, score: 0.6 },
      DEFAULT_RISK_CONFIG,
      50_000
    );
    assert.equal(result.action, 'BUY');
  });
});
