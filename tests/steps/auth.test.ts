import nock from 'nock';
jest.mock('@actions/core');
import { MaestroApi } from '../../src/api';
import { auth } from '../../src/steps/auth';
import { SubscriptionInactiveError, UserError } from '../../src/util/errors';
import { Inputs } from '../../src/types';

const BASE = 'https://api.oteligence.com';
const inputs = { apiKey: 'ak_test', apiUrl: BASE } as Inputs;

afterEach(() => nock.cleanAll());

it('exchanges the API key for a JWT and uses it on the next call', async () => {
  nock(BASE)
    .post('/api/auth/cli/token')
    .matchHeader('authorization', 'Bearer ak_test')
    .reply(200, { token: 'jwt-123', tokenType: 'Bearer' });

  const api = new MaestroApi(BASE);
  const session = await auth(api, inputs);
  expect(session.token).toBe('jwt-123');

  // subsequent calls must now carry the JWT, not the api key
  const probe = nock(BASE).get('/probe').matchHeader('authorization', 'Bearer jwt-123').reply(200, {});
  await api.get('/probe');
  expect(probe.isDone()).toBe(true);
});

it('throws a friendly UserError on 401', async () => {
  nock(BASE).post('/api/auth/cli/token').reply(401, { message: 'invalid' });
  await expect(auth(new MaestroApi(BASE), inputs)).rejects.toThrow(/invalid or has been revoked/);
});

it('throws when no token is returned', async () => {
  nock(BASE).post('/api/auth/cli/token').reply(200, {});
  await expect(auth(new MaestroApi(BASE), inputs)).rejects.toBeInstanceOf(UserError);
});

it('throws SubscriptionInactiveError on 402 subscription_inactive with status + billing url', async () => {
  nock(BASE).post('/api/auth/cli/token').reply(402, {
    success: false,
    code: 'subscription_inactive',
    status: 'SUSPENDED',
    billing_url: 'https://app.oteligence.com/billing',
  });

  let caught: unknown;
  try {
    await auth(new MaestroApi(BASE), inputs);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(SubscriptionInactiveError);
  const message = (caught as Error).message;
  expect(message).toMatch(/subscription is not active/i);
  expect(message).toContain('SUSPENDED');
  expect(message).toContain('https://app.oteligence.com/billing');
});
