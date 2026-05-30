import { NextResponse } from 'next/server';
import os from 'os';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const interfaces = os.networkInterfaces();
    let staticIpv6: string | null = null;

    // Search network interfaces for a global IPv6 address
    for (const name of Object.keys(interfaces)) {
      const ifaceList = interfaces[name];
      if (!ifaceList) continue;

      for (const iface of ifaceList) {
        // Look for IPv6, not internal (loopback), and not a link-local (fe80:) address
        if (iface.family === 'IPv6' && !iface.internal && !iface.address.startsWith('fe80:')) {
          staticIpv6 = iface.address;
          break; // Grab the first globally routable static IPv6 found
        }
      }
      if (staticIpv6) break;
    }

    if (!staticIpv6) {
      return NextResponse.json({ ip: 'No Static IPv6 Found' });
    }

    return NextResponse.json({ ip: staticIpv6 });
  } catch (error) {
    console.error('Failed to get server IP:', error);
    return NextResponse.json({ error: 'Failed to fetch server IP' }, { status: 500 });
  }
}
