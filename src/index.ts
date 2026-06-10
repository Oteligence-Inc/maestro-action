import * as core from '@actions/core';
import { parseInputs } from './inputs';
import { MaestroApi } from './api';
import { auth } from './steps/auth';
import { resolveLockedConfig } from './steps/resolveConfig';
import { uploadJar } from './steps/upload';
import { submitAnalysis, submitBuild, buildProfileFromLocked } from './steps/submitJob';
import { pollJob } from './steps/poll';
import { downloadArtifacts } from './steps/download';
import { registerJarForEnv } from './steps/register';
import { warnStalePeers } from './steps/staleness';
import { formatError } from './util/errors';

/**
 * Maestro CI/CD GitHub Action — orchestrates the Step-6 9-step flow:
 * auth → resolve locked config → upload → analyse → build → download → register,
 * then emits a core.warning for any peer services this run made stale.
 */
export async function run(): Promise<void> {
  try {
    const inputs = parseInputs();
    core.info(`Maestro: ${inputs.project}/${inputs.service} @ ${inputs.environment}`);
    const api = new MaestroApi(inputs.apiUrl);

    await auth(api, inputs); // [1]
    const cfg = await resolveLockedConfig(api, inputs); // [2]
    const upload = await uploadJar(api, inputs, cfg); // [3-5]

    const analysisJobId = await submitAnalysis(api, cfg, upload); // [6a]
    await pollJob(api, analysisJobId, { timeoutSeconds: inputs.timeoutSeconds }); // [7a]

    const profile = buildProfileFromLocked(cfg.locked);
    const buildJobId = await submitBuild(api, cfg, upload, analysisJobId, profile); // [6b]
    await pollJob(api, buildJobId, { timeoutSeconds: inputs.timeoutSeconds }); // [7b]

    const paths = await downloadArtifacts(api, buildJobId); // [8]
    await registerJarForEnv(api, inputs, cfg, upload, buildJobId); // [9]

    core.setOutput('extension-dir', paths.extensionDir);
    core.setOutput('config-path', paths.configPath);
    core.setOutput('collector-config-path', paths.collectorConfigPath);
    core.setOutput('locked-version', String(cfg.locked.version));
    core.setOutput('jar-sha', upload.sha);
    core.setOutput('job-id', buildJobId);

    // v6 staleness signal — attributed to the analysis job that re-stamped current signatures.
    await warnStalePeers(api, inputs, cfg, analysisJobId, inputs.failOnWarnings);

    core.info('Maestro instrumentation complete.');
  } catch (err) {
    core.setFailed(formatError(err));
  }
}

// Only auto-run outside the test harness.
if (require.main === module) {
  void run();
}
