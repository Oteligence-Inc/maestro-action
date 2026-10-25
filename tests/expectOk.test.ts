import { expectOk, messageOf, traceOf, ApiResponse } from '../src/api';
import { SubscriptionInactiveError, HttpError, KeyScopeError, ReaderKeyError, UserError } from '../src/util/errors';

const res = (statusCode: number, body: unknown): ApiResponse => ({ statusCode, body });

describe('expectOk — 402 subscription_inactive across wire shapes', () => {
  it('flat body (auth) → SubscriptionInactiveError with status + billing_url', () => {
    const err = () =>
      expectOk(
        res(402, { code: 'subscription_inactive', status: 'SUSPENDED', billing_url: 'https://app/billing' }),
        '/api/auth/cli/token',
      );
    expect(err).toThrow(SubscriptionInactiveError);
    try {
      err();
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain('SUSPENDED');
      expect(m).toContain('https://app/billing');
    }
  });

  it('APIResponse-nested body (job-manager) → SubscriptionInactiveError, not a generic HttpError', () => {
    const err = () =>
      expectOk(
        res(402, {
          status: 'PAYMENT_REQUIRED',
          message: 'Maestro subscription is not active for this tenant',
          data: { code: 'subscription_inactive', status: 'CANCELLED', billing_url: 'https://app/billing' },
        }),
        '/api/job-manager/jobs',
      );
    expect(err).toThrow(SubscriptionInactiveError);
    try {
      err();
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain('CANCELLED'); // read the nested status, not "PAYMENT_REQUIRED"
      expect(m).toContain('https://app/billing');
    }
  });

  it('a non-billing 4xx still throws a generic HttpError', () => {
    expect(() => expectOk(res(400, { message: 'bad' }), '/x')).toThrow(HttpError);
  });
});

describe('I7 — denial reason + trace reach CI', () => {
  it('gateway 402 shape (reason under `error`, top-level traceId) → reason + trace in the message', () => {
    const err = () =>
      expectOk(
        res(402, {
          error: 'Subscription inactive — activate your plan to continue.',
          code: 'subscription_inactive',
          status: 'SUSPENDED',
          billing_url: 'https://app/billing',
          traceId: 'abc123trace',
          correlationId: 'corr-9',
        }),
        '/api/job-manager/jobs',
      );
    expect(err).toThrow(SubscriptionInactiveError);
    try {
      err();
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain('SUSPENDED');
      expect(m).toContain('https://app/billing');
      expect(m).toContain('abc123trace'); // trace id must reach CI
    }
  });

  it('generic gateway error carries its reason (from `error`) AND the trace id', () => {
    const err = () =>
      expectOk(res(500, { error: 'context build failed', correlationId: 'corr-42' }), '/api/context');
    try {
      err();
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain('context build failed'); // was a bare status code before the fix
      expect(m).toContain('corr-42');
    }
  });

  it('messageOf reads `message` first, then falls back to `error`', () => {
    expect(messageOf({ message: 'm', error: 'e' })).toBe('m');
    expect(messageOf({ error: 'only-error' })).toBe('only-error');
    expect(messageOf({})).toBeUndefined();
  });

  it('traceOf reads traceId / correlationId, top-level or nested under data', () => {
    expect(traceOf({ traceId: 't1' })).toBe('t1');
    expect(traceOf({ correlationId: 'c1' })).toBe('c1');
    expect(traceOf({ data: { traceId: 't2' } })).toBe('t2');
    expect(traceOf({})).toBeUndefined();
  });
});

describe('expectOk — 403 reader_read_only from either service', () => {
  const READER_MESSAGE =
    'READER_READ_ONLY: the Reader role can read but not change anything; an organization admin can give this user the Project Admin role.';

  it('file-service flat body → ReaderKeyError naming the key owner and the fix', () => {
    const err = () =>
      expectOk(
        res(403, { error: READER_MESSAGE, message: READER_MESSAGE, code: 'reader_read_only', status: 403 }),
        '/api/file/artifact/upload/batch',
      );
    expect(err).toThrow(ReaderKeyError);
    expect(err).toThrow(UserError);
    expect(err).toThrow(/MAESTRO_API_KEY has the Reader role/);
    expect(err).toThrow(/Project Admin/);
  });

  it('job-manager nested body → ReaderKeyError', () => {
    expect(() =>
      expectOk(
        res(403, { status: 'FORBIDDEN', message: READER_MESSAGE, data: { code: 'reader_read_only' } }),
        '/api/job-manager/jobs',
      ),
    ).toThrow(ReaderKeyError);
  });

  it('another 403 stays an HttpError carrying the server message', () => {
    const err = () =>
      expectOk(res(403, { code: 'tenant_not_provisioned', message: 'no tenant' }), '/api/job-manager/jobs');
    expect(err).toThrow(HttpError);
    expect(err).not.toThrow(ReaderKeyError);
  });
});

describe('expectOk: 403 key_scope from the gateway and the services', () => {
  const SCOPE_MESSAGE = 'This API key works only for project p-1; it cannot act on project p-2.';

  it('gateway and file-service flat body: KeyScopeError carrying the scope and the fix', () => {
    const err = () =>
      expectOk(
        res(403, { error: 'Forbidden', message: SCOPE_MESSAGE, code: 'key_scope', traceId: 't-9' }),
        '/api/file/artifact/upload/batch',
      );
    expect(err).toThrow(KeyScopeError);
    expect(err).toThrow(UserError);
    expect(err).toThrow(/works only for project p-1; it cannot act on project p-2\. MAESTRO_API_KEY works only/);
    expect(err).toThrow(/"project" and "environment" inputs/);
    expect(err).toThrow(/\[trace: t-9\]/);
  });

  it('job-manager nested body: KeyScopeError', () => {
    expect(() =>
      expectOk(res(403, { status: 'FORBIDDEN', message: SCOPE_MESSAGE, data: { code: 'key_scope' } }), '/api/job-manager/jobs'),
    ).toThrow(KeyScopeError);
  });

  it('a 403 with another code is not a KeyScopeError', () => {
    const err = () => expectOk(res(403, { code: 'cli_token_not_allowed', message: 'no' }), '/api/job-manager/jobs');
    expect(err).toThrow(HttpError);
    expect(err).not.toThrow(KeyScopeError);
  });
});
