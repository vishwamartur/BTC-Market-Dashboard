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
    timestamp: Date.now(),
  });

  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;

    const fetchSignal = async () => {
      if (!activeRef.current) return;
      try {
        const res = await fetch('/api/signal');
        if (!res.ok) return;
        const data: SignalResult = await res.json();
        if (activeRef.current) {
          setSignal(data);
        }
      } catch {
        // ignore fetch errors — keep showing last signal
      }
    };

    fetchSignal();
    const interval = setInterval(fetchSignal, POLL_INTERVAL_MS);

    return () => {
      activeRef.current = false;
      clearInterval(interval);
    };
  }, []);

  return signal;
}
