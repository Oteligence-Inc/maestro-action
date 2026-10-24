import * as core from '@actions/core';
import * as crypto from 'crypto';
import { Inputs } from './types';
import { UserError } from './util/errors';

/**
 * Parse + validate the action inputs. Masks the API key in logs and holds api-url to https on exactly the
 * host trusted-api-host names when it is set, else on an *.oteligence.com host.
 */
export function parseInputs(): Inputs {
  const apiKey = core.getInput('api-key', { required: true });
  core.setSecret(apiKey); // never let the key appear in logs

  // Either `project` (name) or `project-id` (UID) identifies the project — projectId wins.
  // Not marked required individually; we enforce "at least one" below so a correct projectId
  // still runs even if the name was forgotten or mistyped.
  const project = core.getInput('project');
  const projectId = core.getInput('project-id');
  if (!project.trim() && !projectId.trim()) {
    throw new UserError('Provide either "project" (name) or "project-id" (UID).');
  }
  const orgId = core.getInput('org-id').trim();
  const service = core.getInput('service', { required: true });
  const environment = core.getInput('environment', { required: true });
  const jarsGlob = core.getInput('jars', { required: true });

  const apiUrl = normaliseApiUrl(
    core.getInput('api-url', { required: true }),
    core.getInput('trusted-api-host'),
  );

  const timeoutRaw = core.getInput('timeout-seconds') || '300';
  const timeoutSeconds = Number.parseInt(timeoutRaw, 10);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new UserError(`timeout-seconds must be a positive integer, got "${timeoutRaw}".`);
  }

  const failOnWarnings = (core.getInput('fail-on-warnings') || 'false').toLowerCase() === 'true';
  const skipGenerateOnInactive =
    (core.getInput('skip-generate-on-inactive') || 'false').toLowerCase() === 'true';
  const skipOnRemovedService =
    (core.getInput('skip-on-removed-service') || 'false').toLowerCase() === 'true';

  const signingKey = parseSigningKey(core.getInput('signing-public-key'));
  const requireSignedBuild = (core.getInput('require-signed-build') || 'false').toLowerCase() === 'true';
  if (requireSignedBuild && !signingKey) {
    throw new UserError(
      'require-signed-build is set but signing-public-key is empty: an unset variable reads as empty. ' +
        'Supply the platform\'s public key.',
    );
  }

  return {
    apiKey, project, projectId, orgId, service, environment, jarsGlob, apiUrl, timeoutSeconds,
    failOnWarnings, skipGenerateOnInactive, skipOnRemovedService, signingKey,
  };
}

/**
 * The `signing-public-key` input: an Ed25519 public key as PEM, or as the base64 of its X.509 SubjectPublicKeyInfo
 * DER. Null when unset. A private key is refused rather than reduced to its public half.
 */
export function parseSigningKey(raw: string): crypto.KeyObject | null {
  const text = raw.trim();
  if (!text) return null;
  if (/PRIVATE KEY/.test(text)) {
    throw new UserError(
      'signing-public-key holds a private key. Supply the public key only, and replace the signing key: a private key ' +
        'in a workflow is exposed.',
    );
  }
  let key: crypto.KeyObject;
  try {
    if (text.includes('-----BEGIN')) {
      key = crypto.createPublicKey(text);
    } else {
      const compact = text.replace(/\s+/g, '');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) throw new Error('not base64');
      key = crypto.createPublicKey({ key: Buffer.from(compact, 'base64'), format: 'der', type: 'spki' });
    }
  } catch {
    throw new UserError(
      'signing-public-key is not a public key: give the PEM, or the base64 of its X.509 SubjectPublicKeyInfo DER.',
    );
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new UserError(`signing-public-key must be an Ed25519 key, not ${key.asymmetricKeyType ?? 'an unknown type'}.`);
  }
  return key;
}

/**
 * Strips a trailing slash; requires https, and exactly the trusted host when one is set, else an
 * *.oteligence.com host.
 */
export function normaliseApiUrl(raw: string, trustedApiHost = ''): string {
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
  const trusted = trustedHostname(trustedApiHost);
  if (trusted && host !== trusted) {
    throw new UserError(`api-url host "${host}" is not the trusted-api-host "${trusted}".`);
  }
  const isOteligence = host === 'oteligence.com' || host.endsWith('.oteligence.com');
  if (!isOteligence && !trusted) {
    throw new UserError(
      `api-url "${host}" is not an *.oteligence.com host. A private-cloud install names its API host in the trusted-api-host input.`,
    );
  }
  return raw.replace(/\/+$/, '');
}

/**
 * The trusted-api-host input in the form URL parsing gives api-url's hostname (lowercase, punycode, canonical IP),
 * or "" when unset. The refusal does not echo the input, which may carry a pasted URL's password.
 */
function trustedHostname(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (!name) return '';
  let parsed: URL | undefined;
  try {
    parsed = new URL(`https://${name}`);
  } catch {
    parsed = undefined;
  }
  if (!parsed || name.includes('*') || parsed.port || parsed.href !== `https://${parsed.host}/`) {
    throw new UserError(
      'trusted-api-host must be a hostname only, such as maestro.example.internal, with no scheme, port, path or wildcard.',
    );
  }
  return parsed.hostname;
}
