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
    [key: string]: any;
  };
  error?: {
    code: string;
    context: any;
  };
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
  limitPrice?: string
): Promise<DeltaOrderResponse> {
  const method = 'POST';
  const path = '/v2/orders';
  const payloadObj: any = {
    product_id: productId,
    size: size,
    side: side,
    order_type: orderType === 'market' ? 'market_order' : 'limit_order',
  };
  if (limitPrice) {
    payloadObj.limit_price = limitPrice;
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
  } catch (error: any) {
    console.error('Delta Exchange API Error:', error);
    return {
      success: false,
      error: { code: 'network_error', context: error.message },
    };
  }
}

export async function getDeltaPositions(apiKey: string, apiSecret: string) {
  const method = 'GET';
  const path = '/v2/positions';
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
  } catch (error: any) {
    console.error('Delta Exchange API Error:', error);
    return { success: false };
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
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}
