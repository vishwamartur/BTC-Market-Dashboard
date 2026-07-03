import 'dotenv/config';
import { z } from 'zod';

const Schema = z.object({
  DELTA_API_KEY: z.string().min(1),
  DELTA_API_SECRET: z.string().min(1),
  DELTA_BASE_URL: z.string().url().default('https://api.india.delta.exchange'),
  MONGODB_URI: z.string().min(1),
  DASHBOARD_URL: z.string().url().default('http://localhost:3000'),
  HEARTBEAT_URL: z.string().url().optional(),
  BOT_DISABLED: z.preprocess(v => v === 'true' || v === true, z.boolean()).default(false),
  DRY_RUN: z.preprocess(v => v === 'true' || v === true, z.boolean()).default(false),
  LOG_LEVEL: z.enum(['trace','debug','info','warn','error','fatal']).default('info'),
  ACCOUNT_BALANCE_USD: z.coerce.number().positive().default(1000),
});

export type Config = z.infer<typeof Schema>;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = Schema.safeParse(env);
  if (!result.success) {
    const missing = result.error.issues.map(i => i.path.join('.')).join(', ');
    throw new Error(`Invalid config (${missing})`);
  }
  return result.data;
}
