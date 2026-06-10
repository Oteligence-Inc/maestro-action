import nock from 'nock';
jest.mock('@actions/core');
import * as core from '@actions/core';
import { MaestroApi } from '../../src/api';
import { warnStalePeers } from '../../src/steps/staleness';
import { UserError } from '../../src/util/errors';
import { Inputs, ResolvedConfig } from '../../src/types';

const BASE = 'https://api.oteligence.com';
function client(): MaestroApi {
  const a = new MaestroApi(BASE);
  a.setToken('jwt');
  return a;
}
const inputs = { service: 'payment-service', environment: 'dev' } as Inputs;
const cfg = { projectUid: 'proj_1' } as ResolvedConfig;
const stalenessPath = '/api/job-manager/projects/proj_1/envs/dev/staleness';

function reply(services: any[]) {
  nock(BASE).get(stalenessPath).reply(200, { data: { services } });
}

afterEach(() => nock.cleanAll());

it('warns about a peer this run made stale (triggeredBy.jobId === analysis job)', async () => {
  reply([
    { service: 'order-service', status: 'stale', triggeredBy: { service: 'payment-service', jobId: 'job_a' } },
    { service: 'payment-service', status: 'fresh' },
  ]);
  await warnStalePeers(client(), inputs, cfg, 'job_a', false);
  expect(core.warning).toHaveBeenCalledTimes(1);
  expect((core.warning as jest.Mock).mock.calls[0][0]).toContain('order-service');
});

it('does NOT warn about peers staled by an EARLIER run (different jobId)', async () => {
  reply([{ service: 'order-service', status: 'stale', triggeredBy: { jobId: 'some_older_job' } }]);
  await warnStalePeers(client(), inputs, cfg, 'job_a', false);
  expect(core.warning).not.toHaveBeenCalled();
});

it('ignores the service itself even if stale', async () => {
  reply([{ service: 'payment-service', status: 'stale', triggeredBy: { jobId: 'job_a' } }]);
  await warnStalePeers(client(), inputs, cfg, 'job_a', false);
  expect(core.warning).not.toHaveBeenCalled();
});

it('throws when fail-on-warnings is set and a peer was staled', async () => {
  reply([{ service: 'order-service', status: 'stale', triggeredBy: { jobId: 'job_a' } }]);
  await expect(warnStalePeers(client(), inputs, cfg, 'job_a', true)).rejects.toBeInstanceOf(UserError);
});

it('is best-effort: a 404 (flag off / env missing) does not throw or warn', async () => {
  nock(BASE).get(stalenessPath).reply(404, { message: 'not found' });
  await expect(warnStalePeers(client(), inputs, cfg, 'job_a', false)).resolves.toBeUndefined();
  expect(core.warning).not.toHaveBeenCalled();
});
