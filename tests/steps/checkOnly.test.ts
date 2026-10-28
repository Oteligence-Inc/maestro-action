jest.mock('@actions/core');
jest.mock('../../src/steps/resolveConfig', () => ({ resolveProjectUid: jest.fn().mockResolvedValue('proj_1') }));
jest.mock('../../src/steps/ciCheck', () => ({
  ...jest.requireActual('../../src/steps/ciCheck'),
  logPolicyCheck: jest.fn(),
  readMapping: jest.fn(),
}));
import * as core from '@actions/core';
import { MaestroApi } from '../../src/api';
import { checkOnly } from '../../src/steps/checkOnly';
import { logPolicyCheck, readMapping } from '../../src/steps/ciCheck';
import { Inputs } from '../../src/types';
import { UserError } from '../../src/util/errors';

const api = new MaestroApi('https://api.oteligence.com');
const inputs = { service: 'orders', environment: 'prod', project: 'shop', projectId: '' } as Inputs;
const clean = { service: 'orders', ruleSetDigest: 'd'.repeat(64), total: 0, findings: [] };

beforeEach(() => {
  (logPolicyCheck as jest.Mock).mockReset().mockResolvedValue(clean);
  (readMapping as jest.Mock).mockReset().mockReturnValue(null);
});

it('checks the service and environment inputs when there is no mapping', async () => {
  await checkOnly(api, inputs, '/repo');
  expect((logPolicyCheck as jest.Mock).mock.calls.map((c) => [c[1], c[2], c[3]])).toEqual([['proj_1', 'prod', 'orders']]);
  expect(core.setOutput).toHaveBeenCalledWith('log-policy-check', 'passed');
  expect(core.setOutput).toHaveBeenCalledWith('generated', 'false');
});

it('needs the inputs when there is no mapping', async () => {
  await expect(checkOnly(api, { ...inputs, service: '', environment: '' }, '/repo')).rejects.toThrow('needs the service');
  expect(logPolicyCheck).not.toHaveBeenCalled();
});

it('checks every pair the mapping lists, once each, and fails after the last when one fails', async () => {
  (readMapping as jest.Mock).mockReturnValue([
    { service: 'orders', environment: 'prod', paths: ['a/**'] },
    { service: 'orders', environment: 'prod', paths: ['b/**'] },
    { service: 'payments', environment: 'prod', paths: ['c/**'] },
    { service: 'payments', environment: 'staging', paths: ['d/**'] },
  ]);
  (logPolicyCheck as jest.Mock).mockImplementation(async (_a, _p, env, svc) => {
    if (svc === 'payments' && env === 'prod') throw new UserError('Log policy check failed for payments in prod');
    return { ...clean, service: svc, total: svc === 'orders' ? 2 : 0 };
  });
  await expect(checkOnly(api, inputs, '/repo')).rejects.toThrow('Log policy check failed for payments in prod.');
  expect((logPolicyCheck as jest.Mock).mock.calls.map((c) => `${c[3]}@${c[2]}`)).toEqual([
    'orders@prod',
    'payments@prod',
    'payments@staging',
  ]);
  expect(core.setOutput).toHaveBeenCalledWith('log-policy-check', 'failed');
  expect(core.setOutput).toHaveBeenCalledWith('log-policy-findings', '2');
});

it('lets an error that is not a refusal through at once', async () => {
  (logPolicyCheck as jest.Mock).mockRejectedValue(new Error('socket hang up'));
  await expect(checkOnly(api, inputs, '/repo')).rejects.toThrow('socket hang up');
});
