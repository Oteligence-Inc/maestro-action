import nock from 'nock';
jest.mock('@actions/core');
import { MaestroApi } from '../../src/api';
import { submitAnalysis, submitBuild, buildProfileFromLocked } from '../../src/steps/submitJob';
import { UserError } from '../../src/util/errors';
import { LockedSpec, ResolvedConfig, UploadResult } from '../../src/types';

const BASE = 'https://api.oteligence.com';
function client(): MaestroApi {
  const a = new MaestroApi(BASE);
  a.setToken('jwt');
  return a;
}

const locked: LockedSpec = {
  version: 22,
  goals: ['debug_latency', 'track_errors'],
  apm: 'datadog',
  javaVersion: '17',
  otelVersion: '2.21.0',
  selection: [
    { methodFqn: 'order-service::com.x.Pay.charge', tier: 'deep', service: 'order-service' },
    { methodFqn: 'order-service::com.x.Pay.refund', tier: 'standard' },
    { methodFqn: 'payment-service::com.y.Acct.get', tier: 'high', service: 'payment-service' },
  ],
};
const cfg: ResolvedConfig = { projectUid: 'proj_1', lockedVersionUid: 'lv_9', locked };
const upload: UploadResult = {
  artifactGroupUid: 'grp_1',
  sha: 'abc',
  artifactUid: 'art_1',
  fileName: 'o.jar',
  sizeBytes: 10,
  mustUpload: true,
};

afterEach(() => nock.cleanAll());

describe('buildProfileFromLocked', () => {
  it('maps the locked selection to per-method configs + per-service counts', () => {
    const p = buildProfileFromLocked(locked);
    expect(p.version).toBe(1);
    expect(p.goals).toEqual(['debug_latency', 'track_errors']);
    expect(p.apm).toBe('datadog');
    expect(p.methodConfigurations['order-service::com.x.Pay.charge']).toEqual({ enabled: true, depth: 'deep' });
    // non-deep tiers collapse to "standard"
    expect(p.methodConfigurations['order-service::com.x.Pay.refund']).toEqual({ enabled: true, depth: 'standard' });
    expect(p.methodConfigurations['payment-service::com.y.Acct.get']).toEqual({ enabled: true, depth: 'standard' });
    expect(p.perService['order-service'].selectedCount).toBe(2);
    expect(p.perService['payment-service'].selectedCount).toBe(1);
  });

  it('throws when the locked selection has no usable methods', () => {
    expect(() => buildProfileFromLocked({ ...locked, selection: [] })).toThrow(UserError);
    expect(() => buildProfileFromLocked({ ...locked, selection: [{ methodFqn: 'no-scope-sep' }] })).toThrow(UserError);
  });

  it('excludes tier:"skip" entries so they are never instrumented', () => {
    const p = buildProfileFromLocked({
      ...locked,
      selection: [
        { methodFqn: 'order-service::com.x.Pay.charge', tier: 'deep', service: 'order-service' },
        { methodFqn: 'order-service::com.x.Pay.skipMe', tier: 'skip', service: 'order-service' },
      ],
    });
    expect(p.methodConfigurations['order-service::com.x.Pay.charge']).toEqual({ enabled: true, depth: 'deep' });
    expect(p.methodConfigurations['order-service::com.x.Pay.skipMe']).toBeUndefined();
    expect(p.perService['order-service'].selectedCount).toBe(1); // skip entry not counted
  });
});

describe('submitAnalysis', () => {
  it('submits MULTI_JAR_ANALYSIS with lockedVersionUid + locked goals/apm and returns the job id', async () => {
    let seen: any;
    nock(BASE)
      .post('/api/job-manager/jobs', (body) => {
        seen = body;
        return true;
      })
      .reply(201, { status: 'CREATED', data: { id: 'job_a' } });

    const id = await submitAnalysis(client(), cfg, upload);
    expect(id).toBe('job_a');
    expect(seen.jobType).toBe('MULTI_JAR_ANALYSIS');
    expect(seen.projectUid).toBe('proj_1'); // stamped so ci-runs (project-scoped) finds it
    expect(seen.lockedVersionUid).toBe('lv_9');
    expect(seen.requestJson.artifactGroupUid).toBe('grp_1');
    expect(seen.requestJson.goals).toEqual(['debug_latency', 'track_errors']);
    expect(seen.requestJson.apm).toBe('datadog');
  });

  it('throws when the response carries no job id', async () => {
    nock(BASE).post('/api/job-manager/jobs').reply(201, { data: {} });
    await expect(submitAnalysis(client(), cfg, upload)).rejects.toBeInstanceOf(UserError);
  });
});

describe('submitBuild', () => {
  it('submits MULTI_JAR_EXPLORER_BUILD with the assembled profile + analysisJobId', async () => {
    let seen: any;
    nock(BASE)
      .post('/api/job-manager/jobs', (body) => {
        seen = body;
        return true;
      })
      .reply(201, { data: { jobId: 'build_1' } }); // jobId variant also supported

    const profile = buildProfileFromLocked(locked);
    const id = await submitBuild(client(), cfg, upload, 'job_a', profile);
    expect(id).toBe('build_1');
    expect(seen.jobType).toBe('MULTI_JAR_EXPLORER_BUILD');
    expect(seen.projectUid).toBe('proj_1'); // stamped so ci-runs (project-scoped) finds it
    expect(seen.lockedVersionUid).toBe('lv_9');
    expect(seen.requestJson.analysisJobId).toBe('job_a');
    expect(seen.requestJson.profile.methodConfigurations).toBeDefined();
  });
});
