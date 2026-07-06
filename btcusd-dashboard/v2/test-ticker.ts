import 'dotenv/config';
import { getProducts, getTickers } from './src/delta.js';

async function run() {
  const res = await getProducts(process.env.DELTA_API_KEY!, process.env.DELTA_API_SECRET!);
  const btcPerp = (res.result as any[]).find((p: any) => p.id === 27);
  console.log("Product 27 symbol:", btcPerp?.symbol);

  const tRes = await getTickers(process.env.DELTA_API_KEY!, process.env.DELTA_API_SECRET!, btcPerp?.symbol);
  if (Array.isArray(tRes.result)) {
    const t = tRes.result.find((t: any) => t.product_id === 27);
    console.log(t);
  }
}
run().catch(console.error);
