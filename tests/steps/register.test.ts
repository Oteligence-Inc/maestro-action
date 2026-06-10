import nock from 'nock';
jest.mock('@actions/core');
import { MaestroApi } from '../../src/api';
import { registerJarForEnv } from '../../src/steps/register';
import { UserError } from '../../src/util/errors';
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

it('maps 409 to a service-name-mismatch UserError', async () => {
  nock(BASE).put(jarPath).reply(409, { message: 'service mismatch' });
  await expect(registerJarForEnv(client(), inputs, cfg, upload, 'build_1')).rejects.toThrow(/does not match service/);
});

it('maps 404 to a not-part-of-env UserError', async () => {
  nock(BASE).put(jarPath).reply(404, { message: 'not found' });
  await expect(registerJarForEnv(client(), inputs, cfg, upload, 'build_1')).rejects.toBeInstanceOf(UserError);
});
