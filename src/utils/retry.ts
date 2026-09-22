/**
 * Retry with exponential backoff + jitter, AbortSignal aware.
 */
import { createLogger } from './logger.js';

const log = createLogger('retry');

export interface RetryOptions {
  /** Maximum number of attempts (including the first one). Default 3. */
  maxAttempts?: number;
  /** Base delay in ms. Default 500. */
  baseDelayMs?: number;
  /** Max delay cap in ms. Default 15000. */
  maxDelayMs?: number;
  /** Multiplier per attempt. Default 2. */
  factor?: number;
  /** Add random jitter. Default true. */
  jitter?: boolean;
  /** Return true to abort retrying for this error. */
  shouldAbort?: (error: unknown, attempt: number) => boolean;
  /** Called before each retry. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  signal?: AbortSignal;
  label?: string;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(signal!.reason ?? new Error('aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 500,
    maxDelayMs = 15000,
    factor = 2,
    jitter = true,
    shouldAbort,
    onRetry,
    signal,
    label = 'operation',
  } = opts;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts) break;
      if (shouldAbort?.(err, attempt)) {
        log.debug(`${label}: aborting retries`, { attempt, err: String(err) });
        break;
      }
      let delay = Math.min(maxDelayMs, baseDelayMs * factor ** (attempt - 1));
      if (jitter) delay = Math.round(delay * (0.5 + Math.random() * 0.5));
      onRetry?.(err, attempt, delay);
      log.debug(`${label}: attempt ${attempt} failed, retrying in ${delay}ms`, String(err));
      await sleep(delay, signal);
    }
  }
  throw lastError;
}
