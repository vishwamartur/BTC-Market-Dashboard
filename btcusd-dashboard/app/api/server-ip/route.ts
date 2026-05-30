import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const res = await fetch('https://api64.ipify.org?format=json', {
      cache: 'no-store'
    });
    const data = await res.json();
    return NextResponse.json({ ip: data.ip });
  } catch (error) {
    console.error('Failed to fetch server IP:', error);
    return NextResponse.json({ error: 'Failed to fetch server IP' }, { status: 500 });
  }
}
