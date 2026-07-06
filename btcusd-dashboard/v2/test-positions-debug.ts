import 'dotenv/config';
import { getAllPositions } from './src/delta.js';

async function run() {
  const res = await getAllPositions(process.env.DELTA_API_KEY!, process.env.DELTA_API_SECRET!);
  console.log("Success:", res.success);
  if (Array.isArray(res.result)) {
    for (const p of res.result as any[]) {
      if (p.size !== 0) {
        console.log({
          product_id: p.product_id,
          symbol: p.product_symbol,
          contract_type: p.contract_type,
          size: p.size,
          entry_price: p.entry_price,
        });
      }
    }
    console.log("Total positions with size != 0:", (res.result as any[]).filter((p: any) => p.size !== 0).length);
    // Show all contract_type values
    const types = [...new Set((res.result as any[]).map((p: any) => p.contract_type))];
    console.log("All contract_type values seen:", types);
  } else {
    console.log("Raw result:", JSON.stringify(res.result));
    console.log("Error:", JSON.stringify(res.error));
  }
}
run().catch(console.error);
