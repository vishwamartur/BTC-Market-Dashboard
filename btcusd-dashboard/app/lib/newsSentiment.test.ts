/**
 * Unit tests for the news sentiment module.
 * Run with: npx tsx --test app/lib/newsSentiment.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  parseRSS,
  scoreItem,
  aggregateSentiment,
  getNewsSentimentManager,
  _resetNewsSentimentManagerForTests,
  type NewsItem,
} from './newsSentiment.js';

const LOOKBACK_MS = 30 * 60 * 1000;

/**
 * Build a minimal RSS XML document containing the supplied items.
 */
function makeRss(
  items: { title: string; description: string; pubDate: Date }[]
): string {
  const body = items
    .map(
      (it) =>
        `<item><title>${it.title}</title><description>${it.description}</description><pubDate>${it.pubDate.toUTCString()}</pubDate></item>`
    )
    .join('');
  return `<?xml version="1.0"?><rss><channel>${body}</channel></rss>`;
}

describe('parseRSS', () => {
  it('parses a simple RSS <item> with title, description, and pubDate', () => {
    const pubDate = new Date('2024-01-15T10:00:00Z');
    const xml = makeRss([
      {
        title: 'Bitcoin surges past 50k',
        description: 'A major rally',
        pubDate,
      },
    ]);

    const items = parseRSS(xml);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Bitcoin surges past 50k');
    assert.equal(items[0].description, 'A major rally');
    assert.equal(items[0].pubDate, pubDate.getTime());
  });

  it('returns an empty array for empty input', () => {
    assert.deepEqual(parseRSS(''), []);
  });
});

describe('scoreItem', () => {
  it('returns 0 for empty text', () => {
    assert.equal(scoreItem(''), 0);
  });

  it('returns 0 for neutral text without any keywords', () => {
    assert.equal(scoreItem('Bitcoin price is stable today'), 0);
    assert.equal(scoreItem('Markets open as usual with normal trading'), 0);
  });

  it('returns a positive score for bullish keywords', () => {
    const score = scoreItem('Bitcoin rally continues as adoption grows');
    assert.ok(score > 0, `expected positive score, got ${score}`);
    assert.ok(score <= 1, `expected score <= 1, got ${score}`);
  });

  it('returns a negative score for bearish keywords', () => {
    const score = scoreItem('Market crash and massive liquidation event');
    assert.ok(score < 0, `expected negative score, got ${score}`);
    assert.ok(score >= -1, `expected score >= -1, got ${score}`);
  });
});

describe('aggregateSentiment', () => {
  // Use a fixed reference point so the tests are deterministic.
  const NOW = 1_700_000_000_000;

  function makeItem(title: string, ageMs: number): NewsItem {
    return { title, description: '', pubDate: NOW - ageMs };
  }

  it('returns 0 for an empty item list', () => {
    assert.equal(aggregateSentiment([], NOW), 0);
  });

  it('returns a positive score for a bullish feed', () => {
    const items = [
      makeItem('Bitcoin rally continues', 1_000),
      makeItem('ETF approval boosts adoption', 5_000),
      makeItem('Major surge in prices', 10_000),
    ];
    const score = aggregateSentiment(items, NOW);
    assert.ok(score > 0, `expected positive, got ${score}`);
  });

  it('returns a negative score for a bearish feed', () => {
    const items = [
      makeItem('Market crash wipes out gains', 1_000),
      makeItem('Massive liquidation event', 5_000),
      makeItem('SEC lawsuit filed against exchange', 10_000),
    ];
    const score = aggregateSentiment(items, NOW);
    assert.ok(score < 0, `expected negative, got ${score}`);
  });

  it('returns ~0 for a balanced mixed feed', () => {
    const items = [
      makeItem('Bitcoin rally adoption surge', 1_000),
      makeItem('Market crash bear liquidation', 1_000),
      makeItem('Bullish breakthrough news', 5_000),
      makeItem('Bearish hack and lawsuit', 5_000),
    ];
    const score = aggregateSentiment(items, NOW);
    assert.ok(
      Math.abs(score) < 1e-9,
      `expected ~0 for balanced feed, got ${score}`
    );
  });

  it('ignores items older than 30 minutes', () => {
    const items = [
      // 31 minutes old — outside the window
      makeItem('Bitcoin rally surge adoption', 31 * 60 * 1000),
      // 60 minutes old — outside the window
      makeItem('Major breakthrough etf approval', 60 * 60 * 1000),
    ];
    const score = aggregateSentiment(items, NOW);
    assert.equal(score, 0, `expected 0 for old items, got ${score}`);
  });

  it('keeps a recent bullish item while ignoring an older bearish one', () => {
    const items = [
      makeItem('Bitcoin rally surge adoption', 1_000), // ~weight 1
      makeItem('Market crash dump bear', 25 * 60 * 1000), // ~weight 0.17
    ];
    const score = aggregateSentiment(items, NOW);
    assert.ok(score > 0.5, `expected strongly positive, got ${score}`);
  });
});

describe('NewsSentimentManager', () => {
  beforeEach(() => {
    _resetNewsSentimentManagerForTests();
  });

  afterEach(() => {
    _resetNewsSentimentManagerForTests();
  });

  it('returns 0 when the fetcher yields an empty feed', async () => {
    const manager = getNewsSentimentManager();
    manager.setFetcher(async () => makeRss([]));
    await manager.pollOnce();
    const sent = manager.getLatestSentiment();
    assert.equal(sent.score, 0);
    assert.equal(sent.headline, '');
  });

  it('returns a positive score for a bullish feed', async () => {
    const manager = getNewsSentimentManager();
    const now = Date.now();
    manager.setFetcher(async () =>
      makeRss([
        {
          title: 'Bitcoin rally continues',
          description: 'surge adoption',
          pubDate: new Date(now - 1_000),
        },
        {
          title: 'ETF approval expected',
          description: 'breakthrough',
          pubDate: new Date(now - 5_000),
        },
      ])
    );
    await manager.pollOnce();
    const sent = manager.getLatestSentiment();
    assert.ok(sent.score > 0, `expected positive, got ${sent.score}`);
    assert.ok(sent.headline.length > 0);
    assert.ok(sent.timestamp > 0);
  });

  it('returns a negative score for a bearish feed', async () => {
    const manager = getNewsSentimentManager();
    const now = Date.now();
    manager.setFetcher(async () =>
      makeRss([
        {
          title: 'Market crash begins',
          description: 'massive liquidation',
          pubDate: new Date(now - 1_000),
        },
        {
          title: 'SEC lawsuit filed',
          description: 'hack revealed',
          pubDate: new Date(now - 5_000),
        },
      ])
    );
    await manager.pollOnce();
    const sent = manager.getLatestSentiment();
    assert.ok(sent.score < 0, `expected negative, got ${sent.score}`);
  });

  it('filters out items older than 30 minutes from getSnapshot', async () => {
    const manager = getNewsSentimentManager();
    const now = Date.now();
    manager.setFetcher(async () =>
      makeRss([
        // Recent bullish — should survive
        {
          title: 'Bitcoin rally surge adoption',
          description: '',
          pubDate: new Date(now - 1_000),
        },
        // 45 minutes old — should be filtered out
        {
          title: 'Market crash bear liquidation',
          description: '',
          pubDate: new Date(now - 45 * 60 * 1000),
        },
      ])
    );
    await manager.pollOnce();
    const snap = manager.getSnapshot(now);
    assert.equal(
      snap.items.length,
      1,
      `expected 1 recent item, got ${snap.items.length}`
    );
    assert.equal(snap.items[0].title, 'Bitcoin rally surge adoption');
    assert.ok(snap.score > 0, `expected positive score, got ${snap.score}`);
  });

  it('getSnapshot returns score, timestamp, headline, and items', async () => {
    const manager = getNewsSentimentManager();
    const now = Date.now();
    manager.setFetcher(async () =>
      makeRss([
        {
          title: 'Latest headline',
          description: 'rally adoption',
          pubDate: new Date(now - 1_000),
        },
      ])
    );
    await manager.pollOnce();
    const snap = manager.getSnapshot(now);
    assert.equal(typeof snap.score, 'number');
    assert.equal(typeof snap.timestamp, 'number');
    assert.equal(typeof snap.headline, 'string');
    assert.ok(Array.isArray(snap.items));
    assert.ok(snap.score > 0, `expected positive score, got ${snap.score}`);
  });
});
