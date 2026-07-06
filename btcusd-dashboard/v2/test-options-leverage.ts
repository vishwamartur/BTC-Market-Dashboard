import 'dotenv/config';
import { getProducts, setDeltaLeverage } from './src/delta.js';

async function run() {
  const productsRes = await getProducts(process.env.DELTA_API_KEY!, process.env.DELTA_API_SECRET!);
  if (!productsRes.success) return console.log(productsRes);
  const btcOptions = (productsRes.result as any[]).filter(p => 
    (p.contract_type === 'call_options' || p.contract_type === 'put_options') &&
    p.underlying_asset?.symbol === 'BTC' &&
    p.state === 'live'
  );
  if (btcOptions.length > 0) {
    const prod = btcOptions[0];
    console.log(`Setting leverage to 10 for ${prod.symbol} (ID: ${prod.id})`);
    const levRes = await setDeltaLeverage(process.env.DELTA_API_KEY!, process.env.DELTA_API_SECRET!, prod.id, 10);
    console.log("Result:", levRes);
  }
}
run().catch(console.error);
