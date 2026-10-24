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
import * as core from '@actions/core';
import { run } from '../src/index';
import { reportDeployRun } from '../src/steps/reportDeployRun';
import { pollJob } from '../src/steps/poll';
import { SubscriptionInactiveError } from '../src/util/errors';
import { parseInputs } from '../src/inputs';
import { resolveLockedConfig } from '../src/steps/resolveConfig';
import { uploadJar } from '../src/steps/upload';
import { submitAnalysis, submitBuild } from '../src/steps/submitJob';
import { downloadArtifacts } from '../src/steps/download';
import { readAnalysisOfUpload } from '../src/steps/analysisService';
import { registerJarForEnv } from '../src/steps/register';
import { BuildVerificationError, verifyBuild } from '../src/steps/verify';

const inputs = { service: 'fundtransfer', environment: 'dev', apiUrl: 'https://api.oteligence.com' };

beforeEach(() => {
  (parseInputs as jest.Mock).mockReturnValue(inputs);
  (resolveLockedConfig as jest.Mock).mockResolvedValue({
    projectUid: 'proj_1',
    locked: { version: 3, goals: [], selection: [], registeredJars: {} },
  });
  (uploadJar as jest.Mock).mockResolvedValue({ artifactUid: 'art_1', sha: 'abc' });
  (submitAnalysis as jest.Mock).mockResolvedValue('an_1');
  (submitBuild as jest.Mock).mockResolvedValue('build_1');
  (downloadArtifacts as jest.Mock).mockResolvedValue({ extensionDir: 'x', configPath: 'c', collectorConfigPath: 'k' });
  (verifyBuild as jest.Mock).mockResolvedValue('matched');
});

it("verifies the download against the build's record before registering, and outputs the record's status", async () => {
  (readAnalysisOfUpload as jest.Mock).mockResolvedValue({ names: [], notices: [] });
  await run();
  expect(core.setFailed).not.toHaveBeenCalled();
  expect(verifyBuild).toHaveBeenCalledWith(expect.objectContaining({ extensionDir: 'x', uploadSha: 'abc' }));
  expect((verifyBuild as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
    (registerJarForEnv as jest.Mock).mock.invocationCallOrder[0],
  );
  expect(core.setOutput).toHaveBeenCalledWith('build-record', 'matched');
});

it('registers nothing and fails the step when the download does not match its record', async () => {
  (readAnalysisOfUpload as jest.Mock).mockResolvedValue({ names: [], notices: [] });
  (verifyBuild as jest.Mock).mockRejectedValue(
    new BuildVerificationError('The download does not match the record of its build: x.jar'),
  );
  await run();
  expect(registerJarForEnv).not.toHaveBeenCalled();
  expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('does not match the record of its build'));
  expect(core.setOutput).not.toHaveBeenCalledWith('generated', 'true');
});

it("hands the register step both of the analysis's names, key first", async () => {
  (readAnalysisOfUpload as jest.Mock).mockResolvedValue({ names: ['fund-transfer-service@1a2b3c4d', 'fund-transfer-service'], notices: [] });
  await run();
  expect(core.setFailed).not.toHaveBeenCalled();
  expect(registerJarForEnv).toHaveBeenCalledWith(expect.anything(), inputs, expect.anything(), expect.anything(),
    'build_1', ['fund-transfer-service@1a2b3c4d', 'fund-transfer-service']);
});

it('hands it no name when the analysis gave none', async () => {
  (readAnalysisOfUpload as jest.Mock).mockResolvedValue({ names: [], notices: [] });
  await run();
  expect(registerJarForEnv).toHaveBeenCalledWith(
    expect.anything(), inputs, expect.anything(), expect.anything(), 'build_1', []);
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
  (readAnalysisOfUpload as jest.Mock).mockResolvedValue({ names: [], notices: [] });
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
  });
  await run();
  expect(core.setFailed).not.toHaveBeenCalled();
  expect(core.warning).toHaveBeenCalledWith(
    'The analysis left part of fundtransfer out: 1 class could not be parsed and is not analysed: A.class.');
  expect(core.warning).toHaveBeenCalledWith(
    'The analysis left part of fundtransfer out: The embedded library lib.jar could not be read; its classes are not analysed.');
});

it('warns about nothing when the analysis left nothing out', async () => {
  (readAnalysisOfUpload as jest.Mock).mockResolvedValue({ names: ['fundtransfer'], notices: [] });
  await run();
  expect(core.warning).not.toHaveBeenCalledWith(expect.stringContaining('The analysis left part of'));
});

describe('the deploy-run reports the post step relies on', () => {
  const reports = () => (reportDeployRun as jest.Mock).mock.calls.map((c) => [c[2], c[3], c[4]]);

  beforeEach(() => {
    (readAnalysisOfUpload as jest.Mock).mockResolvedValue({ names: [], notices: [] });
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
