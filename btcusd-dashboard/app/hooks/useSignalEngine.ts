'use client';

import { useState, useEffect, useRef } from 'react';
import type { SignalResult } from '../lib/signals';

const POLL_INTERVAL_MS = 5000;

/**
 * Polls the server-side signal engine for the authoritative signal.
 * All props are kept for API compatibility but are now ignored —
 * the server computes the signal from its own data sources.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useSignalEngine(_props: Record<string, unknown> = {}): SignalResult {
  const [signal, setSignal] = useState<SignalResult>({
    overallSignal: 'NEUTRAL',
    confidence: 0,
    score: 0,
    components: [],
    timestamp: 0,
  });

  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const fetchSignal = async () => {
      if (!activeRef.current) return;
      try {
        controller = new AbortController();
        const res = await fetch('/api/signal', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data: SignalResult = await res.json();
        if (activeRef.current) {
          setSignal(data);
        }
      } catch {
        // ignore fetch errors — keep showing last signal
      } finally {
        // Schedule after completion so slow responses cannot overlap and pile
        // up requests in a backgrounded tab.
        if (activeRef.current) timeout = setTimeout(fetchSignal, POLL_INTERVAL_MS);
      }
    };

    void fetchSignal();

    return () => {
      activeRef.current = false;
      controller?.abort();
      if (timeout) clearTimeout(timeout);
    };
  }, []);

  return signal;
}
