import * as core from '@actions/core';
import { parseInputs } from './inputs';
import { MaestroApi } from './api';
import { auth } from './steps/auth';
import { DeployRunConclusion, OPEN_RUN_STATE, PENDING_CONCLUSION_STATE, reportDeployRun } from './steps/reportDeployRun';
import { formatError } from './util/errors';
import { Inputs } from './types';

const CONCLUSIONS: DeployRunConclusion[] = ['success', 'failure', 'cancelled'];

/**
 * The post step, bundled separately (src/postMain.ts) so it can never run the pipeline. GitHub runs it after
 * the job's steps whatever their outcome. A deploy run Maestro has not accepted as completed is reported
 * completed: with the conclusion the main step last tried to send, or cancelled when the main step was stopped
 * before it got that far. Otherwise it does nothing. Warns on failure and never fails the step.
 */
export async function post(): Promise<void> {
  const projectUid = core.getState(OPEN_RUN_STATE);
  if (!projectUid) return;
  const pending = core.getState(PENDING_CONCLUSION_STATE) as DeployRunConclusion;
  const conclusion: DeployRunConclusion = CONCLUSIONS.includes(pending) ? pending : 'cancelled';
  let inputs: Inputs;
  try {
    inputs = parseInputs();
  } catch (err) {
    core.warning(`Maestro: could not report the deploy run as ${conclusion} (non-fatal): ${formatError(err)}`);
    return;
  }
  const api = new MaestroApi(inputs.apiUrl);
  try {
    await auth(api, inputs);
  } catch (err) {
    core.warning(`Maestro: could not report the deploy run as ${conclusion} (non-fatal): ${formatError(err)}`);
    return;
  }
  await reportDeployRun(api, inputs, projectUid, 'completed', conclusion);
}
