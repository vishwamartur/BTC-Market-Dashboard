/** Pure daily-loss guard helpers shared by the API and auto-trader UI. */

const DEFAULT_TRADING_DAY_OFFSET_MINUTES = 330; // Asia/Kolkata
export const DEFAULT_MAX_DAILY_LOSS_USD = 100;

export interface DailyRiskSnapshot {
  available: boolean;
  dayStartMs: number;
  realizedPnlUsd: number;
  lossLimitUsd: number;
  lossLimitReached: boolean;
  fillsEvaluated: number;
  reason?: string;
}

function configuredOffsetMinutes(): number {
  const value = Number(process.env.TRADING_DAY_UTC_OFFSET_MINUTES ?? DEFAULT_TRADING_DAY_OFFSET_MINUTES);
  return Number.isFinite(value) ? value : DEFAULT_TRADING_DAY_OFFSET_MINUTES;
}

export function getTradingDayStartMs(now: number = Date.now(), offsetMinutes: number = configuredOffsetMinutes()): number {
  const shifted = new Date(now + offsetMinutes * 60_000);
  const startAtOffset = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  return startAtOffset - offsetMinutes * 60_000;
}

export function parseDeltaTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000_000 ? Math.floor(value / 1000) : value;
  }
  if (typeof value !== 'string' || !value) return null;

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric > 10_000_000_000_000 ? Math.floor(numeric / 1000) : numeric;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toFiniteNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

/**
 * Delta's fills are inconsistent across products: some expose realized_pnl at
 * the top level while others expose it in meta_data.new_position. An opening
 * fill has no realized P&L yet, but its commission is still a real loss.
 */
export function getFillNetPnlUsd(fill: unknown): number | null {
  const record = getRecord(fill);
  if (!record) return null;

  const directPnl = toFiniteNumber(record.realized_pnl);
  if (directPnl !== null) return directPnl;

  const meta = getRecord(record.meta_data);
  const newPosition = getRecord(meta?.new_position);
  const positionPnl = toFiniteNumber(newPosition?.realized_pnl);
  const commission = toFiniteNumber(record.commission) ?? 0;

  // New/opening fills have no realized P&L. Count their fee so the daily-loss
  // guard reflects costs immediately, then add realized P&L on closing fills.
  return (positionPnl ?? 0) - commission;
}

export function getMaxDailyLossUsd(): number {
  const configured = Number(process.env.MAX_DAILY_LOSS_USD ?? DEFAULT_MAX_DAILY_LOSS_USD);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_DAILY_LOSS_USD;
}

export function unavailableDailyRisk(reason: string, now: number = Date.now()): DailyRiskSnapshot {
  return {
    available: false,
    dayStartMs: getTradingDayStartMs(now),
    realizedPnlUsd: 0,
    lossLimitUsd: getMaxDailyLossUsd(),
    lossLimitReached: false,
    fillsEvaluated: 0,
    reason,
  };
}

/** Product-specific Delta fills may expose P&L only in nested position data. */
export function calculateDailyRisk(
  fills: unknown,
  now: number = Date.now(),
  lossLimitUsd: number = getMaxDailyLossUsd(),
): DailyRiskSnapshot {
  const dayStartMs = getTradingDayStartMs(now);
  if (!Array.isArray(fills)) return unavailableDailyRisk('Delta returned an invalid fills payload', now);

  let realizedPnlUsd = 0;
  let fillsEvaluated = 0;
  for (const fill of fills) {
    if (!fill || typeof fill !== 'object') continue;
    const record = fill as Record<string, unknown>;
    const timestamp = parseDeltaTimestampMs(record.created_at);
    if (timestamp === null || timestamp < dayStartMs || timestamp > now) continue;

    const realizedPnl = getFillNetPnlUsd(record);
    if (realizedPnl === null) continue;
    realizedPnlUsd += realizedPnl;
    fillsEvaluated++;
  }

  return {
    available: true,
    dayStartMs,
    realizedPnlUsd: Math.round(realizedPnlUsd * 100) / 100,
    lossLimitUsd,
    lossLimitReached: realizedPnlUsd <= -lossLimitUsd,
    fillsEvaluated,
  };
}
