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

it('maps a 404 on locked to "not found", since an unlocked environment answers 200 with null data', async () => {
  nock(BASE)
    .get('/api/auth/tenant-projects')
    .query(true)
    .reply(200, { content: [{ uid: 'proj_1', projectName: 'banking-app' }], page: { number: 0, size: 100, totalElements: 1 } });
  nock(BASE)
    .get('/api/job-manager/projects/proj_1/envs/dev/locked')
    .reply(404, { message: 'Environment not found: dev' });

  const err = await resolveLockedConfig(client(), inputs).catch((e: Error) => e);
  expect(String(err)).toMatch(/"dev" in project "banking-app" was not found\./);
  expect(String(err)).not.toMatch(/locked/);
});

it('the 404 message tells the user to check the environment name', async () => {
  nock(BASE)
    .get('/api/auth/tenant-projects')
    .query(true)
    .reply(200, { content: [{ uid: 'proj_1', projectName: 'banking-app' }] });
  nock(BASE).get('/api/job-manager/projects/proj_1/envs/dev/locked').reply(404, {});
  await expect(resolveLockedConfig(client(), inputs)).rejects.toThrow(/Check the environment name/);
});

it('reads an empty 200 on locked as an empty response, not as "not locked yet"', async () => {
  nock(BASE)
    .get('/api/auth/tenant-projects')
    .query(true)
    .reply(200, { content: [{ uid: 'proj_1', projectName: 'banking-app' }] });
  nock(BASE).get('/api/job-manager/projects/proj_1/envs/dev/locked').reply(200, '');
  await expect(resolveLockedConfig(client(), inputs)).rejects.toThrow(/^Locked-config response was empty\.$/);
});

it('throws when the project name is unknown to the tenant', async () => {
  nock(BASE).get('/api/auth/tenant-projects').query(true).reply(200, { content: [], page: { number: 0, size: 100, totalElements: 0 } });
  await expect(resolveLockedConfig(client(), inputs)).rejects.toThrow(/not found/);
});

// ── project-id (UID) resolution — wins over name, validated up front ──────────────
it('uses project-id directly (validated against the tenant) and skips name resolution', async () => {
  const UID = 'b6a6c970c2c54aa6a7816'; // real UID shape — no proj_ prefix
  nock(BASE)
    .get('/api/auth/tenant-projects')
    .query(true)
    .reply(200, { content: [{ uid: UID, projectName: 'otel-3July' }] });
  nock(BASE)
    .get(`/api/job-manager/projects/${UID}/envs/dev/locked`)
    .reply(200, { data: { version: 3, goals: [], selection: [] } });
  nock(BASE)
    .get(`/api/job-manager/projects/${UID}/envs/dev/versions`)
    .reply(200, { data: [{ uid: 'lv_3', versionNum: 3 }] });

  const cfg = await resolveLockedConfig(client(), { projectId: UID, environment: 'dev' } as Inputs);
  expect(cfg.projectUid).toBe(UID);
  expect(cfg.lockedVersionUid).toBe('lv_3');
});

it('project-id wins over a wrong project name — resolves by id, ignores the name', async () => {
  const UID = 'b6a6c970c2c54aa6a7816';
  nock(BASE)
    .get('/api/auth/tenant-projects')
    .query(true)
    .reply(200, { content: [{ uid: UID, projectName: 'otel-3July' }] });
  nock(BASE)
    .get(`/api/job-manager/projects/${UID}/envs/dev/locked`)
    .reply(200, { data: { version: 3, goals: [], selection: [] } });
  nock(BASE)
    .get(`/api/job-manager/projects/${UID}/envs/dev/versions`)
    .reply(200, { data: [{ uid: 'lv_3', versionNum: 3 }] });

  const cfg = await resolveLockedConfig(
    client(),
    { project: 'TYPO-wrong-name', projectId: UID, environment: 'dev' } as Inputs,
  );
  expect(cfg.projectUid).toBe(UID); // id wins; the wrong name is ignored (with a warning)
});

it('throws a clear error when project-id is not in the tenant (validated up front)', async () => {
  nock(BASE)
    .get('/api/auth/tenant-projects')
    .query(true)
    .reply(200, { content: [{ uid: 'someone-else', projectName: 'other' }] });
  await expect(
    resolveLockedConfig(client(), { projectId: 'does-not-exist', environment: 'dev' } as Inputs),
  ).rejects.toThrow(/project-id "does-not-exist" was not found/);
});

it('reads a 200 with null data on locked as "not locked yet", not as an empty response', async () => {
  nock(BASE)
    .get('/api/auth/tenant-projects')
    .query(true)
    .reply(200, { content: [{ uid: 'proj_1', projectName: 'banking-app' }] });
  nock(BASE)
    .get('/api/job-manager/projects/proj_1/envs/dev/locked')
    .reply(200, { status: 'OK', data: null });
  await expect(resolveLockedConfig(client(), inputs)).rejects.toThrow(
    /"dev" in project "banking-app" has not been locked yet/,
  );
});

describe('a project past the first page of tenant projects', () => {
  const firstPage = {
    content: [{ uid: 'proj_a', projectName: 'alpha' }],
    page: { number: 0, size: 100, totalElements: 2, hasNext: true },
  };
  const secondPage = {
    content: [{ uid: 'proj_2', projectName: 'banking-app' }],
    page: { number: 1, size: 100, totalElements: 2, hasNext: false },
  };

  function lockedAndVersions(uid: string) {
    nock(BASE).get(`/api/job-manager/projects/${uid}/envs/dev/locked`)
      .reply(200, { data: { version: 3, goals: [], selection: [] } });
    nock(BASE).get(`/api/job-manager/projects/${uid}/envs/dev/versions`)
      .reply(200, { data: [{ uid: 'lv_3', versionNum: 3 }] });
  }

  it('is found by name on the page that holds it', async () => {
    nock(BASE).get('/api/auth/tenant-projects').query({ page: '0', size: '100' }).reply(200, firstPage);
    nock(BASE).get('/api/auth/tenant-projects').query({ page: '1', size: '100' }).reply(200, secondPage);
    lockedAndVersions('proj_2');
    const cfg = await resolveLockedConfig(client(), inputs);
    expect(cfg.projectUid).toBe('proj_2');
  });

  it('is found by project-id on the page that holds it', async () => {
    nock(BASE).get('/api/auth/tenant-projects').query({ page: '0', size: '100' }).reply(200, firstPage);
    nock(BASE).get('/api/auth/tenant-projects').query({ page: '1', size: '100' }).reply(200, secondPage);
    lockedAndVersions('proj_2');
    const cfg = await resolveLockedConfig(client(), { projectId: 'proj_2', environment: 'dev' } as Inputs);
    expect(cfg.projectUid).toBe('proj_2');
  });

  it('stops reading at the page that holds the match', async () => {
    const second = nock(BASE).get('/api/auth/tenant-projects').query({ page: '1', size: '100' }).reply(200, secondPage);
    nock(BASE).get('/api/auth/tenant-projects').query({ page: '0', size: '100' })
      .reply(200, { ...firstPage, content: [{ uid: 'proj_1', projectName: 'banking-app' }] });
    lockedAndVersions('proj_1');
    const cfg = await resolveLockedConfig(client(), inputs);
    expect(cfg.projectUid).toBe('proj_1');
    expect(second.isDone()).toBe(false);
  });

  it('is reported missing only after the last page', async () => {
    const last = nock(BASE).get('/api/auth/tenant-projects').query({ page: '1', size: '100' })
      .reply(200, { ...secondPage, content: [{ uid: 'proj_b', projectName: 'beta' }] });
    nock(BASE).get('/api/auth/tenant-projects').query({ page: '0', size: '100' }).reply(200, firstPage);
    await expect(resolveLockedConfig(client(), inputs)).rejects.toThrow(/not found for this API key's tenant/);
    expect(last.isDone()).toBe(true);
  });

  it('refuses a listing that never ends after reading 1000 pages', async () => {
    const pages = nock(BASE).get('/api/auth/tenant-projects').query(true).times(1000).reply(200, firstPage);
    await expect(resolveLockedConfig(client(), inputs)).rejects.toThrow(/more than 1000 pages/);
    expect(pages.isDone()).toBe(true);
  });

  it('ends the listing at an empty page that still says more follow', async () => {
    nock(BASE).get('/api/auth/tenant-projects').query({ page: '0', size: '100' }).reply(200, firstPage);
    nock(BASE).get('/api/auth/tenant-projects').query({ page: '1', size: '100' })
      .reply(200, { content: [], page: { number: 1, size: 100, hasNext: true } });
    await expect(resolveLockedConfig(client(), inputs)).rejects.toThrow(/not found for this API key's tenant/);
  });

  it('reports a refusal on a later page as an access problem', async () => {
    nock(BASE).get('/api/auth/tenant-projects').query({ page: '0', size: '100' }).reply(200, firstPage);
    nock(BASE).get('/api/auth/tenant-projects').query({ page: '1', size: '100' }).reply(403, { message: 'no' });
    await expect(resolveLockedConfig(client(), inputs)).rejects.toThrow(/does not have access to project "banking-app"/);
  });

  it('reports any other failure as the HTTP error, not as a missing project', async () => {
    nock(BASE).get('/api/auth/tenant-projects').query({ page: '0', size: '100' }).reply(404, { message: 'gone' });
    const err = await resolveLockedConfig(client(), inputs).catch((e: Error) => e);
    expect(String(err)).not.toMatch(/not found for this API key's tenant/);
    expect(String(err)).toMatch(/404/);
  });

  it('reports an empty listing response instead of a missing project', async () => {
    nock(BASE).get('/api/auth/tenant-projects').query({ page: '0', size: '100' }).reply(200, '');
    await expect(resolveLockedConfig(client(), inputs)).rejects.toThrow(/returned an empty response/);
  });
});
