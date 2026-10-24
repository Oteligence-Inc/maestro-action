import * as core from '@actions/core';
import { parseInputs } from './inputs';
import { MaestroApi } from './api';
import { auth } from './steps/auth';
import { resolveLockedConfig } from './steps/resolveConfig';
import { uploadJar } from './steps/upload';
import { submitAnalysis, submitBuild, buildProfileFromLocked } from './steps/submitJob';
import { pollJob } from './steps/poll';
import { downloadArtifacts } from './steps/download';
import { verifyBuild } from './steps/verify';
import { readAnalysisOfUpload } from './steps/analysisService';
import { registerJarForEnv } from './steps/register';
import { warnStalePeers } from './steps/staleness';
import { reportDeployRun } from './steps/reportDeployRun';
import { formatError, RemovedServiceError, SubscriptionInactiveError } from './util/errors';
import { Inputs } from './types';

/**
 * Maestro CI/CD GitHub Action — orchestrates the Step-6 9-step flow:
 * auth → resolve locked config → upload → analyse → build → download → register,
 * then emits a core.warning for any peer services this run made stale.
 *
 * Once the project is resolved, the run is reported to Maestro's deploy-run history
 * (in_progress at start, completed+conclusion at the end) — best-effort, never fatal. A run the
 * job stops before it completes is closed by the post step (src/post.ts).
 */
export async function run(): Promise<void> {
  let inputs: Inputs;
  try {
    inputs = parseInputs();
  } catch (err) {
    core.setFailed(formatError(err));
    return;
  }
  core.info(`Maestro: ${inputs.project || inputs.projectId}/${inputs.service} @ ${inputs.environment}`);
  const api = new MaestroApi(inputs.apiUrl);
  let projectUid: string | undefined;

  try {
    await auth(api, inputs); // [1]
    const cfg = await resolveLockedConfig(api, inputs); // [2]
    projectUid = cfg.projectUid;

    // [2b] Early removed-service guard: if this service isn't in the env's locked config it was removed
    // from the project. Detect it HERE — before upload/analyse/build — so a removed service never re-runs
    // the pipeline, re-registers, or re-bills. Only trip when registeredJars is populated (a lock exists)
    // and the service is genuinely absent.
    const registered = cfg.locked.registeredJars;
    if (registered && Object.keys(registered).length > 0 && !(inputs.service in registered)) {
      throw new RemovedServiceError(inputs.service, inputs.environment, Object.keys(registered));
    }

    await reportDeployRun(api, inputs, projectUid, 'in_progress', null); // deploy-run: start

    const upload = await uploadJar(api, inputs, cfg); // [3-5]

    const analysisJobId = await submitAnalysis(api, cfg, upload); // [6a]
    await pollJob(api, analysisJobId, { timeoutSeconds: inputs.timeoutSeconds }); // [7a]

    const profile = buildProfileFromLocked(cfg.locked);
    const buildJobId = await submitBuild(api, cfg, upload, analysisJobId, profile); // [6b]
    await pollJob(api, buildJobId, { timeoutSeconds: inputs.timeoutSeconds }); // [7b]

    const analysis = await readAnalysisOfUpload(api, analysisJobId, upload.artifactUid);
    for (const notice of analysis.notices) {
      core.warning(`The analysis left part of ${inputs.service} out: ${notice}`);
    }
    const analysisNames = analysis.names;
    const paths = await downloadArtifacts(api, buildJobId, inputs.service, analysisNames); // [8]
    // [8b] Every downloaded file against the record of the build's inputs, before anything registers or deploys it.
    const verified = await verifyBuild({
      ...paths,
      uploadSha: upload.sha,
      serviceKey: analysisNames[0],
      signingKey: inputs.signingKey,
      lockedVersionUid: cfg.lockedVersionUid,
    });
    core.info(`Verified the build's files against its record (${verified.record}).`);
    core.info(SIGNATURE_LINES[verified.signature]);
    await registerJarForEnv(api, inputs, cfg, upload, buildJobId, analysisNames); // [9]

    core.setOutput('extension-dir', paths.extensionDir);
    core.setOutput('config-path', paths.configPath);
    core.setOutput('collector-config-path', paths.collectorConfigPath);
    core.setOutput('locked-version', String(cfg.locked.version));
    core.setOutput('jar-sha', upload.sha);
    core.setOutput('job-id', buildJobId);
    core.setOutput('build-record', verified.record);
    core.setOutput('build-signature', verified.signature);
    core.setOutput('generated', 'true');

    // v6 staleness signal — attributed to the analysis job that re-stamped current signatures.
    await warnStalePeers(api, inputs, cfg, analysisJobId, inputs.failOnWarnings);

    await reportDeployRun(api, inputs, projectUid, 'completed', 'success'); // deploy-run: done
    core.info('Maestro instrumentation complete.');
  } catch (err) {
    // Graceful degradation (opt-in): the service was removed from the project (not in the env's locked
    // config). With skip-on-removed-service set, DON'T fail — skip generation and let the pipeline
    // continue (deploy runs without a newly generated extension) rather than breaking CI for a service
    // that no longer exists. Default off: a removed/typo'd service hard-fails with the clear message.
    if (err instanceof RemovedServiceError && inputs.skipOnRemovedService) {
      core.warning(
        `Skipping instrumentation — ${formatError(err)} (skip-on-removed-service is set). ` +
          'The pipeline will continue WITHOUT a newly generated extension JAR.',
      );
      core.setOutput('generated', 'false');
      core.setOutput('extension-dir', '');
      core.setOutput('config-path', '');
      core.setOutput('collector-config-path', '');
      core.setOutput('build-record', '');
      core.setOutput('build-signature', '');
      await reportDeployRun(api, inputs, projectUid, 'completed', 'success');
      return; // exit 0 — removed service is not a failure when opted in
    }
    // Graceful degradation (opt-in): when the subscription is inactive (402 subscription_inactive)
    // and skip-generate-on-inactive is set, DON'T fail the step — skip extension-JAR generation and
    // let the pipeline continue so the deploy still runs (just without a newly generated extension).
    // The generated=false output lets the workflow omit the OTel layer. Only a genuine 402 reaches
    // here; any other error still fails the step.
    if (err instanceof SubscriptionInactiveError && inputs.skipGenerateOnInactive) {
      core.warning(
        'Maestro subscription is not active — skipping extension-JAR generation. The pipeline will ' +
          'continue and deploy WITHOUT a newly generated extension JAR. ' +
          formatError(err),
      );
      core.setOutput('generated', 'false');
      // Clear the extension outputs so the workflow's assemble/bake step can gate on `generated`.
      core.setOutput('extension-dir', '');
      core.setOutput('config-path', '');
      core.setOutput('collector-config-path', '');
      core.setOutput('build-record', '');
      core.setOutput('build-signature', '');
      // Telemetry only (never fatal); records that this run reached completion in a degraded mode.
      await reportDeployRun(api, inputs, projectUid, 'completed', 'success');
      return; // exit 0 — the step succeeds; deploy is not blocked
    }
    await reportDeployRun(api, inputs, projectUid, 'completed', 'failure'); // deploy-run: failed (best-effort)
    core.setFailed(formatError(err));
  }
}

const SIGNATURE_LINES = {
  verified: "Verified the build's signature with signing-public-key.",
  'not-checked': 'The build is signed, but signing-public-key is not set, so its signature was not checked.',
  unsigned: 'The build is unsigned: the Maestro platform that built it holds no signing key.',
} as const;

// Only auto-run outside the test harness.
if (require.main === module) {
  void run();
}
