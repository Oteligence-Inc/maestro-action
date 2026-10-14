import * as core from '@actions/core';
import { parseInputs } from './inputs';
import { MaestroApi } from './api';
import { auth } from './steps/auth';
import { OPEN_RUN_STATE, reportDeployRun } from './steps/reportDeployRun';
import { formatError } from './util/errors';
import { Inputs } from './types';

/**
 * The post step. GitHub runs it after the job's steps whatever their outcome, including a cancelled
 * run and a main step killed by a timeout. A run the main step reported in progress and never
 * completed is reported completed with conclusion cancelled; otherwise it does nothing. Never fails.
 */
export async function post(): Promise<void> {
  const projectUid = core.getState(OPEN_RUN_STATE);
  if (!projectUid) return;
  let inputs: Inputs;
  try {
    inputs = parseInputs();
  } catch {
    return;
  }
  const api = new MaestroApi(inputs.apiUrl);
  try {
    await auth(api, inputs);
  } catch (err) {
    core.warning(`Maestro: could not report the stopped run as cancelled (non-fatal): ${formatError(err)}`);
    return;
  }
  await reportDeployRun(api, inputs, projectUid, 'completed', 'cancelled');
}
