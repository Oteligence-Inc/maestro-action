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
import * as core from '@actions/core';
import { run } from '../src/index';
import { parseInputs } from '../src/inputs';
import { resolveLockedConfig } from '../src/steps/resolveConfig';
import { uploadJar } from '../src/steps/upload';
import { submitAnalysis, submitBuild } from '../src/steps/submitJob';
import { downloadArtifacts } from '../src/steps/download';
import { analysisServiceNames } from '../src/steps/analysisService';
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

it("registers the JAR under the analysis's key for it", async () => {
  (analysisServiceNames as jest.Mock).mockResolvedValue(['fund-transfer-service@1a2b3c4d', 'fund-transfer-service']);
  await run();
  expect(core.setFailed).not.toHaveBeenCalled();
  expect(registerJarForEnv).toHaveBeenCalledWith(
    expect.anything(), inputs, expect.anything(), expect.anything(), 'build_1', 'fund-transfer-service@1a2b3c4d');
});

it('registers under the service input when the analysis gave no name', async () => {
  (analysisServiceNames as jest.Mock).mockResolvedValue([]);
  await run();
  expect(registerJarForEnv).toHaveBeenCalledWith(
    expect.anything(), inputs, expect.anything(), expect.anything(), 'build_1', undefined);
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
