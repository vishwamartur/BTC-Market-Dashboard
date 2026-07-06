import 'dotenv/config';
import { getProducts } from './src/delta.js';

async function run() {
  const res = await getProducts(process.env.DELTA_API_KEY!, process.env.DELTA_API_SECRET!);
  if (Array.isArray(res.result)) {
    const allProducts = res.result;
    const btcProducts = allProducts.filter((p: any) => p.symbol.includes('BTC'));
    console.log("BTC products count:", btcProducts.length);
    console.log("Spot BTC products:", btcProducts.filter(p => p.contract_type === 'spot' || p.contract_type === 'spot_pair').map(p => p.symbol));
    console.log("Perp BTC products:", btcProducts.filter(p => p.contract_type === 'perpetual_futures').map(p => p.symbol));
  }
}
run().catch(console.error);
