import crypto from 'crypto';

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
  const method = 'POST';
  const path = '/v2/orders';
  const payloadObj: Record<string, unknown> = {
    product_id: productId,
    size: size,
    side: side,
    order_type: orderType === 'market' ? 'market_order' : 'limit_order',
  };
  if (limitPrice) {
    payloadObj.limit_price = limitPrice;
  }
  if (options.reduceOnly !== undefined) {
    payloadObj.reduce_only = options.reduceOnly;
  }
  if (options.cancelOrdersAccepted !== undefined) {
    payloadObj.cancel_orders_accepted = options.cancelOrdersAccepted;
  }
  if (options.clientOrderId) {
    payloadObj.client_order_id = options.clientOrderId;
  }
  const payload = JSON.stringify(payloadObj);

  // Delta Exchange expects timestamp in SECONDS, not milliseconds
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = generateSignature(method, path, payload, apiSecret, timestamp);

  try {
    const response = await fetch(`${DELTA_BASE_URL}${path}`, {
      method: method,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'api-key': apiKey,
        'timestamp': timestamp,
        'signature': signature,
      },
      body: payload,
    });

    const data = await response.json();
    return data as DeltaOrderResponse;
  } catch (error: unknown) {
    console.error('Delta Exchange API Error:', error);
    return {
      success: false,
      error: { code: 'network_error', context: getErrorMessage(error) },
    };
  }
}

export async function getDeltaPositions(apiKey: string, apiSecret: string, productId?: number): Promise<DeltaPositionResponse> {
  const method = 'GET';
  const path = productId ? `/v2/positions?product_id=${productId}` : '/v2/positions';
  const payload = '';
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = generateSignature(method, path, payload, apiSecret, timestamp);

  try {
    const response = await fetch(`${DELTA_BASE_URL}${path}`, {
      method: method,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'api-key': apiKey,
        'timestamp': timestamp,
        'signature': signature,
      },
    });

    const data = await response.json();
    return data;
  } catch (error: unknown) {
    console.error('Delta Exchange API Error:', error);
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function setDeltaLeverage(
  apiKey: string,
  apiSecret: string,
  productId: number,
  leverage: number
) {
  const method = 'POST';
  const path = `/v2/products/${productId}/orders/leverage`;
  const payload = JSON.stringify({ leverage: leverage.toString() });

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = generateSignature(method, path, payload, apiSecret, timestamp);

  try {
    const response = await fetch(`${DELTA_BASE_URL}${path}`, {
      method: method,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'api-key': apiKey,
        'timestamp': timestamp,
        'signature': signature,
      },
      body: payload
    });

    const data = await response.json();
    if (data.success) {
      return { success: true, result: data.result };
    }
    return { success: false, error: data.error };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function getDeltaFills(apiKey: string, apiSecret: string, productId?: number, limit: number = 100) {
  const method = 'GET';
  let path = `/v2/fills?limit=${limit}`;
  if (productId) {
    path += `&product_id=${productId}`;
  }
  const payload = '';
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = generateSignature(method, path, payload, apiSecret, timestamp);

  try {
    const response = await fetch(`${DELTA_BASE_URL}${path}`, {
      method: method,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'api-key': apiKey,
        'timestamp': timestamp,
        'signature': signature,
      },
    });

    const data = await response.json();
    return data;
  } catch (error: unknown) {
    console.error('Delta Exchange API Error (Fills):', error);
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function getDeltaWalletBalances(apiKey: string, apiSecret: string) {
  const method = 'GET';
  const path = '/v2/wallet/balances';
  const payload = '';
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = generateSignature(method, path, payload, apiSecret, timestamp);

  try {
    const response = await fetch(`${DELTA_BASE_URL}${path}`, {
      method: method,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'api-key': apiKey,
        'timestamp': timestamp,
        'signature': signature,
      },
      cache: 'no-store',
    });

    const data = await response.json();
    return data;
  } catch (error: unknown) {
    console.error('Delta Exchange API Error (Wallet):', error);
    return { success: false, error: getErrorMessage(error) };
  }
}
