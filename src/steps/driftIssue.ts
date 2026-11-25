import * as core from '@actions/core';
import * as crypto from 'crypto';

/** The label every drift issue carries, so the next run finds it. */
export const LABEL = 'maestro-drift';
/** How many method names a group shows in the issue; the count beside them is always the server's full one. */
const SHOWN = 20;

export interface DriftIssueContext {
  token: string;
  /** Method names may go into an issue in a public repository. */
  allowPublic: boolean;
  projectUid: string;
  environment: string;
  service: string;
  buildJobId: string;
  /** GITHUB_API_URL and GITHUB_REPOSITORY; GITHUB_SERVER_URL and GITHUB_RUN_ID for the run's link. */
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

interface Group {
  count: number;
  keys: string[];
}

/** An environment's drift from its lock, as a build's analysis read it. */
export interface DriftSummary {
  lockVersion: number | null;
  services: Record<string, { recommendedNotInLock: Group; lockedNotInJar: Group }>;
  unmatched: string[];
}

function group(value: unknown): Group {
  const g = (value ?? {}) as { count?: unknown; keys?: unknown };
  const keys = Array.isArray(g.keys) ? g.keys.filter((k): k is string => typeof k === 'string') : [];
  const count = typeof g.count === 'number' && Number.isInteger(g.count) && g.count >= keys.length ? g.count : keys.length;
  return { count, keys: [...keys].sort() };
}

/**
 * The environment's drift a build reports, or null when it was not compared (no lock, the lock's own analysis, an
 * analysis not made from this build, a server that sends none): then the issue is left as it is.
 */
export function summarize(drift: unknown): DriftSummary | null {
  if (!drift || typeof drift !== 'object') return null;
  const d = drift as Record<string, unknown>;
  if (d.status === 'same_analysis') return { lockVersion: lockVersionOf(d), services: {}, unmatched: [] };
  if (d.status !== 'checked' && d.status !== 'unmatched') return null;
  if (!d.services || typeof d.services !== 'object' || Array.isArray(d.services)) return null;
  const services: DriftSummary['services'] = {};
  for (const [name, raw] of Object.entries(d.services as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
    const s = (raw ?? {}) as Record<string, unknown>;
    const entry = { recommendedNotInLock: group(s.recommendedNotInLock), lockedNotInJar: group(s.lockedNotInJar) };
    if (entry.recommendedNotInLock.count > 0 || entry.lockedNotInJar.count > 0) services[name] = entry;
  }
  const unmatched = Array.isArray(d.unmatchedServices)
    ? d.unmatchedServices.filter((s): s is string => typeof s === 'string').sort() : [];
  return { lockVersion: lockVersionOf(d), services, unmatched };
}

function lockVersionOf(d: Record<string, unknown>): number | null {
  return Number.isInteger(d.lockVersion) ? (d.lockVersion as number) : null;
}

export function drifts(s: DriftSummary): boolean {
  return Object.keys(s.services).length > 0 || s.unmatched.length > 0;
}

/** What identifies a drift, so a run that sees the same drift adds no comment: the lock and every method named. */
export function digest(s: DriftSummary): string {
  return crypto.createHash('sha256').update(JSON.stringify([s.lockVersion, s.services, s.unmatched])).digest('hex');
}

/** A name from the customer's bytecode, as inline code that cannot break out of it or out of its table cell. */
function code(name: string): string {
  return '`' + name.replace(/[`\r\n]/g, '').replace(/\|/g, '\\|') + '`';
}

function listed(g: Group, names: boolean): string {
  if (!names) return `${g.count}`;
  const shown = g.keys.slice(0, SHOWN).map(code);
  const more = g.count - shown.length;
  return `${g.count}: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

export function marker(projectUid: string, environment: string): string {
  return `<!-- maestro-drift project=${encodeURIComponent(projectUid)} environment=${encodeURIComponent(environment)} -->`;
}

function digestMarker(d: string): string {
  return `<!-- maestro-drift-digest ${d} -->`;
}

/** The issue's body: each drifting service's counts, with the method names only where they may be shown. */
export function body(s: DriftSummary, ctx: DriftIssueContext, names: boolean, runUrl: string | null): string {
  const lock = s.lockVersion === null ? 'its lock' : `lock v${s.lockVersion}`;
  const lines = [
    `Maestro builds of environment ${code(ctx.environment)} drift from ${lock}. The newest build to read it is job `
      + `${code(ctx.buildJobId)} of ${code(ctx.service)}${runUrl ? ` ([run](${runUrl}))` : ''}.`,
    '',
    '| Service | Recommended now, not in the lock | Locked, no longer in the JAR |',
    '| --- | --- | --- |',
  ];
  for (const [service, d] of Object.entries(s.services)) {
    lines.push(`| ${code(service)} | ${listed(d.recommendedNotInLock, names)} | ${listed(d.lockedNotInJar, names)} |`);
  }
  if (s.unmatched.length > 0) {
    lines.push('', `This build's analysis holds no methods for ${s.unmatched.map(code).join(', ')}, which the lock's `
      + 'analysis held, so their locked methods were not compared.');
  }
  if (!names) {
    lines.push('', 'Method names are left out because this repository is public; set `drift-issue-public` to show them.');
  }
  lines.push('', 'Lock again to add the methods now recommended, or leave them out. This issue closes when a build of '
    + 'this environment shows no drift.', '', marker(ctx.projectUid, ctx.environment), digestMarker(digest(s)));
  return lines.join('\n');
}

interface Issue {
  number: number;
  body?: string | null;
}

class GitHub {
  constructor(private readonly api: string, private readonly repo: string, private readonly token: string,
              private readonly fetchImpl: typeof fetch) {}

  async call<T>(method: string, path: string, payload?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.api}/repos/${this.repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} to ${method} ${path.split('?')[0]}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
}

/**
 * Keeps one issue per environment current with the build's drift: opens it when the environment drifts, edits it on
 * each later build, comments when the drift changes, and closes it when a build shows none. Never fails the step.
 */
export async function syncDriftIssue(drift: unknown, ctx: DriftIssueContext): Promise<void> {
  try {
    const s = summarize(drift);
    if (s === null) {
      core.info('Drift issue: this build did not compare drift, so the issue is left as it is.');
      return;
    }
    const api = (ctx.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
    const repo = ctx.env.GITHUB_REPOSITORY;
    if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      core.warning('Drift issue not updated: GITHUB_REPOSITORY is not set.');
      return;
    }
    const gh = new GitHub(api, repo, ctx.token, ctx.fetchImpl ?? fetch);
    const mark = marker(ctx.projectUid, ctx.environment);
    const open = await gh.call<Issue[]>('GET', `/issues?state=open&labels=${LABEL}&per_page=100`);
    const issue = open.find((i) => (i.body ?? '').includes(mark));
    const runUrl = ctx.env.GITHUB_SERVER_URL && ctx.env.GITHUB_RUN_ID
      ? `${ctx.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${ctx.env.GITHUB_RUN_ID}` : null;

    if (!drifts(s)) {
      if (!issue) return;
      await gh.call('POST', `/issues/${issue.number}/comments`, {
        body: `Build ${code(ctx.buildJobId)} of ${code(ctx.service)} shows no drift against `
          + `${s.lockVersion === null ? 'the lock' : `lock v${s.lockVersion}`}: closing.`,
      });
      await gh.call('PATCH', `/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' });
      core.info(`Drift issue #${issue.number} closed: no drift.`);
      return;
    }

    let names = ctx.allowPublic;
    if (!names) {
      const repository = await gh.call<{ private?: boolean }>('GET', '');
      names = repository.private === true;
    }
    const text = body(s, ctx, names, runUrl);
    const title = `Maestro: ${ctx.environment} drifts from ${s.lockVersion === null ? 'its lock' : `lock v${s.lockVersion}`}`;
    if (!issue) {
      const made = await gh.call<Issue>('POST', '/issues', { title, body: text, labels: [LABEL] });
      core.info(`Drift issue #${made.number} opened.`);
      return;
    }
    const changed = !(issue.body ?? '').includes(digestMarker(digest(s)));
    await gh.call('PATCH', `/issues/${issue.number}`, { title, body: text });
    if (changed) {
      await gh.call('POST', `/issues/${issue.number}/comments`, {
        body: `The drift changed with build ${code(ctx.buildJobId)} of ${code(ctx.service)}: the issue now shows it.`,
      });
    }
    core.info(`Drift issue #${issue.number} updated${changed ? ': the drift changed' : ''}.`);
  } catch (err) {
    core.warning(`Drift issue not updated: ${err instanceof Error ? err.message : String(err)}`);
  }
}
