jest.mock('@actions/core');
jest.mock('../src/inputs');
jest.mock('../src/steps/auth');
jest.mock('../src/steps/resolveConfig');
jest.mock('../src/steps/upload');
jest.mock('../src/steps/submitJob');
jest.mock('../src/steps/poll');
jest.mock('../src/steps/download');
jest.mock('../src/steps/analysisService');
jest.mock('../src/steps/register');
jest.mock('../src/steps/staleness');
jest.mock('../src/steps/reportDeployRun');
jest.mock('../src/post');
import * as core from '@actions/core';
import { entry, IS_POST_STATE, run } from '../src/index';
import { post } from '../src/post';
import { parseInputs } from '../src/inputs';
import { resolveLockedConfig } from '../src/steps/resolveConfig';
import { uploadJar } from '../src/steps/upload';
import { submitAnalysis, submitBuild } from '../src/steps/submitJob';
import { downloadArtifacts } from '../src/steps/download';
import { readAnalysisOfUpload } from '../src/steps/analysisService';
import { registerJarForEnv } from '../src/steps/register';

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

describe('main and post stages share one bundle', () => {
  it('marks the post stage before anything can fail', async () => {
    (parseInputs as jest.Mock).mockImplementation(() => { throw new Error('bad input'); });
    await run();
    expect(core.saveState).toHaveBeenCalledWith(IS_POST_STATE, 'true');
    expect(core.setFailed).toHaveBeenCalled();
  });

  it('runs the main step when the post stage is not marked', async () => {
    (core.getState as jest.Mock).mockReturnValue('');
    (readAnalysisOfUpload as jest.Mock).mockResolvedValue({ names: [], notices: [] });
    await entry();
    expect(uploadJar).toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('runs only the post step once the main step has marked it', async () => {
    (core.getState as jest.Mock).mockImplementation((k: string) => (k === IS_POST_STATE ? 'true' : ''));
    await entry();
    expect(post).toHaveBeenCalled();
    expect(parseInputs).not.toHaveBeenCalled();
  });
});
