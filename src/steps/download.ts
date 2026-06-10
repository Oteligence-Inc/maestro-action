import * as core from '@actions/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { MaestroApi, expectOk } from '../api';
import { DownloadPaths } from '../types';
import { UserError } from '../util/errors';

interface DownloadBody {
  data?: {
    bundleZipUrl?: string;
    individualArtifacts?: {
      agentConfigUrl?: string;
      collectorConfigUrl?: string;
    };
  };
}

/**
 * [8] Fetch the build bundle + config signed URLs, download them (no auth header — the
 * signed URL is the credential), extract the bundle, and return local paths for the
 * action outputs. Files land under RUNNER_TEMP so the customer's next step can consume them.
 */
export async function downloadArtifacts(api: MaestroApi, buildJobId: string): Promise<DownloadPaths> {
  const res = await api.get<DownloadBody>(`/api/job-manager/jobs/${encodeURIComponent(buildJobId)}/download`);
  expectOk(res, `/jobs/${buildJobId}/download`);
  const data = res.body?.data;
  if (!data?.bundleZipUrl) {
    throw new UserError('Build completed but no bundle URL was returned. Check the build job in Maestro.');
  }

  const baseDir = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'maestro', buildJobId);
  const extensionDir = path.join(baseDir, 'extension');
  fs.mkdirSync(extensionDir, { recursive: true });

  const zipBytes = await api.getSignedBytes(data.bundleZipUrl);
  new AdmZip(zipBytes).extractAllTo(extensionDir, /* overwrite */ true);
  core.info(`Extracted extension bundle to ${extensionDir}`);

  const configPath = await writeIfPresent(api, data.individualArtifacts?.agentConfigUrl, baseDir, 'javaagent.config');
  const collectorConfigPath = await writeIfPresent(
    api,
    data.individualArtifacts?.collectorConfigUrl,
    baseDir,
    'collector-config.yaml',
  );

  return { extensionDir, configPath, collectorConfigPath };
}

async function writeIfPresent(api: MaestroApi, url: string | undefined, dir: string, name: string): Promise<string> {
  if (!url) {
    core.warning(`Maestro returned no ${name}; output left empty.`);
    return '';
  }
  const bytes = await api.getSignedBytes(url);
  const dest = path.join(dir, name);
  fs.writeFileSync(dest, bytes);
  return dest;
}
