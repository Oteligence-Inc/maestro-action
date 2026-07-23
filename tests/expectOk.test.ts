import { expectOk, ApiResponse } from '../src/api';
import { SubscriptionInactiveError, HttpError } from '../src/util/errors';

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
