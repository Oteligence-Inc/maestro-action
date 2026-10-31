jest.mock('@actions/core');
jest.mock('../src/inputs');
jest.mock('../src/steps/auth');
jest.mock('../src/steps/resolveConfig');
jest.mock('../src/steps/upload');
jest.mock('../src/steps/submitJob');
jest.mock('../src/steps/poll');
jest.mock('../src/steps/download');
jest.mock('../src/steps/verify', () => ({ ...jest.requireActual('../src/steps/verify'), verifyBuild: jest.fn() }));
jest.mock('../src/steps/analysisService');
jest.mock('../src/steps/register');
jest.mock('../src/steps/staleness');
jest.mock('../src/steps/reportDeployRun');
jest.mock('../src/steps/ciCheck');
jest.mock('../src/steps/checkOnly');
import * as core from '@actions/core';
import * as crypto from 'crypto';
import { run } from '../src/index';
import { reportDeployRun } from '../src/steps/reportDeployRun';
import { pollJob } from '../src/steps/poll';
import { SubscriptionInactiveError, UserError } from '../src/util/errors';
import { parseInputs } from '../src/inputs';
import { resolveLockedConfig } from '../src/steps/resolveConfig';
import { uploadJar } from '../src/steps/upload';
import { submitAnalysis, submitBuild } from '../src/steps/submitJob';
import { downloadArtifacts } from '../src/steps/download';
import { readAnalysisOfUpload } from '../src/steps/analysisService';
import { registerJarForEnv } from '../src/steps/register';
import { warnStalePeers } from '../src/steps/staleness';
import { BuildVerificationError, verifyBuild } from '../src/steps/verify';
import { logPolicyCheck, readMapping } from '../src/steps/ciCheck';
import { checkOnly } from '../src/steps/checkOnly';

const inputs = { service: 'fundtransfer', environment: 'dev', apiUrl: 'https://api.oteligence.com' };

beforeEach(() => {
  (pollJob as jest.Mock).mockReset();
  (parseInputs as jest.Mock).mockReturnValue(inputs);
  (resolveLockedConfig as jest.Mock).mockResolvedValue({
    projectUid: 'proj_1',
    locked: { version: 3, goals: [], selection: [], registeredJars: {} },
  });
  (uploadJar as jest.Mock).mockResolvedValue({ artifactUid: 'art_1', sha: 'abc' });
  (submitAnalysis as jest.Mock).mockResolvedValue('an_1');
  (submitBuild as jest.Mock).mockResolvedValue({ jobId: 'build_1', drift: undefined });
  (downloadArtifacts as jest.Mock).mockResolvedValue({ extensionDir: 'x', configPath: 'c', collectorConfigPath: 'k' });
  (verifyBuild as jest.Mock).mockResolvedValue({ record: 'matched', signature: 'verified' });
  (logPolicyCheck as jest.Mock).mockReset().mockResolvedValue(null);
  (readMapping as jest.Mock).mockReturnValue(null);
});

describe('the log policy check', () => {
  const result = { service: 'fundtransfer', ruleSetDigest: 'd'.repeat(64), total: 0, findings: [] };

  it('runs before the upload, and the build carries its result', async () => {
    (readAnalysisOfUpload as jest.Mock).mockResolvedValue({ names: ['fundtransfer'], notices: [], warnings: [] });
    (logPolicyCheck as jest.Mock).mockResolvedValue(result);
    await run();
    expect((logPolicyCheck as jest.Mock).mock.calls[0].slice(0, 4)).toEqual([expect.anything(), 'proj_1', 'dev', 'fundtransfer']);
    expect((logPolicyCheck as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (uploadJar as jest.Mock).mock.invocationCallOrder[0],
    );
    expect((submitBuild as jest.Mock).mock.calls[0][5]).toBe(inputs.service);
    expect((submitBuild as jest.Mock).mock.calls[0][6]).toBe(result);
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('stops the run before the upload when the check fails it, and reports the deploy run failed', async () => {
    (logPolicyCheck as jest.Mock).mockRejectedValue(new UserError('Log policy check failed for fundtransfer in dev'));
    await run();
    expect(uploadJar).not.toHaveBeenCalled();
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Log policy check failed'));
    expect(reportDeployRun).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 'proj_1', 'completed', 'failure');
  });

  it('runs only the check in check-only mode: no lock read, upload, build or deploy run', async () => {
    (parseInputs as jest.Mock).mockReturnValue({ ...inputs, checkOnly: true });
    await run();
    expect(checkOnly).toHaveBeenCalled();
    expect(resolveLockedConfig).not.toHaveBeenCalled();
    expect(uploadJar).not.toHaveBeenCalled();
    expect(reportDeployRun).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });
});

it("warns on the build's drift for its own service right after submitting, before the build is polled", async () => {
  (readAnalysisOfUpload as jest.Mock).mockResolvedValue({ names: ['fundtransfer'], notices: [], warnings: [] });
  (submitBuild as jest.Mock).mockResolvedValue({ jobId: 'build_1', drift: { status: 'checked', lockVersion: 3,
    services: { fundtransfer: { recommendedNotInLock: { count: 1, keys: ['fundtransfer::a.B.added'] },
      lockedNotInJar: { count: 0, keys: [] } } } } });
  await run();
  const warn = (core.warning as jest.Mock).mock;
  const at = warn.calls.findIndex((c) => String(c[0]).includes('fundtransfer::a.B.added'));
  expect(at).toBeGreaterThanOrEqual(0);
  expect(warn.invocationCallOrder[at]).toBeLessThan((pollJob as jest.Mock).mock.invocationCallOrder[1]);
  expect(core.setFailed).not.toHaveBeenCalled();
});

it('does not fail the step on drift with fail-on-warnings set', async () => {
  (parseInputs as jest.Mock).mockReturnValue({ ...inputs, failOnWarnings: true });
  (readAnalysisOfUpload as jest.Mock).mockResolvedValue({ names: ['fundtransfer'], notices: [], warnings: [] });
  (submitBuild as jest.Mock).mockResolvedValue({ jobId: 'build_1', drift: { status: 'checked', lockVersion: 3,
    services: { fundtransfer: { recommendedNotInLock: { count: 0, keys: [] },
      lockedNotInJar: { count: 1, keys: ['fundtransfer::a.B.gone'] } } } } });
  await run();
  expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('fundtransfer::a.B.gone'));
  expect(core.setFailed).not.toHaveBeenCalled();
});

it('reports the drift of a build that then fails', async () => {
  (readAnalysisOfUpload as jest.Mock).mockResolvedValue({ names: ['fundtransfer'], notices: [], warnings: [] });
  (submitBuild as jest.Mock).mockResolvedValue({ jobId: 'build_1', drift: { status: 'checked', lockVersion: 3,
    services: { fundtransfer: { recommendedNotInLock: { count: 1, keys: ['fundtransfer::a.B.added'] },
      lockedNotInJar: { count: 0, keys: [] } } } } });
  (pollJob as jest.Mock).mockImplementation(async (_api, id) => {
    if (id === 'build_1') throw new Error('build failed');
  });
  await run();
  expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('fundtransfer::a.B.added'));
  expect(core.setFailed).toHaveBeenCalled();
});

it('carries on when job-manager sends a drift it cannot read', async () => {
  (readAnalysisOfUpload as jest.Mock).mockResolvedValue({ names: [], notices: [], warnings: [] });
  (submitBuild as jest.Mock).mockResolvedValue({ jobId: 'build_1', drift: 'unexpected' });
  await run();
  expect(core.setFailed).not.toHaveBeenCalled();
});

it("verifies the download against the build's record before registering, and outputs the record's status", async () => {
  (readAnalysisOfUpload as jest.Mock).mockResolvedValue({ names: [], notices: [], warnings: [] });
  await run();
  expect(core.setFailed).not.toHaveBeenCalled();
  expect(verifyBuild).toHaveBeenCalledWith(expect.objectContaining({ extensionDir: 'x', uploadSha: 'abc' }));
  expect((verifyBuild as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
    (registerJarForEnv as jest.Mock).mock.invocationCallOrder[0],
  );
  expect(core.setOutput).toHaveBeenCalledWith('build-record', 'matched');
  expect(core.setOutput).toHaveBeenCalledWith('build-signature', 'verified');
});

it("hands the verify step the workflow's signing key and the lock this run built", async () => {
  const signingKey = crypto.generateKeyPairSync('ed25519').publicKey;
  (parseInputs as jest.Mock).mockReturnValue({ ...inputs, signingKey });
  (resolveLockedConfig as jest.Mock).mockResolvedValue({
    projectUid: 'proj_1',
    lockedVersionUid: 'lv_3',
    locked: { version: 3, goals: [], selection: [], registeredJars: {} },
  });
  (readAnalysisOfUpload as jest.Mock).mockResolvedValue({ names: [], notices: [], warnings: [] });
  await run();
  expect(verifyBuild).toHaveBeenCalledWith(expect.objectContaining({ signingKey, lockedVersionUid: 'lv_3' }));
});

it.each([
  ['verified', /Verified the build's signature/],
  ['not-checked', /signing-public-key is not set, so its signature was not checked/],
  ['unsigned', /The build is unsigned/],
])('says what it made of a %s signature', async (signature, line) => {
  (readAnalysisOfUpload as jest.Mock).mockResolvedValue({ names: [], notices: [], warnings: [] });
  (verifyBuild as jest.Mock).mockResolvedValue({ record: 'recorded', signature });
  await run();
  expect(core.info).toHaveBeenCalledWith(expect.stringMatching(line));
  expect(core.setOutput).toHaveBeenCalledWith('build-signature', signature);
});

it('registers nothing and fails the step when the download does not match its record', async () => {
  (readAnalysisOfUpload as jest.Mock).mockResolvedValue({ names: [], notices: [], warnings: [] });
  (verifyBuild as jest.Mock).mockRejectedValue(
    new BuildVerificationError('The download does not match the record of its build: x.jar'),
  );
  await run();
  expect(registerJarForEnv).not.toHaveBeenCalled();
  expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('does not match the record of its build'));
  expect(core.setOutput).not.toHaveBeenCalledWith('generated', 'true');
});

it('registers nothing when fail-on-warnings stops the run at its stale-peer check', async () => {
  (readAnalysisOfUpload as jest.Mock).mockResolvedValue({ names: [], notices: [], warnings: [] });
  (warnStalePeers as jest.Mock).mockRejectedValueOnce(new UserError('fail-on-warnings: 1 peer made stale'));
  await run();
  expect(registerJarForEnv).not.toHaveBeenCalled();
  expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('fail-on-warnings'));
  expect(core.setOutput).not.toHaveBeenCalledWith('generated', 'true');
});

it('checks stale peers before it registers the JAR', async () => {
  (readAnalysisOfUpload as jest.Mock).mockResolvedValue({ names: [], notices: [], warnings: [] });
  await run();
  expect((warnStalePeers as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
    (registerJarForEnv as jest.Mock).mock.invocationCallOrder[0],
  );
});

it("hands the register step both of the analysis's names, key first", async () => {
  (readAnalysisOfUpload as jest.Mock).mockResolvedValue({ names: ['fund-transfer-service@1a2b3c4d', 'fund-transfer-service'], notices: [], warnings: [] });
  await run();
  expect(core.setFailed).not.toHaveBeenCalled();
  expect(registerJarForEnv).toHaveBeenCalledWith(expect.anything(), inputs, expect.anything(), expect.anything(),
    'build_1', ['fund-transfer-service@1a2b3c4d', 'fund-transfer-service']);
  expect(verifyBuild).toHaveBeenCalledWith(expect.objectContaining({ serviceKey: 'fund-transfer-service@1a2b3c4d' }));
});

it('hands it no name when the analysis gave none', async () => {
  (readAnalysisOfUpload as jest.Mock).mockResolvedValue({ names: [], notices: [], warnings: [] });
  await run();
  expect(registerJarForEnv).toHaveBeenCalledWith(
    expect.anything(), inputs, expect.anything(), expect.anything(), 'build_1', []);
  expect(verifyBuild).toHaveBeenCalledWith(expect.objectContaining({ serviceKey: undefined }));
});

it('refuses a service input the environment does not register, naming the ones it does', async () => {
  (resolveLockedConfig as jest.Mock).mockResolvedValue({
    projectUid: 'proj_1',
    locked: { version: 3, goals: [], selection: [], registeredJars: { 'fund-transfer-service': { sha: 'old' } } },
  });
  await run();
  expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Registered in "dev": fund-transfer-service.'));
  expect(uploadJar).not.toHaveBeenCalled();
});

it('proceeds when the environment registers the service input', async () => {
  (readAnalysisOfUpload as jest.Mock).mockResolvedValue({ names: [], notices: [], warnings: [] });
  (resolveLockedConfig as jest.Mock).mockResolvedValue({
    projectUid: 'proj_1',
    locked: { version: 3, goals: [], selection: [], registeredJars: { fundtransfer: { sha: 'old' } } },
  });
  await run();
  expect(core.setFailed).not.toHaveBeenCalled();
  expect(uploadJar).toHaveBeenCalled();
});

it('warns once per thing the analysis left out of the JAR, and fails nothing', async () => {
  (readAnalysisOfUpload as jest.Mock).mockResolvedValue({
    names: ['fundtransfer'],
    notices: ['1 class could not be parsed and is not analysed: A.class.', 'The embedded library lib.jar could not be read; its classes are not analysed.'],
    warnings: [],
  });
  await run();
  expect(core.setFailed).not.toHaveBeenCalled();
  expect(core.warning).toHaveBeenCalledWith(
    'The analysis left part of fundtransfer out: 1 class could not be parsed and is not analysed: A.class.');
  expect(core.warning).toHaveBeenCalledWith(
    'The analysis left part of fundtransfer out: The embedded library lib.jar could not be read; its classes are not analysed.');
});

it('warns once per in-app tracer the service bundles, and fails nothing', async () => {
  (readAnalysisOfUpload as jest.Mock).mockResolvedValue({
    names: ['fundtransfer'],
    notices: [],
    warnings: ["This service bundles Micrometer's OpenTelemetry bridge."],
  });
  await run();
  expect(core.setFailed).not.toHaveBeenCalled();
  expect(core.warning).toHaveBeenCalledWith(
    "Before you deploy fundtransfer: This service bundles Micrometer's OpenTelemetry bridge.");
});

it('warns about nothing when the analysis left nothing out', async () => {
  (readAnalysisOfUpload as jest.Mock).mockResolvedValue({ names: ['fundtransfer'], notices: [], warnings: [] });
  await run();
  expect(core.warning).not.toHaveBeenCalledWith(expect.stringContaining('The analysis left part of'));
  expect(core.warning).not.toHaveBeenCalledWith(expect.stringContaining('Before you deploy'));
});

describe('the deploy-run reports the post step relies on', () => {
  const reports = () => (reportDeployRun as jest.Mock).mock.calls.map((c) => [c[2], c[3], c[4]]);

  beforeEach(() => {
    (readAnalysisOfUpload as jest.Mock).mockResolvedValue({ names: [], notices: [], warnings: [] });
  });

  it('opens the run before uploading and completes it as a success', async () => {
    (uploadJar as jest.Mock).mockImplementation(async () => {
      expect(reports()).toEqual([['proj_1', 'in_progress', null]]);
      return { artifactUid: 'art_1', sha: 'abc' };
    });
    await run();
    expect(reports()).toEqual([['proj_1', 'in_progress', null], ['proj_1', 'completed', 'success']]);
  });

  it('completes it as a failure when a step throws', async () => {
    (pollJob as jest.Mock).mockRejectedValueOnce(new Error('job failed'));
    await run();
    expect(reports()).toEqual([['proj_1', 'in_progress', null], ['proj_1', 'completed', 'failure']]);
    expect(core.setFailed).toHaveBeenCalled();
  });

  it('completes it as a success when an inactive subscription is skipped by request', async () => {
    (parseInputs as jest.Mock).mockReturnValue({ ...inputs, skipGenerateOnInactive: true });
    (submitAnalysis as jest.Mock).mockRejectedValue(new SubscriptionInactiveError({ status: 'subscription_inactive' }));
    await run();
    expect(reports()).toEqual([['proj_1', 'in_progress', null], ['proj_1', 'completed', 'success']]);
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('completes a removed service skipped by request as a success without opening it', async () => {
    (parseInputs as jest.Mock).mockReturnValue({ ...inputs, skipOnRemovedService: true });
    (resolveLockedConfig as jest.Mock).mockResolvedValue({
      projectUid: 'proj_1',
      locked: { version: 3, goals: [], selection: [], registeredJars: { other: { sha: 'x' } } },
    });
    await run();
    expect(reports()).toEqual([['proj_1', 'completed', 'success']]);
    expect(core.setFailed).not.toHaveBeenCalled();
  });
});
