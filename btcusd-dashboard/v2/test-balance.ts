import 'dotenv/config';
import { getDeltaWalletBalances } from './src/delta.js';

async function run() {
  const res = await getDeltaWalletBalances(process.env.DELTA_API_KEY!, process.env.DELTA_API_SECRET!);
  console.log("Success:", res.success);
  if (Array.isArray(res.result)) {
    for (const b of res.result as any[]) {
      if (Number(b.balance) > 0 || Number(b.available_balance) > 0) {
        console.log({
          asset: b.asset_symbol || b.asset_id,
          balance: b.balance,
          available: b.available_balance,
          order_margin: b.order_margin,
          position_margin: b.position_margin,
        });
      }
    }
  } else {
    console.log("Raw:", JSON.stringify(res).slice(0, 500));
  }
}
run().catch(console.error);
