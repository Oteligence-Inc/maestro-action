import * as core from '@actions/core';

/** How many method names a line prints; the count beside them is always the server's full one. */
const SHOWN = 10;

interface Group {
  count: number;
  keys: string[];
}

interface ServiceDrift {
  recommendedNotInLock: Group;
  lockedNotInJar: Group;
}

function group(value: unknown): Group {
  const g = (value ?? {}) as { count?: unknown; keys?: unknown };
  const keys = Array.isArray(g.keys) ? g.keys.filter((k): k is string => typeof k === 'string') : [];
  const count = typeof g.count === 'number' && Number.isInteger(g.count) && g.count >= keys.length ? g.count : keys.length;
  return { count, keys };
}

function listed(g: Group): string {
  const shown = g.keys.slice(0, SHOWN);
  const more = g.count - shown.length;
  return shown.join(', ') + (more > 0 ? ` and ${more} more` : '');
}

/**
 * Reports a build's drift from its lock, as job-manager worked it out when the build was submitted. Method and
 * service names, which come from the customer's bytecode, are printed only through core.warning, which escapes them.
 * Drift never fails the step, fail-on-warnings included. A job-manager that sends no drift, or a compared drift with
 * no readable services, prints nothing. With no names of its own, every service is the run's own.
 */
export function reportDrift(drift: unknown, ownNames: string[]): void {
  if (!drift || typeof drift !== 'object') return;
  const d = drift as Record<string, unknown>;
  const status = typeof d.status === 'string' ? d.status : undefined;
  const version = Number.isInteger(d.lockVersion) ? `lock v${d.lockVersion}` : 'the lock';
  if (status === 'same_analysis') {
    core.info(`Built from ${version}'s own analysis: no drift to report.`);
    return;
  }
  if (status === 'no_lock' || status === 'lock_has_no_analysis' || status === 'unreadable') {
    core.info(`Drift against ${version} was not checked (${status.replace(/_/g, ' ')}).`);
    return;
  }
  if (status === 'unbound') {
    core.warning(`Drift against ${version} was not checked: the analysis was not made from this build's JARs.`);
    return;
  }
  if (status !== 'checked' && status !== 'unmatched') return;

  if (!d.services || typeof d.services !== 'object' || Array.isArray(d.services)) return;
  const services = d.services as Record<string, unknown>;
  const own = new Set(ownNames);
  const isOwn = (service: string) => own.size === 0 || own.has(service);
  let peers = 0;
  let ownDrift = false;
  const engine = d.engineChanged === true ? ' The analysis engine changed since the lock, so a new recommendation may come from the engine rather than the JAR.' : '';
  const goals = d.goalsChanged === true ? ' The goals changed since the lock, so a new recommendation may come from the goals rather than the JAR.' : '';
  for (const [service, raw] of Object.entries(services)) {
    const s = (raw ?? {}) as Record<string, unknown>;
    const sd: ServiceDrift = { recommendedNotInLock: group(s.recommendedNotInLock), lockedNotInJar: group(s.lockedNotInJar) };
    if (!isOwn(service)) {
      peers += sd.recommendedNotInLock.count + sd.lockedNotInJar.count;
      continue;
    }
    if (sd.recommendedNotInLock.count > 0) {
      ownDrift = true;
      core.warning(`Drift against ${version} in ${service}: ${sd.recommendedNotInLock.count} method(s) the analysis now `
        + `recommends are not in the lock: ${listed(sd.recommendedNotInLock)}. Lock again to add them, or leave them out.`
        + engine + goals);
    }
    if (sd.lockedNotInJar.count > 0) {
      ownDrift = true;
      core.warning(`Drift against ${version} in ${service}: ${sd.lockedNotInJar.count} locked method(s) are no longer `
        + `in the JAR or can no longer be instrumented: ${listed(sd.lockedNotInJar)}.`);
    }
  }
  const unmatched = Array.isArray(d.unmatchedServices)
    ? d.unmatchedServices.filter((s): s is string => typeof s === 'string') : [];
  if (unmatched.length > 0) {
    core.warning(`Drift against ${version}: this build's analysis holds no methods for ${unmatched.join(', ')}, which the `
      + "lock's analysis held, so their locked methods were not compared.");
  }
  if (peers > 0) {
    core.info(`Other services of this environment drift from ${version} by ${peers} method(s); their own runs name them.`);
  }
  if (!ownDrift && peers === 0 && unmatched.length === 0) {
    core.info(`No drift against ${version}.`);
  }
}
