import * as core from '@actions/core';
import { MaestroApi } from '../api';
import { Inputs, ResolvedConfig, ServiceStaleness } from '../types';
import { UserError } from '../util/errors';
import { envPath } from './resolveConfig';

/**
 * New in v6 (v1-mandatory, Action-side): after the run, report which PEER services
 * this run made stale. The current CCG signature is re-stamped by the ANALYSIS job, so a
 * peer is "made stale by this run" when its staleness `triggeredBy.jobId` equals our
 * analysis job id. This is the only staleness signal that reaches CI/CD-only users.
 *
 * Best-effort: a staleness read failure (e.g. the feature flag is off) is logged at debug
 * and never fails the build — unless `fail-on-warnings` is set and real peers were staled.
 */
export async function warnStalePeers(
  api: MaestroApi,
  inputs: Inputs,
  cfg: ResolvedConfig,
  analysisJobId: string,
  failOnWarnings: boolean,
): Promise<void> {
  let services: ServiceStaleness[] = [];
  try {
    const res = await api.get<{ data?: { services?: ServiceStaleness[] } }>(
      `${envPath(cfg.projectUid, inputs.environment)}/staleness`,
    );
    if (res.statusCode >= 400) {
      core.debug(`Staleness check skipped (HTTP ${res.statusCode}).`);
      return;
    }
    services = res.body?.data?.services ?? [];
  } catch (e) {
    core.debug(`Staleness check failed (non-fatal): ${(e as Error).message}`);
    return;
  }

  const stalePeers = services
    .filter((s) => s.status === 'stale' && s.service !== inputs.service && s.triggeredBy?.jobId === analysisJobId)
    .map((s) => s.service);

  if (stalePeers.length === 0) {
    core.info('No peer services were made stale by this run.');
    return;
  }

  const msg =
    `This run changed the cross-service graph and made these peer services stale: ${stalePeers.join(', ')}. ` +
    `Re-run each one's CI (e.g. \`gh workflow run deploy.yml\`) to refresh its instrumentation.`;
  core.warning(msg);
  if (failOnWarnings) {
    throw new UserError(`fail-on-warnings: ${msg}`);
  }
}
