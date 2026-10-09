import nock from 'nock';
jest.mock('@actions/core');
import * as core from '@actions/core';
import { MaestroApi } from '../../src/api';
import { registerJarForEnv } from '../../src/steps/register';
import { Inputs, ResolvedConfig, UploadResult } from '../../src/types';

const BASE = 'https://api.oteligence.com';
function client(): MaestroApi {
  const a = new MaestroApi(BASE);
  a.setToken('jwt');
  return a;
}
const inputs = { service: 'order-service', environment: 'dev' } as Inputs;
const cfg = { projectUid: 'proj_1' } as ResolvedConfig;
const upload = { sha: 'abc', artifactUid: 'art_1', fileName: 'o.jar', sizeBytes: 10 } as UploadResult;
const jarPath = '/api/job-manager/projects/proj_1/envs/dev/services/order-service/jar';

afterEach(() => nock.cleanAll());

it('registers the JAR (source=ci) on the happy path', async () => {
  let seen: any;
  nock(BASE)
    .put(jarPath, (body) => {
      seen = body;
      return true;
    })
    .reply(200, { status: 'OK', data: {} });
  await expect(registerJarForEnv(client(), inputs, cfg, upload, 'build_1')).resolves.toBeUndefined();
  expect(seen.source).toBe('ci');
  expect(seen.sha).toBe('abc');
  expect(seen.jobId).toBe('build_1');
});

it('fails with the server message when the environment is gone (job-manager answers 404)', async () => {
  nock(BASE).put(jarPath).reply(404, { message: 'Environment not found: dev' });
  await expect(registerJarForEnv(client(), inputs, cfg, upload, 'build_1')).rejects.toThrow(/Environment not found: dev/);
});

it("keeps the service input's registration and warns with the analysis's name when they differ", async () => {
  (core.warning as jest.Mock).mockClear();
  const scope = nock(BASE).put(jarPath).reply(200, {});
  await registerJarForEnv(client(), inputs, cfg, upload, 'build_1', ['orders']);
  expect(scope.isDone()).toBe(true);
  expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Register the service as "orders"'));
});

it('warns that the build may lack its locked methods when the analysis key is not the one the lock recorded', async () => {
  (core.warning as jest.Mock).mockClear();
  const pairInputs = { service: 'orders-1.0', environment: 'dev' } as Inputs;
  const locked = {
    projectUid: 'proj_1',
    locked: { registeredJars: { 'orders-1.0': { serviceKey: 'orders@aaaa1111' } } },
  } as unknown as ResolvedConfig;
  nock(BASE).put('/api/job-manager/projects/proj_1/envs/dev/services/orders-1.0/jar').reply(200, {});
  await registerJarForEnv(client(), pairInputs, locked, upload, 'build_1', ['orders@cccc3333', 'orders']);
  const message = (core.warning as jest.Mock).mock.calls[0][0] as string;
  expect(message).toContain('under "orders@aaaa1111"');
  expect(message).toContain('keys its JAR "orders@cccc3333"');
  expect(message).toContain('also named "orders"');
  expect(message).toContain('Re-lock');
});

it('is silent for a pair member whose analysis key is the one the lock recorded for its registration', async () => {
  (core.warning as jest.Mock).mockClear();
  const pairInputs = { service: 'orders-1.0', environment: 'dev' } as Inputs;
  const locked = {
    projectUid: 'proj_1',
    locked: { registeredJars: { 'orders-1.0': { serviceKey: 'orders@aaaa1111' } } },
  } as unknown as ResolvedConfig;
  nock(BASE).put('/api/job-manager/projects/proj_1/envs/dev/services/orders-1.0/jar').reply(200, {});
  await registerJarForEnv(client(), pairInputs, locked, upload, 'build_1', ['orders@aaaa1111', 'orders']);
  expect(core.warning).not.toHaveBeenCalled();
});

it('asks for a re-lock when a pair member is under a lock that recorded no key', async () => {
  (core.warning as jest.Mock).mockClear();
  const pairInputs = { service: 'orders-1.0', environment: 'dev' } as Inputs;
  nock(BASE).put('/api/job-manager/projects/proj_1/envs/dev/services/orders-1.0/jar').reply(200, {});
  await registerJarForEnv(client(), pairInputs, cfg, upload, 'build_1', ['orders@aaaa1111', 'orders']);
  const message = (core.warning as jest.Mock).mock.calls[0][0] as string;
  expect(message).toContain('records no key for the "orders-1.0" registration');
  expect(message).not.toContain('set the "service" input');
});

it('warns about nothing when the analysis agrees or gave no name', async () => {
  (core.warning as jest.Mock).mockClear();
  nock(BASE).put(jarPath).times(3).reply(200, {});
  await registerJarForEnv(client(), inputs, cfg, upload, 'build_1', ['order-service']);
  await registerJarForEnv(client(), inputs, cfg, upload, 'build_1', []);
  await registerJarForEnv(client(), inputs, cfg, upload, 'build_1');
  expect(nock.pendingMocks()).toEqual([]);
  expect(core.warning).not.toHaveBeenCalled();
});

it('registers a pair member under its key once the service input names it', async () => {
  (core.warning as jest.Mock).mockClear();
  const keyed = { service: 'orders@aaaa1111', environment: 'dev' } as Inputs;
  const scope = nock(BASE).put('/api/job-manager/projects/proj_1/envs/dev/services/orders%40aaaa1111/jar').reply(200, {});
  await registerJarForEnv(client(), keyed, cfg, upload, 'build_1', ['orders@aaaa1111', 'orders']);
  expect(scope.isDone()).toBe(true);
  expect(core.warning).not.toHaveBeenCalled();
});

it('is silent when the lock already maps a differently named registration to the analysis name', async () => {
  (core.warning as jest.Mock).mockClear();
  const locked = {
    projectUid: 'proj_1',
    locked: { registeredJars: { 'order-service': { serviceKey: 'orders' } } },
  } as unknown as ResolvedConfig;
  nock(BASE).put(jarPath).reply(200, {});
  await registerJarForEnv(client(), inputs, locked, upload, 'build_1', ['orders']);
  expect(core.warning).not.toHaveBeenCalled();
});

it('warns when a lock from before per-JAR keys files a pair under the shared name', async () => {
  (core.warning as jest.Mock).mockClear();
  const pairInputs = { service: 'orders-1.0', environment: 'dev' } as Inputs;
  const locked = {
    projectUid: 'proj_1',
    locked: {
      registeredJars: { 'orders-1.0': { serviceKey: 'orders@aaaa1111' } },
      selection: [{ service: 'orders', methodFqn: 'a.Api.place' }],
    },
  } as unknown as ResolvedConfig;
  nock(BASE).put('/api/job-manager/projects/proj_1/envs/dev/services/orders-1.0/jar').twice().reply(200, {});
  await registerJarForEnv(client(), pairInputs, locked, upload, 'build_1', ['orders@aaaa1111', 'orders']);
  expect((core.warning as jest.Mock).mock.calls[0][0]).toContain('under that shared name');

  (core.warning as jest.Mock).mockClear();
  (locked.locked as any).selection = [{ service: 'orders@aaaa1111', methodFqn: 'a.Api.place' }];
  await registerJarForEnv(client(), pairInputs, locked, upload, 'build_1', ['orders@aaaa1111', 'orders']);
  expect(core.warning).not.toHaveBeenCalled();
});
