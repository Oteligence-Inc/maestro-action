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
import { OPEN_RUN_STATE, PENDING_CONCLUSION_STATE, reportDeployRun } from '../src/steps/reportDeployRun';
import { UserError } from '../src/util/errors';

const inputs = { service: 'order-service', environment: 'dev', apiUrl: 'https://api.oteligence.com' };

function state(values: Record<string, string>): void {
  (core.getState as jest.Mock).mockImplementation((k: string) => values[k] ?? '');
}

beforeEach(() => {
  (parseInputs as jest.Mock).mockReturnValue(inputs);
  (auth as jest.Mock).mockResolvedValue({ token: 'jwt' });
});

it('reports a run the main step was stopped in as completed and cancelled, through the authenticated client', async () => {
  state({ [OPEN_RUN_STATE]: 'proj_1' });
  await post();
  expect(reportDeployRun).toHaveBeenCalledWith(expect.anything(), inputs, 'proj_1', 'completed', 'cancelled');
  expect((reportDeployRun as jest.Mock).mock.calls[0][0]).toBe((auth as jest.Mock).mock.calls[0][0]);
});

it('resends the conclusion of a completed report Maestro did not accept', async () => {
  state({ [OPEN_RUN_STATE]: 'proj_1', [PENDING_CONCLUSION_STATE]: 'success' });
  await post();
  expect(reportDeployRun).toHaveBeenCalledWith(expect.anything(), inputs, 'proj_1', 'completed', 'success');
});

it('reports cancelled for a recorded conclusion it does not know', async () => {
  state({ [OPEN_RUN_STATE]: 'proj_1', [PENDING_CONCLUSION_STATE]: 'neutral' });
  await post();
  expect(reportDeployRun).toHaveBeenCalledWith(expect.anything(), inputs, 'proj_1', 'completed', 'cancelled');
});

it('does nothing when no run is open', async () => {
  state({ [PENDING_CONCLUSION_STATE]: 'success' });
  await post();
  expect(parseInputs).not.toHaveBeenCalled();
  expect(auth).not.toHaveBeenCalled();
  expect(reportDeployRun).not.toHaveBeenCalled();
});

it('warns when the API key no longer authenticates', async () => {
  state({ [OPEN_RUN_STATE]: 'proj_1' });
  (auth as jest.Mock).mockRejectedValue(new UserError('Maestro API key is invalid or has been revoked.'));
  await post();
  expect(reportDeployRun).not.toHaveBeenCalled();
  expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Maestro API key is invalid or has been revoked.'));
});

it('warns when the inputs no longer parse', async () => {
  state({ [OPEN_RUN_STATE]: 'proj_1' });
  (parseInputs as jest.Mock).mockImplementation(() => { throw new UserError('api-url must use https://'); });
  await expect(post()).resolves.toBeUndefined();
  expect(auth).not.toHaveBeenCalled();
  expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('could not report the deploy run as cancelled'));
});
