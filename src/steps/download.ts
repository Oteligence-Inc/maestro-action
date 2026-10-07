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
      agentConfigsByService?: { serviceName?: string; signedUrl?: string | null }[];
      collectorConfigUrl?: string;
    };
  };
}

/**
 * [8] Fetch the build bundle + config signed URLs, download them (no auth header — the
 * signed URL is the credential), extract the bundle, and return local paths for the
 * action outputs. Files land under RUNNER_TEMP so the customer's next step can consume them.
 */
export async function downloadArtifacts(
  api: MaestroApi,
  buildJobId: string,
  service: string,
  analysisNames: string[] = [],
): Promise<DownloadPaths> {
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

  const configPath = await writeIfPresent(
    api,
    serviceConfigUrl(data.individualArtifacts?.agentConfigsByService ?? [], service, analysisNames),
    baseDir,
    'javaagent.config',
  );
  const collectorConfigPath = await writeIfPresent(
    api,
    data.individualArtifacts?.collectorConfigUrl,
    baseDir,
    'collector-config.yaml',
  );

  return { extensionDir, configPath, collectorConfigPath };
}

/** This service's config: by the analysis's name for the upload, the registered name, then a unique letters-only
 *  match. None for an ambiguous match or a lone config of another service. */
function serviceConfigUrl(
  configs: { serviceName?: string; signedUrl?: string | null }[],
  service: string,
  analysisNames: string[],
): string | undefined {
  const wanted = compactServiceToken(service);
  const compactMatches = configs.filter((c) => wanted !== null && compactServiceToken(c.serviceName) === wanted);
  const match =
    analysisNames.map((n) => configs.find((c) => c.serviceName === n)).find((c) => c) ??
    configs.find((c) => c.serviceName === service) ??
    (compactMatches.length === 1 ? compactMatches[0] : undefined) ??
    (configs.length === 1 && configs[0].serviceName === ALL_SERVICES ? configs[0] : undefined);
  if (!match && configs.length > 0) {
    core.warning(
      `No single javaagent.config for service "${service}" among: ${configs.map((c) => c.serviceName).join(', ')}.`,
    );
  }
  return match?.signedUrl ?? undefined;
}

/** The build's name for the one config of a profile with no services. */
const ALL_SERVICES = 'all services';

/** Mirrors CrossServiceMatcher.compactServiceToken: letters only, one trailing role word removed. */
export function compactServiceToken(name: string | undefined): string | null {
  const compact = (name ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!compact) return null;
  for (const role of ['service', 'svc', 'api', 'svr']) {
    if (compact.length > role.length && compact.endsWith(role)) return compact.slice(0, -role.length);
  }
  return compact;
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
