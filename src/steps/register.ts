import * as core from '@actions/core';
import { MaestroApi, expectOk } from '../api';
import { Inputs, ResolvedConfig, UploadResult } from '../types';
import { envPath } from './resolveConfig';

/**
 * [9] Register the built JAR's SHA for this (env, service). Silent per-env pointer update; the locked config
 * itself is unchanged. The registration keeps the `service` name the environment knows the service by, and a
 * warning reports the analysis's name for the JAR when it differs, since the lock and build key on that one.
 */
export async function registerJarForEnv(
  api: MaestroApi,
  inputs: Inputs,
  cfg: ResolvedConfig,
  upload: UploadResult,
  buildJobId: string,
  analysisName?: string,
): Promise<void> {
  const service = inputs.service;
  if (analysisName && analysisName !== service) {
    core.warning(
      `The analysis names this JAR "${analysisName}", the name its lock entries and build use, but it is ` +
        `registered as "${service}". Register the service as "${analysisName}" in the Maestro wizard and set ` +
        'the "service" input to match.',
    );
  }
  const path = `${envPath(cfg.projectUid, inputs.environment)}/services/${encodeURIComponent(service)}/jar`;
  const res = await api.put(path, {
    artifactUid: upload.artifactUid,
    sha: upload.sha,
    source: 'ci',
    jobId: buildJobId,
    fileName: upload.fileName,
    sizeBytes: upload.sizeBytes,
  });
  expectOk(res, 'register-jar');
  core.info(`Registered ${service} JAR (sha ${upload.sha}) for env ${inputs.environment}.`);
}
