import nock from 'nock';
jest.mock('@actions/core');
jest.mock('../../src/steps/resolveConfig', () => ({
  ...jest.requireActual('../../src/steps/resolveConfig'),
  resolveProjectUid: jest.fn().mockResolvedValue('proj_1'),
}));
import * as core from '@actions/core';
import { MaestroApi } from '../../src/api';
import { githubRun, reportDeploy } from '../../src/steps/reportDeploy';
import { resolveProjectUid } from '../../src/steps/resolveConfig';
import { Inputs } from '../../src/types';

const BASE = 'https://api.oteligence.com';
const PATH = '/api/job-manager/projects/proj_1/envs/prod/deploy-reports';
const SHA = 'a'.repeat(40);
function client(): MaestroApi {
  const a = new MaestroApi(BASE);
  a.setToken('jwt');
  return a;
}
const inputs = {
  project: 'shop', projectId: '', environment: 'prod', buildJobId: 'job_build_1', requireDeployReport: false,
} as Inputs;
const GH: Record<string, string> = {
  GITHUB_RUN_ID: '41',
  GITHUB_RUN_ATTEMPT: '2',
  GITHUB_REPOSITORY: 'acme/orders',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_SHA: SHA,
  GITHUB_WORKFLOW: 'Deploy',
};
let saved: Record<string, string | undefined>;

beforeEach(() => {
  jest.clearAllMocks();
  saved = {};
  for (const k of Object.keys(GH)) {
    saved[k] = process.env[k];
    process.env[k] = GH[k];
  }
});
afterEach(() => {
  nock.cleanAll();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

it('posts the build and the run that deployed it, and records the outcome', async () => {
  let sent: any;
  nock(BASE)
    .post(PATH, (b) => {
      sent = b;
      return true;
    })
    .reply(201, { status: 'CREATED', data: { id: 'evt_1' } });

  await expect(reportDeploy(client(), inputs)).resolves.toBe('recorded');

  expect(sent).toEqual({
    buildJobId: 'job_build_1',
    run: {
      provider: 'github', repository: 'acme/orders', runId: 41, runAttempt: 2, commitSha: SHA,
      url: 'https://github.com/acme/orders/actions/runs/41', workflow: 'Deploy',
    },
  });
  expect(core.setOutput).toHaveBeenCalledWith('deploy-report', 'recorded');
  expect(core.warning).not.toHaveBeenCalled();
});

it('reads a repeat of the same run as already recorded', async () => {
  nock(BASE).post(PATH).reply(200, { status: 'OK', data: {} });

  await expect(reportDeploy(client(), inputs)).resolves.toBe('already-recorded');
  expect(core.setOutput).toHaveBeenCalledWith('deploy-report', 'already-recorded');
});

it('warns on a build Maestro did not make for the environment, and still succeeds', async () => {
  nock(BASE).post(PATH).reply(409, { message: 'raw server text', data: { code: 'deploy_report_not_this_env' } });

  await expect(reportDeploy(client(), inputs)).resolves.toBe('refused');

  const warned = (core.warning as jest.Mock).mock.calls[0][0] as string;
  expect(warned).toContain('made no completed build with that id for this environment');
  expect(warned).not.toContain('raw server text');
  expect(core.setOutput).toHaveBeenCalledWith('deploy-report', 'refused');
});

it('fails the step on a refusal under require-deploy-report', async () => {
  nock(BASE).post(PATH).reply(409, { data: { code: 'deploy_report_build_not_completed' } });

  await expect(reportDeploy(client(), { ...inputs, requireDeployReport: true })).rejects.toThrow(
    'the build has not completed',
  );
  expect(core.warning).not.toHaveBeenCalled();
});

it('names an unknown refusal by the server message, and a scope refusal in words', async () => {
  nock(BASE).post(PATH).reply(400, { message: 'run.url must be https', data: { code: 'deploy_report_invalid' } });
  await reportDeploy(client(), inputs);
  expect((core.warning as jest.Mock).mock.calls[0][0]).toContain('refused the report as malformed');

  nock(BASE).post(PATH).reply(403, { message: 'Key scope', data: { code: 'key_scope' } });
  await reportDeploy(client(), inputs);
  expect((core.warning as jest.Mock).mock.calls[1][0]).toContain("API key's scope");

  nock(BASE).post(PATH).reply(418, { message: 'teapot' });
  await reportDeploy(client(), inputs);
  expect((core.warning as jest.Mock).mock.calls[2][0]).toContain('teapot');
});

it('refuses outside a GitHub Actions run without calling Maestro', async () => {
  delete process.env.GITHUB_RUN_ID;
  const scope = nock(BASE).post(PATH).reply(201, {});

  await expect(reportDeploy(client(), inputs)).resolves.toBe('refused');

  expect(scope.isDone()).toBe(false);
  expect(resolveProjectUid).not.toHaveBeenCalled();
  expect((core.warning as jest.Mock).mock.calls[0][0]).toContain('not a GitHub Actions run');
});

it('warns when the project cannot be resolved, and never posts', async () => {
  (resolveProjectUid as jest.Mock).mockRejectedValueOnce(new Error('Project not found'));
  const scope = nock(BASE).post(PATH).reply(201, {});

  await expect(reportDeploy(client(), inputs)).resolves.toBe('refused');
  expect(scope.isDone()).toBe(false);
});

describe('the run a report names', () => {
  it('leaves out what the backend would refuse: a short sha, a non-https server, a formula-like workflow', () => {
    process.env.GITHUB_SHA = 'deadbeef';
    process.env.GITHUB_SERVER_URL = 'http://ghes.internal';
    process.env.GITHUB_WORKFLOW = '=HYPERLINK()';
    process.env.GITHUB_RUN_ATTEMPT = '0';

    expect(githubRun()).toEqual({ provider: 'github', repository: 'acme/orders', runId: 41 });
  });

  it('is none without a run id or a repository', () => {
    process.env.GITHUB_RUN_ID = 'abc';
    expect(githubRun()).toBeNull();
    process.env.GITHUB_RUN_ID = '41';
    delete process.env.GITHUB_REPOSITORY;
    expect(githubRun()).toBeNull();
  });
});
