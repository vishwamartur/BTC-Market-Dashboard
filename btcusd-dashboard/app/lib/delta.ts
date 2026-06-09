import crypto from 'crypto';
import { resilientFetch } from './resilientFetch';

export const DELTA_BASE_URL = process.env.DELTA_BASE_URL || 'https://api.delta.exchange';

export interface DeltaOrderResponse {
  success: boolean;
  result?: {
    id: number;
    product_id: number;
    size: number;
    side: string;
    state: string;
    [key: string]: unknown;
  };
  error?: {
    code: string;
    context: unknown;
  };
}

export interface DeltaPositionResponse {
  success: boolean;
  result?: unknown;
  error?: unknown;
}

interface PlaceOrderOptions {
  reduceOnly?: boolean;
  cancelOrdersAccepted?: boolean;
  clientOrderId?: string;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function generateSignature(method: string, path: string, payload: string, apiSecret: string, timestamp: string): string {
  const signatureData = method + timestamp + path + payload;
  return crypto.createHmac('sha256', apiSecret).update(signatureData).digest('hex');
}

// ---------------------------------------------------------------------------
// Shared helper: authenticated Delta request with resilientFetch
// ---------------------------------------------------------------------------

interface DeltaRequestOptions {
  method: string;
  path: string;
  apiKey: string;
  apiSecret: string;
  payload?: string;
  label?: string;
  /** Retry count (default: 2 for reads, 0 for writes). */
  retries?: number;
}

let timeOffset = 0;

async function deltaRequest<T = Record<string, unknown>>(opts: DeltaRequestOptions, isTimeRetry = false): Promise<T & { success: boolean; error?: unknown }> {
  const { method, path, apiKey, apiSecret, payload = '', label = 'deltaRequest', retries = 2 } = opts;
  const timestamp = (Math.floor(Date.now() / 1000) + timeOffset).toString();
  const signature = generateSignature(method, path, payload, apiSecret, timestamp);
  const url = `${DELTA_BASE_URL}${path}`;

  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'api-key': apiKey,
    'timestamp': timestamp,
    'signature': signature,
  };

  if (payload) {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const response = await resilientFetch(url, {
      retries,
      timeoutMs: 10_000,
      init: {
        method,
        headers,
        ...(payload ? { body: payload } : {}),
      },
    });

    const rawText = await response.text();

    let data: T & { success: boolean; error?: unknown };
    try {
      data = JSON.parse(rawText);
    } catch {
      console.error(`[${label}] Non-JSON response (HTTP ${response.status}): ${rawText.slice(0, 200)}`);
      return { success: false, error: `Non-JSON response (HTTP ${response.status}): ${rawText.slice(0, 200)}` } as T & { success: boolean; error?: unknown };
    }

    if (!data.success) {
      const errObj = data.error as any;
      if (!isTimeRetry && errObj && errObj.code === 'expired_signature' && errObj.context && typeof errObj.context.server_time === 'number') {
        const serverTime = errObj.context.server_time;
        timeOffset = serverTime - Math.floor(Date.now() / 1000);
        console.warn(`[${label}] Signature expired. Adjusting timeOffset to ${timeOffset}s and retrying.`);
        return deltaRequest(opts, true);
      }
      console.error(`[${label}] API returned success=false | error: ${JSON.stringify(data.error)}`);
    }

    return data;
  } catch (error: unknown) {
    console.error(`[${label}] Network error:`, error);
    return { success: false, error: getErrorMessage(error) } as T & { success: boolean; error?: unknown };
  }
}

// ---------------------------------------------------------------------------
// Public API functions
// ---------------------------------------------------------------------------

export async function placeDeltaOrder(
  apiKey: string,
  apiSecret: string,
  productId: number,
  size: number,
  side: 'buy' | 'sell',
  orderType: 'market' | 'limit' = 'market',
  limitPrice?: string,
  options: PlaceOrderOptions = {}
): Promise<DeltaOrderResponse> {
  const payloadObj: Record<string, unknown> = {
    product_id: productId,
    size: size,
    side: side,
    order_type: orderType === 'market' ? 'market_order' : 'limit_order',
  };
  if (limitPrice) payloadObj.limit_price = limitPrice;
  if (options.reduceOnly !== undefined) payloadObj.reduce_only = options.reduceOnly;
  if (options.cancelOrdersAccepted !== undefined) payloadObj.cancel_orders_accepted = options.cancelOrdersAccepted;
  if (options.clientOrderId) payloadObj.client_order_id = options.clientOrderId;

  return deltaRequest<DeltaOrderResponse>({
    method: 'POST',
    path: '/v2/orders',
    apiKey,
    apiSecret,
    payload: JSON.stringify(payloadObj),
    label: 'placeDeltaOrder',
    retries: 0, // No retries for order placement — avoids double-fills
  });
}

export async function getDeltaPositions(apiKey: string, apiSecret: string, productId?: number): Promise<DeltaPositionResponse> {
  const path = productId ? `/v2/positions?product_id=${productId}` : '/v2/positions';
  return deltaRequest<DeltaPositionResponse>({
    method: 'GET',
    path,
    apiKey,
    apiSecret,
    label: 'getDeltaPositions',
    retries: 2,
  });
}

export async function setDeltaLeverage(
  apiKey: string,
  apiSecret: string,
  productId: number,
  leverage: number
) {
  return deltaRequest({
    method: 'POST',
    path: `/v2/products/${productId}/orders/leverage`,
    apiKey,
    apiSecret,
    payload: JSON.stringify({ leverage: leverage.toString() }),
    label: 'setDeltaLeverage',
    retries: 1,
  });
}

export async function getDeltaFills(apiKey: string, apiSecret: string, productId?: number, limit: number = 100) {
  let path = `/v2/fills?limit=${limit}`;
  if (productId) path += `&product_id=${productId}`;

  return deltaRequest({
    method: 'GET',
    path,
    apiKey,
    apiSecret,
    label: 'getDeltaFills',
    retries: 2,
  });
}

export async function getDeltaWalletBalances(apiKey: string, apiSecret: string) {
  return deltaRequest({
    method: 'GET',
    path: '/v2/wallet/balances',
    apiKey,
    apiSecret,
    label: 'getDeltaWalletBalances',
    retries: 2,
  });
}

export async function getOrderById(apiKey: string, apiSecret: string, orderId: number) {
  return deltaRequest({
    method: 'GET',
    path: `/v2/orders/${orderId}`,
    apiKey,
    apiSecret,
    label: 'getOrderById',
    retries: 2,
  });
}

export async function cancelOrder(apiKey: string, apiSecret: string, orderId: number, productId: number) {
  return deltaRequest({
    method: 'DELETE',
    path: '/v2/orders',
    apiKey,
    apiSecret,
    payload: JSON.stringify({ id: orderId, product_id: productId }),
    label: 'cancelOrder',
    retries: 0, // No retries for cancel — avoid double-cancel confusion
  });
}

export async function getOpenOrders(apiKey: string, apiSecret: string, productId?: number) {
  let path = '/v2/orders?state=open';
  if (productId) path += `&product_id=${productId}`;

  return deltaRequest({
    method: 'GET',
    path,
    apiKey,
    apiSecret,
    label: 'getOpenOrders',
    retries: 2,
  });
}
