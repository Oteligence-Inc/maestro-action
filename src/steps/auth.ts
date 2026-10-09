import * as core from '@actions/core';
import { MaestroApi, expectOk } from '../api';
import { Inputs, Session } from '../types';
import { UserError } from '../util/errors';

/**
 * [1] Exchange the long-lived API key for a short-lived JWT.
 * POST /api/auth/cli/token with `Authorization: Bearer ak_<api-key>` → { token, ... }, plus `orgId` when the
 * `org-id` input names the organization. The JWT is then used as the Bearer for every later call.
 */
export async function auth(api: MaestroApi, inputs: Inputs): Promise<Session> {
  api.setToken(inputs.apiKey); // the cli/token endpoint authenticates the ak_ key as Bearer
  const query = inputs.orgId ? `?orgId=${encodeURIComponent(inputs.orgId)}` : '';
  const res = await api.post<{ token?: string; code?: string; message?: string }>(`/api/auth/cli/token${query}`, {});
  const refusal = typeof res.body?.message === 'string' ? res.body.message : '';
  if (res.body?.code === 'org_required') {
    throw new UserError(`${refusal}. Set the "org-id" input to the id of the organization to act for.`);
  }
  if (res.statusCode === 403 && refusal) {
    throw new UserError(`Maestro refused this API key: ${refusal}.`);
  }
  if (res.statusCode === 401 || res.statusCode === 403) {
    throw new UserError(
      'Maestro API key is invalid or has been revoked. Create a new key in the project settings and update the MAESTRO_API_KEY GitHub Secret.',
    );
  }
  expectOk(res, '/api/auth/cli/token');
  const token = res.body?.token;
  if (!token) throw new UserError('Auth succeeded but no session token was returned by Maestro.');
  api.setToken(token);
  core.setSecret(token); // the JWT is also a credential — mask it
  core.info('Authenticated with Maestro.');
  return { token };
}
