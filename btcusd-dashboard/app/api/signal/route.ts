import { NextResponse } from 'next/server';
import { getSignalEngine } from '../../lib/signalEngine';
import { readSignalState } from '../../lib/signalState';
import { refreshSignalDataQuality } from '../../lib/signalQuality';

function addLiveDisplayMetrics(signal: ReturnType<ReturnType<typeof getSignalEngine>['getLatestSignal']>) {
  if (signal.rawScore !== undefined) return signal;

  const totalWeight = signal.components.reduce((sum, component) => sum + component.weight, 0);
  const rawScore = totalWeight > 0
    ? signal.components.reduce((sum, component) => sum + component.score * component.weight, 0) / totalWeight
    : 0;
  const provisionalConfidence = Math.min(100, Math.round(
    Math.abs(rawScore) * 60 + totalWeight * 40,
  ));

  return {
    ...signal,
    rawScore: Math.round(rawScore * 1000) / 1000,
    provisionalConfidence,
  };
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const engine = getSignalEngine();
  engine.start();

  // Prefer the durable state: a route handler may run in a separate process
  // from the worker or begin with an empty in-memory singleton.
  let signal = engine.getLatestSignal();
  try {
    const persisted = await readSignalState();
    if (persisted) signal = persisted.latestSignal;
  } catch (error) {
    console.warn('[Signal API] Durable state unavailable; using local engine:', error);
  }

  const dataQuality = refreshSignalDataQuality(signal.dataQuality);
  if (dataQuality) {
    signal = dataQuality.isReady
      ? { ...signal, dataQuality }
      : {
          ...signal,
          overallSignal: 'NEUTRAL',
          confidence: 0,
          score: 0,
          dataQuality,
        };
  }
  signal = addLiveDisplayMetrics(signal);

  return NextResponse.json({
    ...signal,
    serverTime: Date.now(),
  });
}
