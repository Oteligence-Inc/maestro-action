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

it('sends the org-id input as orgId, escaped, and omits it when unset', async () => {
  const scope = nock(BASE)
    .post('/api/auth/cli/token')
    .query({ orgId: 'org_ci&x' })
    .reply(200, { token: 'jwt-org' });
  const session = await auth(new MaestroApi(BASE), { ...inputs, orgId: 'org_ci&x' } as Inputs);
  expect(scope.isDone()).toBe(true);
  expect(session.token).toBe('jwt-org');
});

it("names the org-id input when the key needs an organization chosen", async () => {
  nock(BASE).post('/api/auth/cli/token').reply(400, {
    success: false,
    message: 'This API key is not scoped to a project and your account belongs to several organizations; pass orgId to choose one',
  });
  await expect(auth(new MaestroApi(BASE), inputs)).rejects.toThrow(/several organizations.*"org-id" input/);
});

it("gives the server's reason for a 403, not a revoked-key message", async () => {
  nock(BASE).post('/api/auth/cli/token').reply(403, {
    success: false,
    message: "This API key's project is not in any organization you belong to",
  });
  const err = auth(new MaestroApi(BASE), inputs);
  await expect(err).rejects.toThrow(/not in any organization you belong to/);
  nock(BASE).post('/api/auth/cli/token').reply(403, {});
  await expect(auth(new MaestroApi(BASE), inputs)).rejects.toThrow(/invalid or has been revoked/);
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

it('does not cite a hardcoded prod billing host when the 402 body omits billing_url', async () => {
  // A run against a dev/self-hosted backend must not be pointed at prod billing. With no billing_url
  // the message falls back to a host-agnostic hint instead of a hardcoded URL.
  nock(BASE).post('/api/auth/cli/token').reply(402, {
    success: false,
    code: 'subscription_inactive',
    status: 'PAST_DUE',
  });

  let caught: unknown;
  try {
    await auth(new MaestroApi(BASE), inputs);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(SubscriptionInactiveError);
  const message = (caught as Error).message;
  expect(message).toContain('PAST_DUE');
  expect(message).not.toContain('app.oteligence.com');
  expect(message).toMatch(/dashboard/i);
});
