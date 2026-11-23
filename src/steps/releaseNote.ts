import * as core from '@actions/core';

interface List {
  count: number;
  keys: string[];
}

function list(value: unknown): List {
  const g = (value ?? {}) as { count?: unknown; keys?: unknown };
  const keys = Array.isArray(g.keys) ? g.keys.filter((k): k is string => typeof k === 'string') : [];
  const count = typeof g.count === 'number' && Number.isInteger(g.count) && g.count >= keys.length ? g.count : keys.length;
  return { count, keys };
}

/** A lock key as a reader names it: without the service key and without the JVM descriptor. */
export function methodName(key: string): string {
  const fqn = key.includes('::') ? key.slice(key.indexOf('::') + 2) : key;
  const paren = fqn.indexOf('(');
  return paren < 0 ? fqn : fqn.slice(0, paren);
}

function named(g: List, name: (k: string) => string = methodName): string {
  const more = g.count - g.keys.length;
  return g.keys.map(name).join(', ') + (more > 0 ? ` and ${more} more` : '');
}

function attribute(k: string): string {
  const [key, attr] = k.split(' :: ');
  return attr ? `${attr} on ${methodName(key)}` : methodName(k);
}

function count(value: unknown): string {
  return Number.isInteger(value) ? String(value) : '?';
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

/**
 * Prints a build's release note, as job-manager worked it out when the build was submitted: what changed since the
 * previous build of the service. Printed through core.notice, which escapes the customer's method names. Never fails
 * the step. A job-manager that sends no note prints nothing.
 */
export function reportReleaseNote(note: unknown): void {
  if (!note || typeof note !== 'object') return;
  const n = note as Record<string, unknown>;
  if (typeof n.empty !== 'boolean' || !n.lock || typeof n.lock !== 'object') return;
  const lock = n.lock as Record<string, unknown>;
  const prev = n.previous && typeof n.previous === 'object' ? n.previous as Record<string, unknown> : null;
  const prevJob = prev && typeof prev.jobId === 'string' ? prev.jobId : null;
  if (!prevJob) {
    core.notice('Release note: no earlier build of this service was registered in this environment, so nothing to '
      + 'compare with.');
    return;
  }
  const since = `build ${prevJob}${Number.isInteger(prev?.lockVersion) ? ` (lock v${prev?.lockVersion})` : ''}`;
  if (n.empty) {
    core.notice(`Release note: no change since ${since}.`);
    return;
  }
  const lines: string[] = [];
  if (Number.isInteger(lock.from) && Number.isInteger(lock.to) && lock.from !== lock.to) {
    lines.push(`Lock v${lock.from} to v${lock.to}.`);
  }
  const added = list(lock.methodsAdded);
  const removed = list(lock.methodsRemoved);
  const attrsAdded = list(lock.attributesAdded);
  const attrsRemoved = list(lock.attributesRemoved);
  if (added.count) lines.push(`Methods added to the lock: ${named(added)}.`);
  if (removed.count) lines.push(`Methods removed from the lock: ${named(removed)}.`);
  if (attrsAdded.count) lines.push(`Span attributes added: ${named(attrsAdded, attribute)}.`);
  if (attrsRemoved.count) lines.push(`Span attributes removed: ${named(attrsRemoved, attribute)}.`);
  const goneRaw = (n.methodsGone ?? {}) as Record<string, unknown>;
  const gone = list(n.methodsGone);
  if (goneRaw.compared === false) {
    lines.push("Locked methods no longer in the JAR were not compared: a build's drift was not checked.");
  } else if (goneRaw.partial === true) {
    lines.push(`Locked methods no longer in the JAR: ${count(goneRaw.before)} before, ${count(goneRaw.now)} now; `
      + 'the drift names only the first of them, so they are not named here.');
  } else if (gone.count) {
    const spans = Array.isArray(goneRaw.spans) ? goneRaw.spans.filter((s): s is string => typeof s === 'string') : [];
    lines.push(`Locked methods the JAR no longer has: ${named(gone)}.`
      + (spans.length ? ` Spans the previous build's inventory lists for them: ${spans.join(', ')}.` : ''));
  }
  const sensitive = n.newSensitive && typeof n.newSensitive === 'object' ? n.newSensitive as Record<string, unknown> : {};
  if (Number.isInteger(sensitive.count) && (sensitive.count as number) > 0) {
    lines.push(`${plural(sensitive.count as number, 'new sensitive log statement')}, each named in a warning above.`);
  }
  const ci = n.ci && typeof n.ci === 'object' ? n.ci as Record<string, unknown> : {};
  if (ci.checked === true && ci.compared === false) {
    lines.push("CI log policy check: the previous build's check cannot be compared with this one's.");
  } else if (Number.isInteger(ci.newFindings) && (ci.newFindings as number) > 0) {
    lines.push(`CI log policy check ${typeof ci.status === 'string' ? ci.status : 'ran'}: `
      + `${plural(ci.newFindings as number, 'finding')} the previous build's check did not have.`);
  }
  const recRaw = (n.newlyRecommended ?? {}) as Record<string, unknown>;
  const recommended = list(n.newlyRecommended);
  if (recRaw.compared === false) {
    lines.push("Newly recommended methods (scoring output) were not compared: a build's drift was not checked.");
  } else if (recRaw.partial === true) {
    lines.push(`Methods the analysis recommends (scoring output): ${count(recRaw.before)} before, ${count(recRaw.now)} `
      + 'now; the drift names only the first of them, so they are not named here.');
  } else if (recommended.count) {
    lines.push(`Newly recommended by this analysis (scoring output, not built until you lock again): ${named(recommended)}.`);
  }
  if (lines.length === 0) {
    lines.push('Nothing could be compared.');
  }
  core.notice([`Release note since ${since}:`, ...lines].join('\n'));
}
