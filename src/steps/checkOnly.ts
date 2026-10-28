import * as core from '@actions/core';
import { MaestroApi } from '../api';
import { Inputs } from '../types';
import { UserError, formatError } from '../util/errors';
import { MAPPING_FILE, printable, readRepo, runCheck } from './ciCheck';
import { resolveProjectUid } from './resolveConfig';

/**
 * `check-only`: the log policy check alone, for a repository that holds deployment files and no build. With a
 * `.maestro/check.yml`, every service and environment it lists is checked against the files it maps to them; without
 * one, the `service` and `environment` inputs are checked against every deployment file. Fails the step when any
 * environment's mode fails its check, after every pair has been checked.
 */
export async function checkOnly(api: MaestroApi, inputs: Inputs, root: string): Promise<void> {
  const projectUid = await resolveProjectUid(api, inputs.project, inputs.projectId);
  const repo = readRepo(root);
  const pairs: { service: string; environment: string }[] = [];
  if (repo.mapping) {
    const seen = new Set<string>();
    for (const e of repo.mapping) {
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
  const outcomes = new Set<string>();
  let findings = 0;
  for (const p of pairs) {
    const who = `${printable(p.service)} in ${printable(p.environment)}`;
    try {
      const run = await runCheck(api, projectUid, p.environment, p.service, root, repo, { checkOnly: true });
      outcomes.add(run.outcome);
      findings += run.result?.total ?? 0;
      if (run.outcome === 'failed') {
        core.error(`Log policy check failed for ${who}: ${run.reason}.`);
        failed.push(who);
      }
    } catch (err) {
      core.error(`Log policy check could not run for ${who}: ${formatError(err)}`);
      failed.push(who);
    }
  }
  // Across every pair: a failure anywhere fails the run, and a check that could not run says so.
  const outcome =
    failed.length > 0
      ? 'failed'
      : outcomes.has('not-run')
        ? 'not-run'
        : findings > 0
          ? 'warned'
          : outcomes.has('passed')
            ? 'passed'
            : 'off';
  core.setOutput('log-policy-check', outcome);
  core.setOutput('log-policy-findings', String(findings));
  core.setOutput('generated', 'false');
  if (failed.length > 0) {
    throw new UserError(`Log policy check failed for ${failed.join(', ')}.`);
  }
  core.info(`Log policy check complete for ${pairs.length} service(s); nothing was uploaded or built.`);
}
