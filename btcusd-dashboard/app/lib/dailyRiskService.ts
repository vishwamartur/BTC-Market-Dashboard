import { getDeltaFills } from './delta';
import {
  calculateDailyRisk,
  getTradingDayStartMs,
  unavailableDailyRisk,
  type DailyRiskSnapshot,
} from './dailyRisk';

const PAGE_SIZE = 50;
const MAX_PAGES = 20;

function getAfterCursor(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const meta = (payload as Record<string, unknown>).meta;
  if (!meta || typeof meta !== 'object') return null;
  const after = (meta as Record<string, unknown>).after;
  return typeof after === 'string' && after ? after : null;
}

/**
 * Fetch all current-day fills needed for the loss guard. If pagination cannot
 * be completed within the bounded limit, the caller must block new entries.
 */
export async function getCurrentDayRisk(
  apiKey: string,
  apiSecret: string,
  now: number = Date.now(),
): Promise<DailyRiskSnapshot> {
  const startTimeMs = getTradingDayStartMs(now);
  const allFills: unknown[] = [];
  let after: string | undefined;

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
    const response = await getDeltaFills(apiKey, apiSecret, undefined, PAGE_SIZE, {
      startTimeMs,
      endTimeMs: now,
      after,
    });
    if (!response.success) {
      return unavailableDailyRisk('Unable to retrieve current-day Delta fills', now);
    }

    const page = Array.isArray(response.result) ? response.result : null;
    if (!page) return unavailableDailyRisk('Delta returned an invalid fills payload', now);
    allFills.push(...page);

    const nextCursor = getAfterCursor(response);
    if (!nextCursor || page.length < PAGE_SIZE) {
      return calculateDailyRisk(allFills, now);
    }
    after = nextCursor;
  }

  return unavailableDailyRisk('Too many current-day fills to validate the daily-loss guard', now);
}
