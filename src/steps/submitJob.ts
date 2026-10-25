import * as core from '@actions/core';
import { MaestroApi, expectOk } from '../api';
import { BuildProfile, LockedSpec, ResolvedConfig, UploadResult } from '../types';
import { UserError } from '../util/errors';

/** A job id the action may put in a path and a log line: letters, digits, '-' and '_' only. */
const SAFE_JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;

function extractJobId(body: any): string | undefined {
  const data = body?.data ?? body;
  const id = data?.id ?? data?.jobId;
  if (id !== undefined && id !== null && !(typeof id === 'string' && SAFE_JOB_ID.test(id))) {
    throw new UserError('Maestro returned a job id this action does not accept. Check the api-url points at Maestro.');
  }
  return id ?? undefined;
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

/** A submitted build: its job id, and its drift from the lock as job-manager worked it out (absent from an older one). */
export interface SubmittedBuild {
  jobId: string;
  drift: unknown;
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
): Promise<SubmittedBuild> {
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
      envName: cfg.envName,
      profile,
    },
  });
  expectOk(res, 'POST /jobs (build)');
  const jobId = extractJobId(res.body);
  if (!jobId) throw new UserError('Build job submission returned no job id.');
  core.info(`Submitted build job ${jobId}.`);
  const body = res.body as { data?: { drift?: unknown } } | undefined;
  return { jobId, drift: body?.data?.drift };
}

/**
 * Build the MULTI_JAR_EXPLORER_BUILD profile from the locked selection. Mirrors the
 * wizard's buildMethodConfigurations: each locked-selected method → an enabled
 * methodConfiguration (depth = "deep" for deep-tier methods, else "standard"), plus
 * per-service counts and the locked goals/apm.
 *
 * The backend keys methodConfigurations by the SCOPED fqn "service::Class.method" (same as
 * the GUI's `${node.service}::${node.methodFqn}`), but the locked selection persists a BARE
 * methodFqn ("com.x.Class.method") with `service` in a separate field — so we reconstruct the
 * scoped key here. (An already-scoped methodFqn is tolerated defensively.)
 */
export function buildProfileFromLocked(locked: LockedSpec): BuildProfile {
  const perService: Record<string, { selectedCount: number }> = {};
  const methodConfigurations: Record<string, { enabled: boolean; depth: string }> = {};
  for (const entry of locked.selection ?? []) {
    const rawFqn = entry.methodFqn;
    if (!rawFqn) continue;
    const scopedAlready = rawFqn.includes('::');
    const svc = entry.service || (scopedAlready ? rawFqn.slice(0, rawFqn.indexOf('::')) : undefined);
    if (!svc || svc === 'undefined') continue;
    const bareFqn = scopedAlready ? rawFqn.slice(rawFqn.indexOf('::') + 2) : rawFqn;
    if (!bareFqn) continue;
    const id = `${svc}::${bareFqn}`;
    const tier = String(entry.tier || '').toLowerCase();
    // A user's own pick is built whatever its tier, as the wizard builds it; an auto SKIP entry and a removed one are not.
    if ((tier === 'skip' && entry.provenance === 'auto') || entry.provenance === 'user_removed') continue;
    if (methodConfigurations[id]) continue; // one entry per flow; the method is configured once
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
