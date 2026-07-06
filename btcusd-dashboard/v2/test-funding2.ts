import 'dotenv/config';
import { getTickers } from './src/delta.js';

async function run() {
  const res = await getTickers(process.env.DELTA_API_KEY!, process.env.DELTA_API_SECRET!, 'BTCUSD');
  if (Array.isArray(res.result)) {
    const t = res.result[0];
    console.log(t);
  }
}
run().catch(console.error);
