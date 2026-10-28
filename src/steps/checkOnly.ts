import * as core from '@actions/core';
import { MaestroApi } from '../api';
import { Inputs } from '../types';
import { UserError } from '../util/errors';
import { MAPPING_FILE, logPolicyCheck, readMapping } from './ciCheck';
import { resolveProjectUid } from './resolveConfig';

/**
 * `check-only`: the log policy check alone, for a repository that holds deployment files and no build. With a
 * `.maestro/check.yml`, every service and environment it lists is checked against the files it maps to them; without
 * one, the `service` and `environment` inputs are checked against every deployment file. Fails the step when any
 * environment's mode fails its check, after every pair has been checked.
 */
export async function checkOnly(api: MaestroApi, inputs: Inputs, root: string): Promise<void> {
  const projectUid = await resolveProjectUid(api, inputs.project, inputs.projectId);
  const mapping = readMapping(root);
  const pairs: { service: string; environment: string }[] = [];
  if (mapping) {
    const seen = new Set<string>();
    for (const e of mapping) {
      const key = `${e.service}\u0000${e.environment}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ service: e.service, environment: e.environment });
    }
  } else {
    if (!inputs.service.trim() || !inputs.environment.trim()) {
      throw new UserError(`A check-only run needs the service and environment inputs, or a ${MAPPING_FILE}.`);
    }
    pairs.push({ service: inputs.service, environment: inputs.environment });
  }
  const failed: string[] = [];
  let checked = 0;
  let findings = 0;
  for (const p of pairs) {
    try {
      const result = await logPolicyCheck(api, projectUid, p.environment, p.service, root, mapping);
      if (result) {
        checked++;
        findings += result.total;
      }
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      core.error(err.message);
      failed.push(`${p.service} in ${p.environment}`);
    }
  }
  // Across every pair: each check set these for itself, and the last one would otherwise stand for all.
  const outcome = failed.length > 0 ? 'failed' : findings > 0 ? 'warned' : checked > 0 ? 'passed' : 'off';
  core.setOutput('log-policy-check', outcome);
  core.setOutput('log-policy-findings', String(findings));
  core.setOutput('generated', 'false');
  if (failed.length > 0) {
    throw new UserError(`Log policy check failed for ${failed.join(', ')}.`);
  }
  core.info(`Log policy check complete for ${pairs.length} service(s); nothing was uploaded or built.`);
}
