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
  const scope = nock(BASE).put(jarPath).reply(200, {});
  await registerJarForEnv(client(), inputs, cfg, upload, 'build_1', 'orders');
  expect(scope.isDone()).toBe(true);
  expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Register the service as "orders"'));
});

it('warns about nothing when the analysis agrees or gave no name', async () => {
  (core.warning as jest.Mock).mockClear();
  nock(BASE).put(jarPath).twice().reply(200, {});
  await registerJarForEnv(client(), inputs, cfg, upload, 'build_1', 'order-service');
  await registerJarForEnv(client(), inputs, cfg, upload, 'build_1', undefined);
  expect(nock.pendingMocks()).toEqual([]);
  expect(core.warning).not.toHaveBeenCalled();
});
