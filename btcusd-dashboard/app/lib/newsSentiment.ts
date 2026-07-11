/**
 * Real-time news sentiment manager.
 *
 * Polls two public RSS feeds (Cointelegraph and CoinDesk) on a fixed
 * interval, parses each item with native DOMParser when available
 * (Node 20+) and falls back to a regex-based parser for older runtimes.
 *
 * Each item is scored with a small keyword list; the aggregate score is a
 * time-weighted average over the last 30 minutes, with more recent
 * headlines weighted more heavily.
 *
 * Singleton pattern (mirrors SignalEngine) so hot-reloads don't spin up
 * duplicate pollers.
 */

export interface NewsItem {
  title: string;
  description: string;
  pubDate: number; // epoch ms
}

export interface NewsSentimentSnapshot {
  score: number; // -1 to +1
  timestamp: number; // epoch ms of the most recent item (or last fetch)
  headline: string; // title of the latest item (empty string if none)
  items: NewsItem[]; // raw items within the rolling window (kept for tests)
}

export const NEWS_RSS_FEEDS: ReadonlyArray<string> = [
  'https://cointelegraph.com/rss',
  'https://coindesk.com/arc/outboundfeeds/rss/',
];

const POLL_INTERVAL_MS = 60_000;
const LOOKBACK_MS = 30 * 60 * 1000; // 30 minutes
const FETCH_TIMEOUT_MS = 10_000;

const BULLISH_KEYWORDS = [
  'rally',
  'surge',
  'bull',
  'adoption',
  'etf approval',
  'breakthrough',
];

const BEARISH_KEYWORDS = [
  'crash',
  'dump',
  'bear',
  'sec',
  'lawsuit',
  'hack',
  'liquidation',
  'recession',
];

interface RSSDOMDocument {
  querySelectorAll(selector: string): Array<{
    querySelector(selector: string): { textContent: string } | null;
    textContent: string;
  }>;
}

/**
 * Parse RSS XML into a list of news items. Uses DOMParser when available;
 * otherwise falls back to a safe regex extraction.
 */
export function parseRSS(xml: string): NewsItem[] {
  if (!xml || typeof xml !== 'string') return [];

  // Prefer native DOMParser (Node 20+ exposes it via undici/jsdom).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g: any = globalThis;
  const DOMParserImpl: typeof DOMParser | undefined = g.DOMParser;
  if (typeof DOMParserImpl === 'function') {
    try {
      const doc = new DOMParserImpl().parseFromString(xml, 'application/xml');
      const docAny = doc as unknown as RSSDOMDocument;
      const itemEls = docAny.querySelectorAll('item');
      if (itemEls.length > 0) {
        return itemEls
          .map((item) => {
            const title = item.querySelector('title')?.textContent?.trim() ?? '';
            const description =
              item.querySelector('description')?.textContent?.trim() ?? '';
            const pubDateStr =
              item.querySelector('pubDate')?.textContent?.trim() ?? '';
            return {
              title,
              description,
              pubDate: parseRSSDate(pubDateStr),
            };
          })
          .filter((it) => it.title.length > 0);
      }
      // Atom-style fallback: <entry>
      const entryEls = docAny.querySelectorAll('entry');
      if (entryEls.length > 0) {
        return entryEls
          .map((entry) => {
            const title = entry.querySelector('title')?.textContent?.trim() ?? '';
            const description =
              entry.querySelector('summary')?.textContent?.trim() ??
              entry.querySelector('content')?.textContent?.trim() ??
              '';
            const pubDateStr =
              entry.querySelector('published')?.textContent?.trim() ??
              entry.querySelector('updated')?.textContent?.trim() ??
              '';
            return {
              title,
              description,
              pubDate: parseRSSDate(pubDateStr),
            };
          })
          .filter((it) => it.title.length > 0);
      }
    } catch {
      // fall through to regex parser
    }
  }

  return parseRSSRegex(xml);
}

/** Regex fallback for environments without DOMParser. */
export function parseRSSRegex(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const description = extractTag(block, 'description');
    const pubDateStr = extractTag(block, 'pubDate');
    if (!title) continue;
    items.push({
      title,
      description,
      pubDate: parseRSSDate(pubDateStr),
    });
  }
  if (items.length > 0) return items;

  // Atom: <entry>...</entry>
  const entryRegex = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const description =
      extractTag(block, 'summary') || extractTag(block, 'content');
    const pubDateStr =
      extractTag(block, 'published') || extractTag(block, 'updated');
    if (!title) continue;
    items.push({
      title,
      description,
      pubDate: parseRSSDate(pubDateStr),
    });
  }
  return items;
}

function extractTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(block);
  if (!m) return '';
  return stripCdata(m[1]).trim();
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

/** Parse an RSS/Atom date string into epoch ms; falls back to 0. */
export function parseRSSDate(input: string): number {
  if (!input) return 0;
  const t = Date.parse(input);
  if (isNaN(t)) return 0;
  return t;
}

/**
 * Score a single headline+description pair in [-1, +1].
 * 0 when no bullish or bearish keywords are present.
 */
export function scoreItem(text: string): number {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let bull = 0;
  let bear = 0;
  for (const kw of BULLISH_KEYWORDS) {
    if (lower.includes(kw)) bull++;
  }
  for (const kw of BEARISH_KEYWORDS) {
    if (lower.includes(kw)) bear++;
  }
  const total = bull + bear;
  if (total === 0) return 0;
  return Math.max(-1, Math.min(1, (bull - bear) / total));
}

/**
 * Aggregate a list of items into a single sentiment score in [-1, +1].
 * Each item's weight is higher the more recent it is. Items outside the
 * window are ignored.
 */
export function aggregateSentiment(
  items: NewsItem[],
  now: number,
  windowMs: number = LOOKBACK_MS
): number {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const it of items) {
    if (!it.pubDate) continue;
    const age = now - it.pubDate;
    if (age < 0 || age > windowMs) continue;
    // Linear decay: most recent -> weight 1, oldest within window -> weight ~0.
    const w = Math.max(0, 1 - age / windowMs);
    if (w <= 0) continue;
    const s = scoreItem(`${it.title} ${it.description}`);
    weightedSum += s * w;
    totalWeight += w;
  }
  if (totalWeight === 0) return 0;
  return Math.max(-1, Math.min(1, weightedSum / totalWeight));
}

class NewsSentimentManager {
  private started = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;

  private items: NewsItem[] = [];
  private latestFetchTime = 0;
  private latestHeadline = '';
  private latestScore = 0;
  private latestItemTimestamp = 0;

  // Allow tests to inject a fetcher
  private fetcher: (url: string) => Promise<string> = defaultFetcher;

  /** Returns the latest sentiment snapshot. Starts polling on first call. */
  getLatestSentiment(): { score: number; timestamp: number; headline: string } {
    this.ensureStarted();
    return {
      score: this.latestScore,
      timestamp:
        this.latestItemTimestamp > 0
          ? this.latestItemTimestamp
          : this.latestFetchTime,
      headline: this.latestHeadline,
    };
  }

  /** Full snapshot including the raw windowed items (used by tests). */
  getSnapshot(now: number = Date.now()): NewsSentimentSnapshot {
    this.ensureStarted();
    const windowCutoff = now - LOOKBACK_MS;
    const recent = this.items.filter(
      (it) => it.pubDate >= windowCutoff && it.pubDate <= now
    );
    const score = aggregateSentiment(recent, now);
    return {
      score,
      timestamp:
        this.latestItemTimestamp > 0
          ? this.latestItemTimestamp
          : this.latestFetchTime,
      headline: this.latestHeadline,
      items: recent,
    };
  }

  /** Override the fetcher (used in tests to stub network). */
  setFetcher(fn: (url: string) => Promise<string>) {
    this.fetcher = fn;
  }

  /** Force an immediate poll (used by tests). */
  async pollOnce(): Promise<void> {
    await this.poll();
  }

  /** Number of items currently held in memory. */
  size(): number {
    return this.items.length;
  }

  destroy() {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.started = false;
  }

  // ---------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------

  private ensureStarted() {
    if (this.started) return;
    this.started = true;

    // Kick off an initial poll asynchronously, then poll on interval.
    void this.poll();
    this.intervalId = setInterval(() => {
      void this.poll();
    }, POLL_INTERVAL_MS);
  }

  private async poll(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const allItems: NewsItem[] = [];
      for (const url of NEWS_RSS_FEEDS) {
        try {
          const xml = await this.fetcher(url);
          const parsed = parseRSS(xml);
          for (const it of parsed) allItems.push(it);
        } catch {
          // swallow per-feed failures so one bad source doesn't break the manager
        }
      }
      this.applyItems(allItems);
      this.latestFetchTime = Date.now();
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private applyItems(newItems: NewsItem[]) {
    const now = Date.now();
    const cutoff = now - LOOKBACK_MS;
    const merged: NewsItem[] = [];
    const seen = new Set<string>();
    const push = (it: NewsItem) => {
      const key = `${it.pubDate}|${it.title}`;
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(it);
    };
    for (const it of newItems) push(it);
    for (const it of this.items) push(it);

    this.items = merged
      .filter((it) => it.pubDate >= cutoff)
      .sort((a, b) => b.pubDate - a.pubDate);

    // Recompute aggregate over the window
    this.latestScore = aggregateSentiment(this.items, now);
    if (this.items.length > 0) {
      this.latestHeadline = this.items[0].title;
      this.latestItemTimestamp = this.items[0].pubDate;
    } else {
      this.latestHeadline = '';
      this.latestItemTimestamp = 0;
    }
  }
}

async function defaultFetcher(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent':
          'Mozilla/5.0 (compatible; BTCUSD-Dashboard/1.0; +https://localhost)',
        accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
    });
    if (!res.ok) {
      throw new Error(`RSS fetch failed: ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Global singleton (survives Next.js hot reloads)
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var _newsSentimentManager: NewsSentimentManager | undefined;
}

export function getNewsSentimentManager(): NewsSentimentManager {
  if (!global._newsSentimentManager) {
    global._newsSentimentManager = new NewsSentimentManager();
  }
  return global._newsSentimentManager;
}

/** Test-only: reset the singleton so each test starts fresh. */
export function _resetNewsSentimentManagerForTests() {
  if (global._newsSentimentManager) {
    global._newsSentimentManager.destroy();
  }
  global._newsSentimentManager = undefined;
}
