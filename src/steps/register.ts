import * as core from '@actions/core';
import { MaestroApi, expectOk } from '../api';
import { Inputs, ResolvedConfig, UploadResult } from '../types';
import { UserError } from '../util/errors';
import { envPath } from './resolveConfig';

/**
 * [9] Register the built JAR's SHA for this (env, service). Silent per-env pointer
 * update — the locked config itself is unchanged. A 409 means the JAR's detected
 * service name doesn't match the workflow's `service:` input.
 */
export async function registerJarForEnv(
  api: MaestroApi,
  inputs: Inputs,
  cfg: ResolvedConfig,
  upload: UploadResult,
  buildJobId: string,
): Promise<void> {
  const path = `${envPath(cfg.projectUid, inputs.environment)}/services/${encodeURIComponent(inputs.service)}/jar`;
  const res = await api.put(path, {
    artifactUid: upload.artifactUid,
    sha: upload.sha,
    source: 'ci',
    jobId: buildJobId,
    fileName: upload.fileName,
    sizeBytes: upload.sizeBytes,
  });
  if (res.statusCode === 409) {
    throw new UserError(
      `This JAR's detected service does not match service: "${inputs.service}". ` +
        'Fix the service input or upload to the right service.',
    );
  }
  if (res.statusCode === 404) {
    throw new UserError(
      `Service "${inputs.service}" is not part of "${inputs.environment}"'s config. ` +
        'Register it via the wizard (Step 1) or correct the service input.',
    );
  }
  expectOk(res, 'register-jar');
  core.info(`Registered ${inputs.service} JAR (sha ${upload.sha}) for env ${inputs.environment}.`);
}
