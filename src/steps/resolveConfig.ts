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
  const projectUid = await resolveProjectUid(api, inputs.project, inputs.projectId);

  const projectLabel = inputs.project?.trim() || `id ${projectUid}`;
  const lockedRes = await api.get<{ data: LockedSpec | null }>(`${envPath(projectUid, inputs.environment)}/locked`);
  // job-manager answers 404 for an environment it cannot find, and 200 with null data for one never locked.
  if (lockedRes.statusCode === 404) {
    throw new UserError(
      `Env "${inputs.environment}" in project "${projectLabel}" was not found. ` +
        'Check the environment name.',
    );
  }
  expectOk(lockedRes, 'locked');
  if (lockedRes.body?.data === null) {
    throw new UserError(
      `Env "${inputs.environment}" in project "${projectLabel}" has not been locked yet. ` +
        'Open Maestro and complete Step 5 (Save & Lock) before running CI.',
    );
  }
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

/**
 * Resolve the project UID from either a projectId (UID) or a project name.
 *
 * <b>projectId wins:</b> when a projectId is supplied it is used directly (all backend paths key
 * on projectUid), so a forgotten/mistyped project NAME can't block a run. We still validate the id
 * up front against this API key's tenant so a wrong id fails fast with a clear message rather than a
 * confusing downstream 404. When only a name is given, resolve it by exact match (with a legacy
 * {@code proj_} passthrough kept for back-compat). At least one of the two is guaranteed by parseInputs.
 */
async function resolveProjectUid(api: MaestroApi, project: string, projectId: string): Promise<string> {
  const id = (projectId || '').trim();
  const name = (project || '').trim();

  if (id) {
    const match = await findTenantProject(api, id, (p) => p.uid === id);
    if (!match) {
      throw new UserError(
        `project-id "${id}" was not found for this API key's tenant. ` +
          'Copy the exact Project ID from Maestro (project settings / URL), or use the project name instead.',
      );
    }
    if (name && match.projectName !== name) {
      core.warning(
        `Both project-id and project name were given; using project-id "${id}" (project "${match.projectName}") ` +
          `and ignoring the name "${name}".`,
      );
    }
    return match.uid;
  }

  // No projectId → resolve by name. Legacy proj_ passthrough kept for back-compat.
  if (name.startsWith('proj_')) return name;
  const match = await findTenantProject(api, name, (p) => p.projectName === name);
  if (!match) {
    throw new UserError(
      `Project "${name}" not found for this API key's tenant. Pass the exact project name, or set "project-id".`,
    );
  }
  return match.uid;
}

type TenantProject = { uid: string; projectName: string };
type TenantProjectsPage = { content?: TenantProject[]; page?: { hasNext?: boolean } };

/** Pages read before a listing that keeps saying "more" is refused. */
const MAX_PROJECT_PAGES = 1000;

/**
 * The first of this API key's tenant projects that `matches`, reading page by page until one does or the listing
 * says no page follows. `ref` is only used in the error messages.
 */
async function findTenantProject(
  api: MaestroApi,
  ref: string,
  matches: (p: TenantProject) => boolean,
): Promise<TenantProject | undefined> {
  for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
    const res = await api.get<TenantProjectsPage>(`/api/auth/tenant-projects?page=${page}&size=100`);
    if (res.statusCode === 401 || res.statusCode === 403) {
      throw new UserError(`API key does not have access to project "${ref}".`);
    }
    expectOk(res, '/api/auth/tenant-projects');
    // oteligence-auth returns its PagedResponse directly ({ content, page }), with no `data` envelope.
    const body = res.body;
    if (!body) {
      throw new UserError('Listing the tenant projects returned an empty response.');
    }
    const content = body.content ?? [];
    const match = content.find(matches);
    // An empty page ends the listing even when it says more follow, so a server that ignores `page` cannot loop.
    if (match || !body.page?.hasNext || content.length === 0) return match;
  }
  throw new UserError(
    `Listing this API key's tenant projects returned more than ${MAX_PROJECT_PAGES} pages without finding "${ref}".`,
  );
}
