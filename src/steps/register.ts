import * as core from '@actions/core';
import { MaestroApi, expectOk } from '../api';
import { Inputs, ResolvedConfig, UploadResult } from '../types';
import { envPath } from './resolveConfig';

/**
 * [9] Register the built JAR's SHA for this (env, service). Silent per-env pointer update; the locked config
 * itself is unchanged. The registration keeps the `service` name the environment knows the service by.
 * `analysisNames` is the analysis's key for the JAR first, then its display name when that differs (uploads that
 * share a name are keyed `name@<8 hex>`). The lock's selection and the build key a service by that key, so a
 * warning fires when it differs from the key the lock recorded for this registration, or, for a lock that
 * recorded none, from the registration's own name.
 */
export async function registerJarForEnv(
  api: MaestroApi,
  inputs: Inputs,
  cfg: ResolvedConfig,
  upload: UploadResult,
  buildJobId: string,
  analysisNames: string[] = [],
): Promise<void> {
  const service = inputs.service;
  const [key, shared] = analysisNames;
  const lockedKey = cfg.locked?.registeredJars?.[service]?.serviceKey;
  const pair = shared ? ` (another JAR in this analysis is also named "${shared}")` : '';
  const selection = cfg.locked?.selection ?? [];
  if (key && shared && selection.some((e) => e.service === shared) && !selection.some((e) => e.service === key)) {
    core.warning(
      `The lock files the methods of the JARs named "${shared}" under that shared name, which does not tell ` +
        `them apart, so this build may carry none of this JAR's ("${key}") locked methods. Re-lock the ` +
        'environment in the Maestro wizard.',
    );
  } else if (key && lockedKey && key !== lockedKey) {
    core.warning(
      `The lock files the "${service}" service's methods under "${lockedKey}", but this analysis keys its JAR ` +
        `"${key}"${pair}, so this build may carry none of its locked methods. Re-lock the environment in the ` +
        'Maestro wizard.',
    );
  } else if (key && !lockedKey && key !== service) {
    core.warning(
      shared
        ? `The analysis keys this JAR "${key}"${pair}, and the lock records no key for the "${service}" ` +
            'registration. Re-lock the environment in the Maestro wizard so the lock records which JAR it holds.'
        : `The analysis names this JAR "${key}", the name its lock entries and build use, but it is ` +
            `registered as "${service}". Register the service as "${key}" in the Maestro wizard and set ` +
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
