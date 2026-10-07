import * as core from '@actions/core';
import { MaestroApi, expectOk } from '../api';
import { Inputs, ResolvedConfig, UploadResult } from '../types';
import { envPath } from './resolveConfig';

/**
 * [9] Register the built JAR's SHA for this (env, service). Silent per-env pointer
 * update — the locked config itself is unchanged.
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
  expectOk(res, 'register-jar');
  core.info(`Registered ${inputs.service} JAR (sha ${upload.sha}) for env ${inputs.environment}.`);
}
