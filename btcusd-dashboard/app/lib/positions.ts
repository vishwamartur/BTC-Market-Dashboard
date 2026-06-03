export type PositionSide = 'LONG' | 'SHORT';

export interface ActivePosition {
  productId: number;
  symbol: string;
  side: PositionSide;
  size: number;
  signedSize: number;
  entryPrice: number | null;
  liquidationPrice: number | null;
  margin: number | null;
  unrealizedPnl: number | null;
}

type RawPosition = Record<string, unknown>;

function isRecord(value: unknown): value is RawPosition {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getNestedRecord(record: RawPosition, key: string): RawPosition | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function getNumber(record: RawPosition, keys: string[]): number | null {
  for (const key of keys) {
    const num = toNumber(record[key]);
    if (num !== null) return num;
  }
  return null;
}

function getString(record: RawPosition, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function getProductId(record: RawPosition): number | null {
  const direct = getNumber(record, ['product_id', 'productId']);
  if (direct !== null) return direct;

  const product = getNestedRecord(record, 'product');
  return product ? getNumber(product, ['id', 'product_id', 'productId']) : null;
}

function getSymbol(record: RawPosition): string {
  const product = getNestedRecord(record, 'product');
  return (
    getString(record, ['product_symbol', 'productSymbol', 'symbol']) ||
    (product ? getString(product, ['symbol', 'product_symbol', 'productSymbol']) : null) ||
    'BTCUSD'
  );
}

function getSignedSize(record: RawPosition): number | null {
  const rawSize = getNumber(record, ['size', 'position_size', 'positionSize', 'net_size', 'netSize']);
  if (rawSize === null || rawSize === 0) return null;

  const rawSide = getString(record, ['side', 'position_side', 'positionSide']);
  if (!rawSide) return rawSize;

  const side = rawSide.toLowerCase();
  if (side.includes('short') || side === 'sell') return -Math.abs(rawSize);
  if (side.includes('long') || side === 'buy') return Math.abs(rawSize);
  return rawSize;
}

function toRawPositionList(result: unknown): RawPosition[] {
  if (Array.isArray(result)) {
    return result.filter(isRecord);
  }

  if (!isRecord(result)) {
    return [];
  }

  const nestedKeys = ['position', 'positions', 'open_positions', 'openPositions', 'data'];
  for (const key of nestedKeys) {
    const nested = result[key];
    if (isRecord(nested)) return [nested];
    if (Array.isArray(nested)) return nested.filter(isRecord);
  }

  return [result];
}

export function normalizeDeltaPosition(result: unknown, productId: number): ActivePosition | null {
  const positions = toRawPositionList(result);
  const raw = positions.find((position) => {
    const positionProductId = getProductId(position);
    const signedSize = getSignedSize(position);
    const productMatches = positionProductId === null || positionProductId === productId;
    return productMatches && signedSize !== null && signedSize !== 0;
  });

  if (!raw) return null;

  const signedSize = getSignedSize(raw);
  if (signedSize === null || signedSize === 0) return null;

  return {
    productId,
    symbol: getSymbol(raw),
    side: signedSize > 0 ? 'LONG' : 'SHORT',
    size: Math.abs(signedSize),
    signedSize,
    entryPrice: getNumber(raw, ['entry_price', 'entryPrice', 'avg_entry_price', 'averageEntryPrice']),
    liquidationPrice: getNumber(raw, ['liquidation_price', 'liquidationPrice']),
    margin: getNumber(raw, ['margin', 'position_margin', 'positionMargin']),
    unrealizedPnl: getNumber(raw, ['unrealized_pnl', 'unrealizedPnl', 'unrealised_pnl', 'unrealisedPnl']),
  };
}
