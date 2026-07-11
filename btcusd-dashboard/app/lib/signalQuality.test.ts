import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildSignalDataQuality, refreshSignalDataQuality } from './signalQuality';

const NOW = 1_000_000;

describe('signal data quality', () => {
  it('requires fresh price and market sources before directional signals', () => {
    const quality = buildSignalDataQuality({
      price: NOW - 1000,
      market: NOW - 1000,
      mempool: null,
      hashrate: null,
      whales: null,
      news: null,
    }, NOW);
    assert.equal(quality.isReady, true);
    assert.deepEqual(quality.blockingSources, []);
  });

  it('pauses trading when a critical source is stale', () => {
    const quality = buildSignalDataQuality({
      price: NOW - 31_000,
      market: NOW - 1000,
      mempool: null,
      hashrate: null,
      whales: null,
      news: null,
    }, NOW);
    assert.equal(quality.isReady, false);
    assert.deepEqual(quality.blockingSources, ['price']);
    assert.equal(quality.sources.price.state, 'STALE');
  });

  it('rechecks a persisted freshness snapshot at response time', () => {
    const fresh = buildSignalDataQuality({
      price: NOW - 1000,
      market: NOW - 1000,
      mempool: null,
      hashrate: null,
      whales: null,
      news: null,
    }, NOW);
    const refreshed = refreshSignalDataQuality(fresh, NOW + 31_000);
    assert.equal(refreshed?.isReady, false);
    assert.equal(refreshed?.sources.market.state, 'STALE');
  });
});
