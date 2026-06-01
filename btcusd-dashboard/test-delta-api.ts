import crypto from 'crypto';

const DELTA_BASE_URL = 'https://api.india.delta.exchange';
const DELTA_API_KEY = 'Wv0pZFoNN5PbQiwJp7cgvkJ9Fs2LUV';
const DELTA_API_SECRET = 'FSsVzjpf2OY4JDJyFsqplKONwvRLMxuytZvMOmFQGHfu6NvFvO4k3KpUHxUI';

function generateSignature(method: string, path: string, payload: string, apiSecret: string, timestamp: string): string {
  const signatureData = method + timestamp + path + payload;
  return crypto.createHmac('sha256', apiSecret).update(signatureData).digest('hex');
}

async function fetchDelta(path: string, method: string = 'GET') {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = generateSignature(method, path, '', DELTA_API_SECRET, timestamp);

  const response = await fetch(`${DELTA_BASE_URL}${path}`, {
    method: method,
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'api-key': DELTA_API_KEY,
      'timestamp': timestamp,
      'signature': signature,
    },
  });
  return response.json();
}

async function main() {
  console.log('Fills:', JSON.stringify(await fetchDelta('/v2/fills?product_id=27&limit=5'), null, 2));
  console.log('Wallet:', JSON.stringify(await fetchDelta('/v2/wallet/balances'), null, 2));
  console.log('Transactions:', JSON.stringify(await fetchDelta('/v2/wallet/transactions?limit=5'), null, 2));
}

main().catch(console.error);
