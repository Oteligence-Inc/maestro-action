import * as core from '@actions/core';
import { MaestroApi, expectOk } from '../api';
import { BuildProfile, LockedSpec, ResolvedConfig, UploadResult } from '../types';
import { UserError } from '../util/errors';

function extractJobId(body: any): string | undefined {
  const data = body?.data ?? body;
  return data?.id ?? data?.jobId;
}

/**
 * [6a] Submit MULTI_JAR_ANALYSIS carrying lockedVersionUid — this re-applies the locked
 * rules to the bytecode AND (with staleness enabled) re-stamps the env's current CCG
 * signature, which is what the core.warning at the end is computed from.
 */
export async function submitAnalysis(api: MaestroApi, cfg: ResolvedConfig, upload: UploadResult): Promise<string> {
  const locked = cfg.locked;
  const res = await api.post('/api/job-manager/jobs', {
    projectUid: cfg.projectUid, // stamp the project so project-scoped reads (ci-runs) find this job
    jobType: 'MULTI_JAR_ANALYSIS',
    queuePriority: 'NORMAL',
    javaVersion: locked.javaVersion || '17',
    otelVersion: locked.otelVersion || undefined,
    lockedVersionUid: cfg.lockedVersionUid,
    requestJson: {
      artifactGroupUid: upload.artifactGroupUid,
      goals: locked.goals,
      apm: locked.apm || undefined,
    },
  });
  expectOk(res, 'POST /jobs (analysis)');
  const jobId = extractJobId(res.body);
  if (!jobId) throw new UserError('Analysis job submission returned no job id.');
  core.info(`Submitted analysis job ${jobId}.`);
  return jobId;
}

/**
 * [6b] Submit MULTI_JAR_EXPLORER_BUILD — the job that actually produces the deployable
 * extension bundle. The backend REQUIRES requestJson.profile, so we assemble it from the
 * locked selection (the CI equivalent of the wizard's "Generate").
 */
export async function submitBuild(
  api: MaestroApi,
  cfg: ResolvedConfig,
  upload: UploadResult,
  analysisJobId: string,
  profile: BuildProfile,
): Promise<string> {
  const locked = cfg.locked;
  const res = await api.post('/api/job-manager/jobs', {
    projectUid: cfg.projectUid, // stamp the project so project-scoped reads (ci-runs) find this job
    jobType: 'MULTI_JAR_EXPLORER_BUILD',
    queuePriority: 'NORMAL',
    javaVersion: locked.javaVersion || '17',
    otelVersion: locked.otelVersion || undefined,
    lockedVersionUid: cfg.lockedVersionUid,
    requestJson: {
      artifactGroupUid: upload.artifactGroupUid,
      analysisJobId,
      profile,
    },
  });
  expectOk(res, 'POST /jobs (build)');
  const jobId = extractJobId(res.body);
  if (!jobId) throw new UserError('Build job submission returned no job id.');
  core.info(`Submitted build job ${jobId}.`);
  return jobId;
}

/**
 * Build the MULTI_JAR_EXPLORER_BUILD profile from the locked selection. Mirrors the
 * wizard's hubGenerateBuild: each locked-selected method → an enabled methodConfiguration
 * (depth = "deep" for deep-tier methods, else "standard"), plus per-service counts and
 * the locked goals/apm. methodFqn is already scoped "service::Class.method".
 */
export function buildProfileFromLocked(locked: LockedSpec): BuildProfile {
  const perService: Record<string, { selectedCount: number }> = {};
  const methodConfigurations: Record<string, { enabled: boolean; depth: string }> = {};
  for (const entry of locked.selection ?? []) {
    const id = entry.methodFqn;
    if (!id || !id.includes('::')) continue;
    const svc = entry.service || id.split('::')[0];
    if (!svc || svc === 'undefined') continue;
    const tier = String(entry.tier || '').toLowerCase();
    if (tier === 'skip') continue; // skip-tier (FORCE_SKIP / deselected) must never be instrumented
    perService[svc] = perService[svc] || { selectedCount: 0 };
    perService[svc].selectedCount++;
    methodConfigurations[id] = { enabled: true, depth: tier === 'deep' ? 'deep' : 'standard' };
  }
  if (Object.keys(methodConfigurations).length === 0) {
    throw new UserError('The locked version has no selected methods to build — re-lock with a non-empty selection.');
  }
  return {
    version: 1,
    perService,
    methodConfigurations,
    goals: locked.goals ?? [],
    apm: locked.apm ?? null,
  };
}
