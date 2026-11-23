import * as core from '@actions/core';
import { MaestroApi, messageOf, traceOf } from '../api';
import { Inputs } from '../types';
import { UserError, formatError } from '../util/errors';
import { envPath, resolveProjectUid } from './resolveConfig';

/** The `deploy-report` output: what Maestro did with the report. */
export type DeployReportOutcome = 'recorded' | 'already-recorded' | 'refused';

/**
 * `report-deploy`: after the workflow's own deploy step, tell Maestro which build it deployed to the environment, for
 * the environment's chained trail and the cockpit's Deployed link. The report is the workflow's claim, worded as such;
 * Maestro accepts it only for a completed build it made for that environment. A refusal warns, or fails the step under
 * `require-deploy-report`.
 */
export async function reportDeploy(api: MaestroApi, inputs: Inputs): Promise<DeployReportOutcome> {
  const run = githubRun();
  if (!run) {
    return refused(inputs, 'a deploy report names the GitHub run that deployed, and this is not a GitHub Actions run');
  }
  let projectUid: string;
  try {
    projectUid = await resolveProjectUid(api, inputs.project, inputs.projectId);
  } catch (err) {
    return refused(inputs, `the project could not be resolved: ${formatError(err)}`);
  }
  const path = `${envPath(projectUid, inputs.environment)}/deploy-reports`;
  let status: number;
  let body: any;
  try {
    const res = await api.post<any>(path, { buildJobId: inputs.buildJobId, run });
    status = res.statusCode;
    body = res.body;
  } catch (err) {
    return refused(inputs, `it could not be sent: ${formatError(err)}`);
  }
  if (status === 201 || status === 200) {
    const outcome: DeployReportOutcome = status === 201 ? 'recorded' : 'already-recorded';
    core.info(
      status === 201
        ? `Maestro recorded that run ${run.runId} deployed build ${inputs.buildJobId} to ${inputs.environment}.`
        : `Maestro already holds this run's report of build ${inputs.buildJobId} to ${inputs.environment}.`,
    );
    core.setOutput('deploy-report', outcome);
    return outcome;
  }
  const code = body?.data?.code ?? body?.code;
  const trace = traceOf(body);
  const reason = REASONS[code as string] ?? messageOf(body) ?? `Maestro answered ${status}`;
  return refused(inputs, `${reason}${trace ? ` (trace ${trace})` : ''}`);
}

const REASONS: Record<string, string> = {
  deploy_report_not_this_env:
    'Maestro made no completed build with that id for this environment. Pass the job-id output of the step that built ' +
    'for this environment',
  deploy_report_build_not_completed: 'the build has not completed',
  deploy_report_invalid: 'Maestro refused the report as malformed',
  deploy_report_api_key_only: 'only an API key may report a deploy',
  key_scope: "the API key's scope does not reach this project or environment",
};

function refused(inputs: Inputs, reason: string): DeployReportOutcome {
  const text = `Maestro did not record the deploy report: ${reason}.`;
  if (inputs.requireDeployReport) throw new UserError(text);
  core.warning(text);
  core.setOutput('deploy-report', 'refused');
  return 'refused';
}

/** The run the report names, from the runner's GITHUB_* variables; null outside a GitHub Actions run. */
export function githubRun(): Record<string, string | number> | null {
  const runId = Number(process.env.GITHUB_RUN_ID);
  const repository = process.env.GITHUB_REPOSITORY;
  if (!Number.isSafeInteger(runId) || runId <= 0 || !repository) return null;
  const run: Record<string, string | number> = { provider: 'github', repository, runId };
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  if (Number.isSafeInteger(attempt) && attempt >= 1) run.runAttempt = attempt;
  const sha = process.env.GITHUB_SHA;
  if (sha && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) run.commitSha = sha;
  const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
  if (server.startsWith('https://')) run.url = `${server}/${repository}/actions/runs/${runId}`;
  const workflow = process.env.GITHUB_WORKFLOW;
  if (workflow && !/^[=+@-]/.test(workflow) && !/[\u0000-\u001f\u007f]/.test(workflow)) {
    run.workflow = workflow.slice(0, 200);
  }
  return run;
}
