import nock from 'nock';
jest.mock('@actions/core');
import { MaestroApi } from '../../src/api';
import { pollJob } from '../../src/steps/poll';
import { JobFailed, JobTimeout } from '../../src/util/errors';

const BASE = 'https://api.oteligence.com';
function client(): MaestroApi {
  const a = new MaestroApi(BASE);
  a.setToken('jwt');
  return a;
}
const noSleep = () => Promise.resolve();
const statusPath = '/api/job-manager/jobs/job_a/status';

afterEach(() => nock.cleanAll());

it('polls through RUNNING to COMPLETED', async () => {
  nock(BASE).get(statusPath).reply(200, { data: { status: 'RUNNING' } });
  nock(BASE).get(statusPath).reply(200, { data: { status: 'COMPLETED' } });

  const status = await pollJob(client(), 'job_a', {
    timeoutSeconds: 30,
    initialWaitMs: 0,
    intervalMs: 0,
    sleep: noSleep,
  });
  expect(status).toBe('COMPLETED');
});

it('throws JobFailed on a FAILED terminal status', async () => {
  nock(BASE).get(statusPath).reply(200, { data: { status: 'FAILED' } });
  await expect(
    pollJob(client(), 'job_a', { timeoutSeconds: 30, initialWaitMs: 0, intervalMs: 0, sleep: noSleep }),
  ).rejects.toBeInstanceOf(JobFailed);
});

it('throws JobTimeout when the job never reaches a terminal state', async () => {
  nock(BASE).get(statusPath).twice().reply(200, { data: { status: 'RUNNING' } });
  // timeoutSeconds=2, intervalMs=1000 → maxAttempts=2, both RUNNING → timeout
  await expect(
    pollJob(client(), 'job_a', { timeoutSeconds: 2, initialWaitMs: 0, intervalMs: 1000, sleep: noSleep }),
  ).rejects.toBeInstanceOf(JobTimeout);
});
