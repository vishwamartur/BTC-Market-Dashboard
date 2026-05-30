import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Delta Exchange usually sees your public IPv4 address, especially if hosted on AWS.
    // Cloud providers use NAT, so the public IP isn't available via os.networkInterfaces().
    
    // Fetch Public IPv4
    const res4 = await fetch('https://api.ipify.org?format=json', { cache: 'no-store' });
    const data4 = await res4.json();
    
    let ipv6 = 'Not Available';
    try {
      // Fetch Public IPv6
      const res6 = await fetch('https://api64.ipify.org?format=json', { cache: 'no-store' });
      const data6 = await res6.json();
      if (data6.ip !== data4.ip) {
        ipv6 = data6.ip;
      }
    } catch (e) {
      // Ignore IPv6 failure
    }

    return NextResponse.json({ 
      ip: data4.ip, 
      ipv4: data4.ip,
      ipv6: ipv6 
    });
  } catch (error) {
    console.error('Failed to get server IP:', error);
    return NextResponse.json({ error: 'Failed to fetch server IP' }, { status: 500 });
  }
}
