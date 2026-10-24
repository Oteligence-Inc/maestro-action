import * as https from 'https';
import { formatError, UserError } from '../src/util/errors';

describe('formatError', () => {
  it('keeps a plain error message', () => {
    expect(formatError(new Error('boom'))).toBe('boom');
    expect(formatError(new UserError('fix the input'))).toBe('fix the input');
  });

  it('names the refused addresses of a connect that failed on every address, never an empty line', async () => {
    const err = await new Promise<unknown>((resolve) => {
      https.get('https://localhost:1/', () => resolve(undefined)).on('error', resolve);
    });
    const text = formatError(err);
    expect(text).toMatch(/^Could not reach the Maestro API: .*ECONNREFUSED (127\.0\.0\.1|::1):1\b/);
  });

  it('falls back to the error code, then the name, when nothing else says what failed', () => {
    const coded = Object.assign(new Error(''), { code: 'ETIMEDOUT' });
    expect(formatError(coded)).toBe('Could not reach the Maestro API: ETIMEDOUT');
    expect(formatError(new AggregateError([], ''))).toBe('Could not reach the Maestro API: AggregateError');
  });
});
