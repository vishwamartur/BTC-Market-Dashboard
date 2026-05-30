import { NextResponse } from 'next/server';
import { getDb } from '../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const db = await getDb();
    const config = await db.collection('bot_settings').findOne({ _id: 'config' });
    
    return NextResponse.json({
      isEnabled: config?.isEnabled ?? false,
      isPaperTrade: config?.isPaperTrade ?? true,
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch bot settings' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { isEnabled, isPaperTrade } = body;
    
    const db = await getDb();
    await db.collection('bot_settings').updateOne(
      { _id: 'config' },
      { $set: { isEnabled, isPaperTrade, updatedAt: new Date() } },
      { upsert: true }
    );
    
    return NextResponse.json({ success: true, isEnabled, isPaperTrade });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to update bot settings' }, { status: 500 });
  }
}
