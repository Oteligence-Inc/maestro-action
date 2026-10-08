import * as core from '@actions/core';
import { MaestroApi, expectOk } from '../api';
import { Inputs, ResolvedConfig, UploadResult } from '../types';
import { envPath } from './resolveConfig';

/**
 * [9] Register the built JAR's SHA for this env under the analysis's name for it, the name its lock entries and
 * build share; the `service` input when the analysis gave none. The locked config itself is unchanged.
 */
export async function registerJarForEnv(
  api: MaestroApi,
  inputs: Inputs,
  cfg: ResolvedConfig,
  upload: UploadResult,
  buildJobId: string,
  analysisName?: string,
): Promise<void> {
  const service = analysisName || inputs.service;
  if (service !== inputs.service) {
    core.warning(
      `The analysis names this JAR "${service}", not "${inputs.service}", so it is registered as "${service}". ` +
        `Set \`service: ${service}\` in this workflow; the next run checks that name against the environment.`,
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
