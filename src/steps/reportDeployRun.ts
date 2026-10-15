import * as core from '@actions/core';
import { MaestroApi } from '../api';
import { Inputs } from '../types';
import { envBase } from './resolveConfig';

export type DeployRunStatus = 'in_progress' | 'completed';
export type DeployRunConclusion = 'success' | 'failure' | 'cancelled' | null;

/** Action state holding the project uid of a run reported in progress whose completion Maestro has not accepted. */
export const OPEN_RUN_STATE = 'deployRunProjectUid';
/** Action state holding the conclusion of the last completed report attempted; the post step resends it. */
export const PENDING_CONCLUSION_STATE = 'deployRunConclusion';

/**
 * Best-effort: report THIS GitHub workflow run to Maestro so it appears in the project's
 * deploy-run history (GET /api/job-manager/projects/{projectUid}/deploy-runs). The backend
 * upserts by (project, service, environment, provider, runId), so we call it twice, once at start
 * ({@code in_progress}) and once at the end ({@code completed} + conclusion), and the two
 * reports converge on one row; a run that deploys this service to two environments keeps one each.
 *
 * NEVER throws: recording is telemetry, and a reporting failure (or running outside GitHub
 * Actions) must not fail the user's deploy. Run metadata comes from the standard GITHUB_*
 * environment variables the runner sets.
 *
 * The in_progress report sets {@link OPEN_RUN_STATE} before its request; a completed report records its
 * conclusion before its request and clears the open run only once Maestro accepts it. The post step closes
 * whatever is still open: with the recorded conclusion, or as cancelled when the main step never got that far.
 */
export async function reportDeployRun(
  api: MaestroApi,
  inputs: Inputs,
  projectUid: string | undefined,
  status: DeployRunStatus,
  conclusion: DeployRunConclusion,
): Promise<void> {
  const runId = Number(process.env.GITHUB_RUN_ID);
  // No project resolved yet, or not running inside a GitHub Actions run → nothing to report.
  if (!projectUid || !Number.isFinite(runId) || runId <= 0) return;

  const repo = process.env.GITHUB_REPOSITORY;
  const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const now = localDateTimeNow(); // LocalDateTime-compatible (no timezone offset)

  if (status === 'in_progress') saveStateSafely(OPEN_RUN_STATE, projectUid);
  else if (conclusion) saveStateSafely(PENDING_CONCLUSION_STATE, conclusion);

  const body = {
    serviceName: inputs.service,
    runId,
    envName: inputs.environment,
    provider: 'github',
    repository: repo,
    workflow: workflowFile(),
    runNumber: intEnv('GITHUB_RUN_NUMBER'),
    runAttempt: intEnv('GITHUB_RUN_ATTEMPT'),
    refName: process.env.GITHUB_REF_NAME,
    commitSha: process.env.GITHUB_SHA,
    event: process.env.GITHUB_EVENT_NAME,
    actor: process.env.GITHUB_ACTOR,
    htmlUrl: repo ? `${server}/${repo}/actions/runs/${runId}` : undefined,
    status,
    conclusion,
    startedAt: status === 'in_progress' ? now : undefined,
    completedAt: status === 'completed' ? now : undefined,
  };

  try {
    const res = await api.post(`${envBase(projectUid)}/deploy-runs`, body);
    if (res.statusCode >= 400) {
      core.warning(`Maestro: deploy-run report returned ${res.statusCode} (non-fatal).`);
    } else {
      core.info(`Maestro: reported deploy run ${runId} (${status}${conclusion ? '/' + conclusion : ''}).`);
      if (status === 'completed') saveStateSafely(OPEN_RUN_STATE, '');
    }
  } catch (err) {
    core.warning(`Maestro: failed to report deploy run (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** State is written to the runner's GITHUB_STATE file, which can throw; reporting must not. */
function saveStateSafely(name: string, value: string): void {
  try {
    core.saveState(name, value);
  } catch (err) {
    core.warning(`Maestro: could not record deploy-run state (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** YYYY-MM-DDTHH:mm:ss (no offset) — parseable by the backend's LocalDateTime field. */
function localDateTimeNow(): string {
  return new Date().toISOString().slice(0, 19);
}

function intEnv(name: string): number | undefined {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : undefined;
}

/**
 * The workflow file name (e.g. {@code maestro-deploy.yml}). GITHUB_WORKFLOW_REF looks like
 * "owner/repo/.github/workflows/maestro-deploy.yml@refs/heads/main"; fall back to the
 * human workflow name in GITHUB_WORKFLOW.
 */
function workflowFile(): string | undefined {
  const ref = process.env.GITHUB_WORKFLOW_REF;
  if (ref) {
    const path = ref.split('@')[0];
    const base = path.substring(path.lastIndexOf('/') + 1);
    if (base) return base;
  }
  return process.env.GITHUB_WORKFLOW;
}
