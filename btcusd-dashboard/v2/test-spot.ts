import 'dotenv/config';
import { getProducts } from './src/delta.js';

async function run() {
  const res = await getProducts(process.env.DELTA_API_KEY!, process.env.DELTA_API_SECRET!);
  if (Array.isArray(res.result)) {
    const spotProducts = res.result.filter((p: any) => p.contract_type === 'spot' || p.contract_type === 'spot_pair');
    console.log("Spot Products:", spotProducts.map((p: any) => p.symbol));
    
    // Also let's check contract_type values available
    const contractTypes = [...new Set(res.result.map((p: any) => p.contract_type))];
    console.log("All contract types:", contractTypes);
  }
}
run().catch(console.error);
