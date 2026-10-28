jest.mock('@actions/core');
jest.mock('../../src/steps/resolveConfig', () => ({ resolveProjectUid: jest.fn().mockResolvedValue('proj_1') }));
jest.mock('../../src/steps/ciCheck', () => ({
  ...jest.requireActual('../../src/steps/ciCheck'),
  runCheck: jest.fn(),
  readRepo: jest.fn(),
}));
import * as core from '@actions/core';
import { MaestroApi } from '../../src/api';
import { checkOnly } from '../../src/steps/checkOnly';
import { readRepo, runCheck } from '../../src/steps/ciCheck';
import { Inputs } from '../../src/types';

const api = new MaestroApi('https://api.oteligence.com');
const inputs = { service: 'orders', environment: 'prod', project: 'shop', projectId: '' } as Inputs;
const clean = { service: 'orders', ruleSetDigest: 'd'.repeat(64), total: 0, findings: [] };
const passed = { outcome: 'passed', result: clean, reason: null };

beforeEach(() => {
  jest.clearAllMocks();
  (runCheck as jest.Mock).mockReset().mockResolvedValue(passed);
  (readRepo as jest.Mock).mockReset().mockReturnValue({ files: [], mapping: null });
});

it('checks the service and environment inputs when there is no mapping', async () => {
  await checkOnly(api, inputs, '/repo');
  expect((runCheck as jest.Mock).mock.calls.map((c) => [c[1], c[2], c[3], c[6]])).toEqual([
    ['proj_1', 'prod', 'orders', { checkOnly: true }],
  ]);
  expect(core.setOutput).toHaveBeenCalledWith('log-policy-check', 'passed');
  expect(core.setOutput).toHaveBeenCalledWith('generated', 'false');
});

it('needs the inputs when there is no mapping', async () => {
  await expect(checkOnly(api, { ...inputs, service: '', environment: '' }, '/repo')).rejects.toThrow('needs the service');
  expect(runCheck).not.toHaveBeenCalled();
});

it('checks every pair the mapping lists, once each, fails after the last when one fails, and counts its findings', async () => {
  (readRepo as jest.Mock).mockReturnValue({
    files: [],
    mapping: [
      { service: 'orders', environment: 'prod', paths: ['a/**'] },
      { service: 'orders', environment: 'prod', paths: ['b/**'] },
      { service: 'payments', environment: 'prod', paths: ['c/**'] },
      { service: 'payments', environment: 'staging', paths: ['d/**'] },
    ],
  });
  (runCheck as jest.Mock).mockImplementation(async (_a, _p, env, svc) => {
    if (svc === 'payments' && env === 'prod') {
      return { outcome: 'failed', result: { ...clean, service: svc, total: 3 }, reason: 'the environment fails it' };
    }
    return { outcome: svc === 'orders' ? 'warned' : 'passed', result: { ...clean, service: svc, total: svc === 'orders' ? 2 : 0 }, reason: null };
  });
  await expect(checkOnly(api, inputs, '/repo')).rejects.toThrow('Log policy check failed for payments in prod.');
  expect((runCheck as jest.Mock).mock.calls.map((c) => `${c[3]}@${c[2]}`)).toEqual([
    'orders@prod',
    'payments@prod',
    'payments@staging',
  ]);
  expect(core.error).toHaveBeenCalledWith('Log policy check failed for payments in prod: the environment fails it.');
  expect(core.setOutput).toHaveBeenCalledWith('log-policy-check', 'failed');
  expect(core.setOutput).toHaveBeenCalledWith('log-policy-findings', '5');
});

it('checks the remaining pairs after one that errors, and fails at the end', async () => {
  (readRepo as jest.Mock).mockReturnValue({
    files: [],
    mapping: [
      { service: 'orders', environment: 'prod', paths: ['a/**'] },
      { service: 'payments', environment: 'prod', paths: ['c/**'] },
    ],
  });
  (runCheck as jest.Mock).mockImplementationOnce(async () => {
    throw new Error('socket hang up');
  });
  await expect(checkOnly(api, inputs, '/repo')).rejects.toThrow('Log policy check failed for orders in prod.');
  expect(runCheck).toHaveBeenCalledTimes(2);
  expect(core.error).toHaveBeenCalledWith('Log policy check could not run for orders in prod: socket hang up');
});

it('says not-run when the checks could not run, and off when every environment is off', async () => {
  (runCheck as jest.Mock).mockResolvedValue({ outcome: 'not-run', result: null, reason: null });
  await checkOnly(api, inputs, '/repo');
  expect(core.setOutput).toHaveBeenCalledWith('log-policy-check', 'not-run');

  (runCheck as jest.Mock).mockResolvedValue({ outcome: 'off', result: null, reason: null });
  await checkOnly(api, inputs, '/repo');
  expect(core.setOutput).toHaveBeenLastCalledWith('generated', 'false');
  expect((core.setOutput as jest.Mock).mock.calls.filter((c) => c[0] === 'log-policy-check').pop()).toEqual([
    'log-policy-check',
    'off',
  ]);
});
