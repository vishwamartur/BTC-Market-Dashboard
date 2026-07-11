import { NextResponse } from 'next/server';
import { getAutoTraderConfig, setAutoTraderEnabled } from '../../../lib/autotraderConfig';
import { isTrustedTradingOrigin } from '../../../lib/tradeAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const config = await getAutoTraderConfig();
  if (!config) {
    return NextResponse.json({ error: 'Durable auto-trader configuration is unavailable' }, { status: 503 });
  }
  return NextResponse.json(config);
}

export async function PUT(request: Request) {
  if (!isTrustedTradingOrigin(request)) {
    return NextResponse.json({ error: 'Untrusted auto-trader configuration request origin' }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
  }

  const config = await setAutoTraderEnabled(body.enabled);
  if (!config) {
    return NextResponse.json({ error: 'Durable auto-trader configuration is unavailable' }, { status: 503 });
  }
  return NextResponse.json(config);
}
