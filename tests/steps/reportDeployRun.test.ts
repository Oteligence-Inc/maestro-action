import nock from 'nock';
jest.mock('@actions/core');
import { MaestroApi } from '../../src/api';
import { reportDeployRun } from '../../src/steps/reportDeployRun';
import { Inputs } from '../../src/types';

const BASE = 'https://api.oteligence.com';
function client(): MaestroApi {
  const a = new MaestroApi(BASE);
  a.setToken('jwt');
  return a;
}
const inputs = { service: 'order-service', environment: 'dev' } as Inputs;
const PATH = '/api/job-manager/projects/proj_1/deploy-runs';

// GITHUB_* env the runner sets — reportDeployRun reads these for run metadata.
const GH: Record<string, string> = {
  GITHUB_RUN_ID: '123456',
  GITHUB_RUN_NUMBER: '7',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_REPOSITORY: 'Oteligence-Inc/order-service',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REF_NAME: 'main',
  GITHUB_SHA: 'deadbeef',
  GITHUB_EVENT_NAME: 'push',
  GITHUB_ACTOR: 'octocat',
  GITHUB_WORKFLOW_REF: 'Oteligence-Inc/order-service/.github/workflows/maestro-deploy.yml@refs/heads/main',
  GITHUB_WORKFLOW: 'Maestro Deploy',
};
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of Object.keys(GH)) {
    saved[k] = process.env[k];
    process.env[k] = GH[k];
  }
});
afterEach(() => {
  for (const k of Object.keys(GH)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  nock.cleanAll();
});

it('POSTs the run metadata to the project deploy-runs endpoint (in_progress)', async () => {
  let seen: any;
  nock(BASE).post(PATH, (b) => { seen = b; return true; }).reply(200, { status: 'OK', data: {} });

  await reportDeployRun(client(), inputs, 'proj_1', 'in_progress', null);

  expect(seen.serviceName).toBe('order-service');
  expect(seen.runId).toBe(123456);
  expect(seen.envName).toBe('dev');
  expect(seen.provider).toBe('github');
  expect(seen.repository).toBe('Oteligence-Inc/order-service');
  expect(seen.workflow).toBe('maestro-deploy.yml'); // derived from GITHUB_WORKFLOW_REF
  expect(seen.runNumber).toBe(7);
  expect(seen.runAttempt).toBe(1);
  expect(seen.refName).toBe('main');
  expect(seen.commitSha).toBe('deadbeef');
  expect(seen.event).toBe('push');
  expect(seen.actor).toBe('octocat');
  expect(seen.htmlUrl).toBe('https://github.com/Oteligence-Inc/order-service/actions/runs/123456');
  expect(seen.status).toBe('in_progress');
  expect(seen.startedAt).toBeDefined();
  expect(seen.completedAt).toBeUndefined();
});

it('sends conclusion + completedAt on the completed report', async () => {
  let seen: any;
  nock(BASE).post(PATH, (b) => { seen = b; return true; }).reply(200, {});

  await reportDeployRun(client(), inputs, 'proj_1', 'completed', 'success');

  expect(seen.status).toBe('completed');
  expect(seen.conclusion).toBe('success');
  expect(seen.completedAt).toBeDefined();
  expect(seen.startedAt).toBeUndefined();
});

it('is best-effort: does not throw when the endpoint returns an error', async () => {
  nock(BASE).post(PATH).reply(400, { message: 'bad' });
  await expect(reportDeployRun(client(), inputs, 'proj_1', 'in_progress', null)).resolves.toBeUndefined();
});

it('skips (no HTTP call) when projectUid is missing', async () => {
  // No nock interceptor registered — a stray POST would throw "no match for request".
  await expect(reportDeployRun(client(), inputs, undefined, 'in_progress', null)).resolves.toBeUndefined();
});

it('skips when not inside a GitHub Actions run (no GITHUB_RUN_ID)', async () => {
  delete process.env.GITHUB_RUN_ID;
  await expect(reportDeployRun(client(), inputs, 'proj_1', 'in_progress', null)).resolves.toBeUndefined();
});
