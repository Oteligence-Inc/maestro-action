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
  // Real persisted shape: BARE methodFqn + separate `service` (matches selection_json in the DB).
  selection: [
    { methodFqn: 'com.x.Pay.charge', tier: 'deep', service: 'order-service', provenance: 'auto' },
    { methodFqn: 'com.x.Pay.refund', tier: 'standard', service: 'order-service', provenance: 'auto' },
    { methodFqn: 'com.y.Acct.get', tier: 'high', service: 'payment-service', provenance: 'auto' },
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
  it('reconstructs SCOPED method keys from a BARE methodFqn + service (real persisted shape)', () => {
    const p = buildProfileFromLocked(locked);
    expect(p.version).toBe(1);
    expect(p.goals).toEqual(['debug_latency', 'track_errors']);
    expect(p.apm).toBe('datadog');
    // methodConfigurations are keyed by "service::Class.method" — reconstructed from the two fields.
    expect(p.methodConfigurations['order-service::com.x.Pay.charge']).toEqual({ enabled: true, depth: 'deep' });
    // non-deep tiers collapse to "standard"
    expect(p.methodConfigurations['order-service::com.x.Pay.refund']).toEqual({ enabled: true, depth: 'standard' });
    expect(p.methodConfigurations['payment-service::com.y.Acct.get']).toEqual({ enabled: true, depth: 'standard' });
    expect(p.perService['order-service'].selectedCount).toBe(2);
    expect(p.perService['payment-service'].selectedCount).toBe(1);
  });

  it('regression: a fully bare-fqn selection is NOT treated as empty', () => {
    // The bug: buildProfileFromLocked required methodFqn to already contain "::", so a locked
    // version with bare fqns produced 0 methodConfigurations and wrongly threw "no selected methods".
    const p = buildProfileFromLocked(locked);
    expect(Object.keys(p.methodConfigurations)).toHaveLength(3);
  });

  it('tolerates an already-scoped methodFqn (defensive) with no separate service field', () => {
    const p = buildProfileFromLocked({
      ...locked,
      selection: [{ methodFqn: 'order-service::com.x.Pay.charge', tier: 'deep' }],
    });
    expect(p.methodConfigurations['order-service::com.x.Pay.charge']).toEqual({ enabled: true, depth: 'deep' });
    expect(p.perService['order-service'].selectedCount).toBe(1);
  });

  it('throws when the locked selection has no usable methods', () => {
    expect(() => buildProfileFromLocked({ ...locked, selection: [] })).toThrow(UserError);
    // bare fqn with no `service` → not resolvable to a scoped key → skipped → empty → throws
    expect(() => buildProfileFromLocked({ ...locked, selection: [{ methodFqn: 'com.x.Orphan.m' }] })).toThrow(UserError);
  });

  it('excludes tier:"skip" entries so they are never instrumented', () => {
    const p = buildProfileFromLocked({
      ...locked,
      selection: [
        { methodFqn: 'com.x.Pay.charge', tier: 'deep', service: 'order-service' },
        { methodFqn: 'com.x.Pay.skipMe', tier: 'skip', service: 'order-service' },
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
