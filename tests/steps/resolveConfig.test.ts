import nock from 'nock';
jest.mock('@actions/core');
import { MaestroApi } from '../../src/api';
import { resolveLockedConfig } from '../../src/steps/resolveConfig';
import { UserError } from '../../src/util/errors';
import { Inputs } from '../../src/types';

const BASE = 'https://api.oteligence.com';
function client(): MaestroApi {
  const a = new MaestroApi(BASE);
  a.setToken('jwt');
  return a;
}
const inputs = { project: 'banking-app', environment: 'dev' } as Inputs;

afterEach(() => nock.cleanAll());

it('resolves project name → uid, locked config, and the latest version uid', async () => {
  nock(BASE)
    .get('/api/auth/tenant-projects')
    .query(true)
    // Real oteligence-auth shape: PagedResponse returned directly — top-level `content`, no `data` envelope.
    .reply(200, { content: [{ uid: 'proj_1', projectName: 'banking-app' }], page: { number: 0, size: 100, totalElements: 1 } });
  nock(BASE)
    .get('/api/job-manager/projects/proj_1/envs/dev/locked')
    .reply(200, { data: { version: 22, goals: ['debug_latency'], selection: [], apm: 'datadog' } });
  nock(BASE)
    .get('/api/job-manager/projects/proj_1/envs/dev/versions')
    .reply(200, { data: [{ uid: 'lv_9', versionNum: 22 }, { uid: 'lv_8', versionNum: 21 }] });

  const cfg = await resolveLockedConfig(client(), inputs);
  expect(cfg.projectUid).toBe('proj_1');
  expect(cfg.lockedVersionUid).toBe('lv_9'); // newest first
  expect(cfg.locked.version).toBe(22);
});

it('passes a proj_ uid straight through without a tenant-projects lookup', async () => {
  const lockedScope = nock(BASE)
    .get('/api/job-manager/projects/proj_direct/envs/dev/locked')
    .reply(200, { data: { version: 1, goals: [], selection: [] } });
  nock(BASE)
    .get('/api/job-manager/projects/proj_direct/envs/dev/versions')
    .reply(200, { data: [{ uid: 'lv_1', versionNum: 1 }] });

  const cfg = await resolveLockedConfig(client(), { project: 'proj_direct', environment: 'dev' } as Inputs);
  expect(cfg.projectUid).toBe('proj_direct');
  expect(lockedScope.isDone()).toBe(true);
});

it('maps a 404 on locked to a "not locked yet" UserError', async () => {
  nock(BASE)
    .get('/api/auth/tenant-projects')
    .query(true)
    .reply(200, { content: [{ uid: 'proj_1', projectName: 'banking-app' }], page: { number: 0, size: 100, totalElements: 1 } });
  nock(BASE).get('/api/job-manager/projects/proj_1/envs/dev/locked').reply(404, { message: 'no locked version yet' });

  await expect(resolveLockedConfig(client(), inputs)).rejects.toThrow(/has not been locked yet/);
});

it('tolerates a data-wrapped tenant-projects envelope if a gateway adds one', async () => {
  nock(BASE)
    .get('/api/auth/tenant-projects')
    .query(true)
    .reply(200, { data: { content: [{ uid: 'proj_1', projectName: 'banking-app' }] } });
  nock(BASE)
    .get('/api/job-manager/projects/proj_1/envs/dev/locked')
    .reply(200, { data: { version: 5, goals: [], selection: [] } });
  nock(BASE)
    .get('/api/job-manager/projects/proj_1/envs/dev/versions')
    .reply(200, { data: [{ uid: 'lv_5', versionNum: 5 }] });

  const cfg = await resolveLockedConfig(client(), inputs);
  expect(cfg.projectUid).toBe('proj_1');
});

it('throws when the project name is unknown to the tenant', async () => {
  nock(BASE).get('/api/auth/tenant-projects').query(true).reply(200, { content: [], page: { number: 0, size: 100, totalElements: 0 } });
  await expect(resolveLockedConfig(client(), inputs)).rejects.toThrow(/not found/);
});
