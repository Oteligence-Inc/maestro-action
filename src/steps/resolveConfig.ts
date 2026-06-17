import * as core from '@actions/core';
import { MaestroApi, expectOk } from '../api';
import { Inputs, LockedSpec, LockedVersion, ResolvedConfig } from '../types';
import { UserError } from '../util/errors';

export function envBase(projectUid: string): string {
  return `/api/job-manager/projects/${encodeURIComponent(projectUid)}`;
}
export function envPath(projectUid: string, env: string): string {
  return `${envBase(projectUid)}/envs/${encodeURIComponent(env)}`;
}

/**
 * [2] Resolve the project UID + the env's locked config and locked-version UID.
 * - project name → UID via GET /api/auth/tenant-projects (passthrough if a proj_ UID was given)
 * - GET .../envs/{env}/locked         → the rule book (goals, apm, selection, registeredJars)
 * - GET .../envs/{env}/versions[0].uid → the lockedVersionUid the jobs must carry (drives staleness)
 */
export async function resolveLockedConfig(api: MaestroApi, inputs: Inputs): Promise<ResolvedConfig> {
  const projectUid = await resolveProjectUid(api, inputs.project);

  const lockedRes = await api.get<{ data: LockedSpec }>(`${envPath(projectUid, inputs.environment)}/locked`);
  if (lockedRes.statusCode === 404) {
    throw new UserError(
      `Env "${inputs.environment}" in project "${inputs.project}" has not been locked yet. ` +
        'Open Maestro and complete Step 5 (Save & Lock) before running CI.',
    );
  }
  expectOk(lockedRes, 'locked');
  const locked = lockedRes.body?.data;
  if (!locked) throw new UserError('Locked-config response was empty.');

  const versionsRes = await api.get<{ data: LockedVersion[] }>(`${envPath(projectUid, inputs.environment)}/versions`);
  expectOk(versionsRes, 'versions');
  const versions = versionsRes.body?.data ?? [];
  const lockedVersionUid = versions[0]?.uid; // newest first
  if (!lockedVersionUid) {
    throw new UserError(`Env "${inputs.environment}" has no locked version UID — lock the env in Maestro first.`);
  }

  core.info(`Locked version: v${locked.version} (${lockedVersionUid})`);
  return { projectUid, lockedVersionUid, locked };
}

async function resolveProjectUid(api: MaestroApi, project: string): Promise<string> {
  if (project.startsWith('proj_')) return project; // already a UID

  const res = await api.get<{
    content?: Array<{ uid: string; projectName: string }>;
    data?: { content?: Array<{ uid: string; projectName: string }> };
  }>('/api/auth/tenant-projects?page=0&size=100');
  if (res.statusCode === 401 || res.statusCode === 403) {
    throw new UserError(`API key does not have access to project "${project}".`);
  }
  expectOk(res, '/api/auth/tenant-projects');
  // oteligence-auth returns PagedResponse directly ({ content, page }) — there is no `data`
  // envelope on this endpoint (unlike job-manager's APIResponse). Read top-level `content`,
  // tolerating a `data.content` wrapper in case a gateway ever adds one.
  const content = res.body?.content ?? res.body?.data?.content ?? [];
  const match = content.find((p) => p.projectName === project);
  if (!match) {
    throw new UserError(
      `Project "${project}" not found for this API key's tenant. Pass the exact project name, or its proj_ UID.`,
    );
  }
  return match.uid;
}
