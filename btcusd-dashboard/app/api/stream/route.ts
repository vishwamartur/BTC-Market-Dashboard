import { NextResponse } from 'next/server';
import { getWsManager, type StreamMessage } from '../../lib/wsManager';
import { insertManyAsync, ensureIndexes } from '../../lib/db';
import type { PendingLiquidation } from '../../lib/wsManager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  // Bootstrap indexes on first connection
  ensureIndexes().catch(() => {});

  // Wire up the batch flush callback (idempotent — last writer wins, same function)
  const manager = getWsManager();
  manager.setFlushCallback((docs: PendingLiquidation[]) => {
    insertManyAsync('liquidations', docs as Record<string, unknown>[]);
  });

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const send = (data: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch {
          closed = true;
        }
      };

      // Subscribe to the shared WS manager
      const unsubscribe = manager.subscribe((msg: StreamMessage) => {
        send(JSON.stringify(msg));
      });

      // Cleanup when the client disconnects
      request.signal.addEventListener('abort', () => {
        closed = true;
        unsubscribe();
      });
    },
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
