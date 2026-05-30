import { NextResponse } from 'next/server';
import { getDb } from '../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const db = await getDb();
    const settings = await db.collection('settings').findOne({ _id: 'botConfig' });
    
    if (!settings) {
      return NextResponse.json({ isEnabled: false, isPaperTrade: true });
    }
    
    return NextResponse.json({ 
      isEnabled: settings.isEnabled, 
      isPaperTrade: settings.isPaperTrade 
    });
  } catch (error) {
    console.error('Failed to fetch bot settings:', error);
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { isEnabled, isPaperTrade } = await request.json();
    const db = await getDb();
    
    await db.collection('settings').updateOne(
      { _id: 'botConfig' },
      { 
        $set: { 
          isEnabled: Boolean(isEnabled),
          isPaperTrade: Boolean(isPaperTrade)
        } 
      },
      { upsert: true }
    );
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to update bot settings:', error);
    return NextResponse.json({ error: 'Failed to update settings' }, { status: 500 });
  }
}
