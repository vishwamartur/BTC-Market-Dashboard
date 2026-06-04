/**
 * Resilient fetch wrapper with retry, exponential backoff, timeout,
 * and per-host circuit breaker.
 */

// ---------------------------------------------------------------------------
// Circuit breaker state (per host)
// ---------------------------------------------------------------------------

interface CircuitState {
  failures: number;
  openUntil: number; // timestamp — requests are rejected until this time
}

const circuits = new Map<string, CircuitState>();
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_OPEN_DURATION_MS = 30_000; // 30 seconds

function getHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function isCircuitOpen(host: string): boolean {
  const state = circuits.get(host);
  if (!state) return false;
  if (Date.now() < state.openUntil) return true;
  // Half-open: allow one attempt
  return false;
}

function recordSuccess(host: string) {
  circuits.delete(host);
}

function recordFailure(host: string) {
  const state = circuits.get(host) || { failures: 0, openUntil: 0 };
  state.failures++;
  if (state.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    state.openUntil = Date.now() + CIRCUIT_OPEN_DURATION_MS;
    console.warn(`[resilientFetch] Circuit OPEN for ${host} — skipping requests for ${CIRCUIT_OPEN_DURATION_MS / 1000}s`);
  }
  circuits.set(host, state);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ResilientFetchOptions {
  /** Max retries (default: 3). Set to 0 for no retries. */
  retries?: number;
  /** Base backoff delay in ms (default: 500). Doubles each retry. */
  backoffMs?: number;
  /** Request timeout in ms (default: 8000). */
  timeoutMs?: number;
  /** Skip circuit breaker check (default: false). */
  bypassCircuitBreaker?: boolean;
  /** Extra fetch init options (headers, method, body, etc.). */
  init?: RequestInit;
}

const DEFAULTS: Required<Pick<ResilientFetchOptions, 'retries' | 'backoffMs' | 'timeoutMs'>> = {
  retries: 3,
  backoffMs: 500,
  timeoutMs: 8000,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Fetch with automatic retry, exponential backoff, timeout, and circuit breaker.
 *
 * @throws {Error} After all retries exhausted, or if circuit is open.
 */
export async function resilientFetch(
  url: string,
  options: ResilientFetchOptions = {}
): Promise<Response> {
  const { retries, backoffMs, timeoutMs } = { ...DEFAULTS, ...options };
  const host = getHost(url);

  // Circuit breaker check
  if (!options.bypassCircuitBreaker && isCircuitOpen(host)) {
    throw new Error(`[resilientFetch] Circuit open for ${host} — request skipped`);
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, {
        ...options.init,
        signal: controller.signal,
      });

      clearTimeout(timer);

      // Treat 5xx as retryable
      if (response.status >= 500 && attempt < retries) {
        lastError = new Error(`HTTP ${response.status} from ${host}`);
        const delay = backoffMs * Math.pow(2, attempt);
        console.warn(`[resilientFetch] ${url} → ${response.status}, retrying in ${delay}ms (${attempt + 1}/${retries})`);
        await sleep(delay);
        continue;
      }

      // Success or non-retryable error (4xx etc.)
      recordSuccess(host);
      return response;

    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Abort = timeout
      if (lastError.name === 'AbortError') {
        lastError = new Error(`Request to ${host} timed out after ${timeoutMs}ms`);
      }

      if (attempt < retries) {
        const delay = backoffMs * Math.pow(2, attempt);
        console.warn(`[resilientFetch] ${url} failed (${lastError.message}), retrying in ${delay}ms (${attempt + 1}/${retries})`);
        await sleep(delay);
      }
    }
  }

  // All retries exhausted
  recordFailure(host);
  throw lastError || new Error(`resilientFetch: all retries exhausted for ${url}`);
}

/**
 * Convenience: resilient fetch that returns parsed JSON.
 * Returns `null` on failure instead of throwing.
 */
export async function resilientFetchJson<T = unknown>(
  url: string,
  options: ResilientFetchOptions = {}
): Promise<T | null> {
  try {
    const res = await resilientFetch(url, options);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
