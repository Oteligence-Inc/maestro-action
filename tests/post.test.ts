jest.mock('@actions/core');
jest.mock('../src/inputs');
jest.mock('../src/steps/auth');
jest.mock('../src/steps/reportDeployRun', () => ({
  ...jest.requireActual('../src/steps/reportDeployRun'),
  reportDeployRun: jest.fn(),
}));
import * as core from '@actions/core';
import { post } from '../src/post';
import { parseInputs } from '../src/inputs';
import { auth } from '../src/steps/auth';
import { OPEN_RUN_STATE, reportDeployRun } from '../src/steps/reportDeployRun';
import { UserError } from '../src/util/errors';

const inputs = { service: 'order-service', environment: 'dev', apiUrl: 'https://api.oteligence.com' };

function openRun(projectUid: string): void {
  (core.getState as jest.Mock).mockImplementation((k: string) => (k === OPEN_RUN_STATE ? projectUid : ''));
}

beforeEach(() => {
  (parseInputs as jest.Mock).mockReturnValue(inputs);
  (auth as jest.Mock).mockResolvedValue({ token: 'jwt' });
});

it('reports a run the main step left open as completed and cancelled', async () => {
  openRun('proj_1');
  await post();
  expect(auth).toHaveBeenCalled();
  expect(reportDeployRun).toHaveBeenCalledWith(expect.anything(), inputs, 'proj_1', 'completed', 'cancelled');
  expect(core.setFailed).not.toHaveBeenCalled();
});

it('does nothing when the main step closed the run or never opened one', async () => {
  openRun('');
  await post();
  expect(auth).not.toHaveBeenCalled();
  expect(reportDeployRun).not.toHaveBeenCalled();
});

it('warns and fails nothing when the API key no longer authenticates', async () => {
  openRun('proj_1');
  (auth as jest.Mock).mockRejectedValue(new UserError('Maestro API key is invalid or has been revoked.'));
  await post();
  expect(reportDeployRun).not.toHaveBeenCalled();
  expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Maestro API key is invalid or has been revoked.'));
  expect(core.setFailed).not.toHaveBeenCalled();
});
