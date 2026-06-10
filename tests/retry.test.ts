import { withRetry, isTransient } from '../src/util/retry';
import { HttpError, UserError } from '../src/util/errors';

const noSleep = () => Promise.resolve();

describe('withRetry', () => {
  it('retries transient 5xx then succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new HttpError(503, '/x');
        return 'ok';
      },
      { attempts: 3, baseMs: 1, maxMs: 1, sleep: noSleep },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does NOT retry a 4xx and rethrows immediately', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new HttpError(404, '/x');
        },
        { attempts: 3, baseMs: 1, maxMs: 1, sleep: noSleep },
      ),
    ).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(1);
  });

  it('gives up after the configured attempts on persistent 5xx', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new HttpError(500, '/x');
        },
        { attempts: 2, baseMs: 1, maxMs: 1, sleep: noSleep },
      ),
    ).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(2);
  });

  it('does not retry non-HTTP errors', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new UserError('nope');
        },
        { attempts: 3, baseMs: 1, maxMs: 1, sleep: noSleep },
      ),
    ).rejects.toBeInstanceOf(UserError);
    expect(calls).toBe(1);
  });
});

describe('isTransient', () => {
  it('classifies 5xx/429/408 as transient and 4xx as not', () => {
    expect(isTransient(new HttpError(500, '/'))).toBe(true);
    expect(isTransient(new HttpError(429, '/'))).toBe(true);
    expect(isTransient(new HttpError(408, '/'))).toBe(true);
    expect(isTransient(new HttpError(404, '/'))).toBe(false);
    expect(isTransient(new Error('boom'))).toBe(false);
  });
});
