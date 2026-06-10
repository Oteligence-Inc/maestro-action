import * as core from '@actions/core';
import { Inputs } from './types';
import { UserError } from './util/errors';

/**
 * Parse + validate the action inputs. Masks the API key in logs (Build Spec §13 #1)
 * and enforces an https-only, oteligence.com-allow-listed api-url (§13 #2/#9) — a
 * custom host requires the explicit MAESTRO_ALLOW_CUSTOM_API_URL=1 opt-in.
 */
export function parseInputs(): Inputs {
  const apiKey = core.getInput('api-key', { required: true });
  core.setSecret(apiKey); // never let the key appear in logs

  const project = core.getInput('project', { required: true });
  const service = core.getInput('service', { required: true });
  const environment = core.getInput('environment', { required: true });
  const jarsGlob = core.getInput('jars', { required: true });

  const apiUrl = normaliseApiUrl(core.getInput('api-url') || 'https://api.oteligence.com');

  const timeoutRaw = core.getInput('timeout-seconds') || '300';
  const timeoutSeconds = Number.parseInt(timeoutRaw, 10);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new UserError(`timeout-seconds must be a positive integer, got "${timeoutRaw}".`);
  }

  const failOnWarnings = (core.getInput('fail-on-warnings') || 'false').toLowerCase() === 'true';

  return { apiKey, project, service, environment, jarsGlob, apiUrl, timeoutSeconds, failOnWarnings };
}

/** Strips a trailing slash, enforces https + the oteligence.com allow-list. */
export function normaliseApiUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UserError(`api-url is not a valid URL: "${raw}".`);
  }
  if (url.protocol !== 'https:') {
    throw new UserError(`api-url must use https:// — got "${raw}".`);
  }
  const host = url.hostname.toLowerCase();
  const isOteligence = host === 'oteligence.com' || host.endsWith('.oteligence.com');
  const allowCustom = process.env.MAESTRO_ALLOW_CUSTOM_API_URL === '1';
  if (!isOteligence && !allowCustom) {
    throw new UserError(
      `api-url "${host}" is not an *.oteligence.com host. Set env MAESTRO_ALLOW_CUSTOM_API_URL=1 to override (advanced/testing only).`,
    );
  }
  return raw.replace(/\/+$/, '');
}
