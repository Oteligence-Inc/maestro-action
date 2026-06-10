import { HttpError } from './errors';

export interface RetryOpts {
  attempts: number;
  baseMs: number;
  maxMs: number;
  /** Injectable sleep so tests don't wait real time. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Exponential backoff for transient failures (Build Spec §5.3): 5xx / 429 / 408
 * are retried; 4xx (user/build-fixable) fail fast. Caps the delay at maxMs.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOpts = { attempts: 3, baseMs: 500, maxMs: 5000 },
): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  let lastErr: unknown;
  for (let i = 0; i < opts.attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isTransient(e) || i === opts.attempts - 1) throw e;
      const wait = Math.min(opts.maxMs, opts.baseMs * 2 ** i);
      await sleep(wait);
    }
  }
  throw lastErr;
}

export function isTransient(e: unknown): boolean {
  if (!(e instanceof HttpError)) return false;
  return e.status >= 500 || e.status === 429 || e.status === 408;
}
