import * as core from '@actions/core';
import * as crypto from 'crypto';
import { HttpClient } from '@actions/http-client';

/** The label every drift issue asks for; it is found again by its marker, since GitHub may drop a label. */
export const LABEL = 'maestro-drift';
/** The names a group shows: job-manager sends at most ten per group, with the full count beside them. */
const SHOWN = 10;
/** The pages of open issues read to find this service's issue, 100 to a page. */
const PAGES = 10;

/** One request to the GitHub REST API: the status and the parsed JSON, or null for an empty or non-JSON answer. */
export type GitHubSend = (method: string, url: string, headers: Record<string, string>, body?: string)
  => Promise<{ status: number; json: unknown }>;

export interface DriftIssueContext {
  token: string;
  /** Method names may go into an issue in a public repository. */
  allowPublic: boolean;
  projectUid: string;
  environment: string;
  service: string;
  /** The analysis's names for this run's JAR: only these services' drift is this build's to report. */
  ownNames: string[];
  buildJobId: string;
  /** GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_EVENT_NAME; GITHUB_SERVER_URL and GITHUB_RUN_ID for the run's link. */
  env: NodeJS.ProcessEnv;
  send?: GitHubSend;
}

interface Group {
  count: number;
  keys: string[];
}

/** A service's drift from its lock, as its build's analysis read it. */
export interface DriftSummary {
  lockVersion: number | null;
  services: Record<string, { recommendedNotInLock: Group; lockedNotInJar: Group }>;
  unmatched: string[];
  engineChanged: boolean;
  goalsChanged: boolean;
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function group(value: unknown): Group {
  const g = (value ?? {}) as { count?: unknown; keys?: unknown };
  const keys = Array.isArray(g.keys) ? g.keys.filter((k): k is string => typeof k === 'string') : [];
  const count = typeof g.count === 'number' && Number.isInteger(g.count) && g.count >= keys.length ? g.count : keys.length;
  return { count, keys: [...keys].sort(byCodeUnit) };
}

/**
 * The run's own services' drift a build reports, or null when it was not compared (no lock, an analysis not made from
 * this build, a server that sends none): then the issue is left as it is. A build from the lock's own analysis reads as
 * no drift. With no names of its own, every service is the run's own, as in the log.
 */
export function summarize(drift: unknown, ownNames: string[] = []): DriftSummary | null {
  if (!drift || typeof drift !== 'object') return null;
  const d = drift as Record<string, unknown>;
  const base = { lockVersion: lockVersionOf(d), engineChanged: d.engineChanged === true, goalsChanged: d.goalsChanged === true };
  if (d.status === 'same_analysis') return { ...base, services: {}, unmatched: [] };
  if (d.status !== 'checked' && d.status !== 'unmatched') return null;
  if (!d.services || typeof d.services !== 'object' || Array.isArray(d.services)) return null;
  const own = new Set(ownNames);
  const isOwn = (service: string) => own.size === 0 || own.has(service);
  const services: DriftSummary['services'] = Object.create(null);
  for (const name of Object.keys(d.services as Record<string, unknown>).sort(byCodeUnit)) {
    if (!isOwn(name)) continue;
    const s = ((d.services as Record<string, unknown>)[name] ?? {}) as Record<string, unknown>;
    const entry = { recommendedNotInLock: group(s.recommendedNotInLock), lockedNotInJar: group(s.lockedNotInJar) };
    if (entry.recommendedNotInLock.count > 0 || entry.lockedNotInJar.count > 0) services[name] = entry;
  }
  const unmatched = Array.isArray(d.unmatchedServices)
    ? d.unmatchedServices.filter((s): s is string => typeof s === 'string' && isOwn(s)).sort(byCodeUnit) : [];
  return { ...base, services, unmatched };
}

function lockVersionOf(d: Record<string, unknown>): number | null {
  return Number.isInteger(d.lockVersion) ? (d.lockVersion as number) : null;
}

export function drifts(s: DriftSummary): boolean {
  return Object.keys(s.services).length > 0 || s.unmatched.length > 0;
}

/**
 * What identifies a drift, so a run that sees the same drift adds no comment. With names it covers every method named;
 * without, only the counts, so a public issue's marker cannot be matched against guessed method names.
 */
export function digest(s: DriftSummary, names: boolean): string {
  const services = Object.entries(s.services).map(([service, d]) => [service,
    names ? d : { recommendedNotInLock: d.recommendedNotInLock.count, lockedNotInJar: d.lockedNotInJar.count }]);
  return crypto.createHash('sha256').update(JSON.stringify([s.lockVersion, services, s.unmatched])).digest('hex');
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

/** The line that finds this service's issue again: its own line, which no name from the bytecode can make. */
export function marker(projectUid: string, environment: string, service: string): string {
  return `<!-- maestro-drift project=${encodeURIComponent(projectUid)} environment=${encodeURIComponent(environment)} `
    + `service=${encodeURIComponent(service)} -->`;
}

function digestMarker(d: string): string {
  return `<!-- maestro-drift-digest ${d} -->`;
}

function lockWords(s: DriftSummary): string {
  return s.lockVersion === null ? 'its lock' : `lock v${s.lockVersion}`;
}

/** The issue's body: the service's drift, with the method names only where they may be shown. */
export function body(s: DriftSummary, ctx: DriftIssueContext, names: boolean, runUrl: string | null): string {
  const lines = [
    `Maestro builds of ${code(ctx.service)} in environment ${code(ctx.environment)} drift from ${lockWords(s)}. The `
      + `newest build to read it is job ${code(ctx.buildJobId)}${runUrl ? ` ([run](${runUrl}))` : ''}.`,
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
  if (s.engineChanged) {
    lines.push('', 'The analysis engine changed since the lock, so a new recommendation may come from the engine rather '
      + 'than the JAR.');
  }
  if (s.goalsChanged) {
    lines.push('', 'The goals changed since the lock, so a new recommendation may come from the goals rather than the JAR.');
  }
  if (!names) {
    lines.push('', 'Method names are left out because this repository is public; set `drift-issue-public` to show them.');
  }
  lines.push('', 'Lock again to add the methods now recommended, or leave them out. This issue closes when a build of '
    + 'this service shows no drift.', '', marker(ctx.projectUid, ctx.environment, ctx.service),
    digestMarker(digest(s, names)));
  return lines.join('\n');
}

interface Issue {
  number: number;
  body?: string | null;
  state_reason?: string | null;
  pull_request?: unknown;
}

/** The default transport: @actions/http-client, which honours the runner's proxy settings, 20 s per request. */
const httpSend: GitHubSend = async (method, url, headers, body) => {
  const client = new HttpClient('maestro-action', [], { allowRetries: false, socketTimeout: 20_000 });
  const res = await client.request(method, url, body ?? null, headers);
  const text = await res.readBody();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.message.statusCode ?? 0, json };
};

class GitHub {
  constructor(private readonly api: string, private readonly repo: string, private readonly token: string,
              private readonly send: GitHubSend) {}

  async call<T>(method: string, path: string, payload?: unknown): Promise<T> {
    const res = await this.send(method, `${this.api}/repos/${this.repo}${path}`, {
      authorization: `Bearer ${this.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    }, payload === undefined ? undefined : JSON.stringify(payload));
    if (res.status < 200 || res.status >= 300) throw new Error(`GitHub answered ${res.status} to ${method} ${path.split('?')[0]}`);
    return res.json as T;
  }

  /** The issues (never pull requests) in a state whose body carries the marker on a line of its own, newest first. */
  async find(state: 'open' | 'closed', mark: string): Promise<Issue[]> {
    const found: Issue[] = [];
    for (let page = 1; page <= PAGES; page++) {
      const issues = await this.call<Issue[]>('GET', `/issues?state=${state}&per_page=100&page=${page}`);
      if (!Array.isArray(issues)) break;
      for (const i of issues) {
        if (!i.pull_request && (i.body ?? '').split('\n').includes(mark)) found.push(i);
      }
      if (issues.length < 100 || state === 'closed') break;
    }
    return found;
  }
}

/**
 * Keeps one issue per service and environment current with the build's drift: opens it when the service drifts, edits
 * it on each later build, comments when the drift changes, and closes it when a build shows none. A person's close as
 * not planned stands until the drift changes. Never fails the step.
 */
export async function syncDriftIssue(drift: unknown, ctx: DriftIssueContext): Promise<void> {
  try {
    if (/^pull_request/.test(ctx.env.GITHUB_EVENT_NAME ?? '')) {
      core.info('Drift issue: a pull request run does not change it.');
      return;
    }
    const s = summarize(drift, ctx.ownNames);
    if (s === null) {
      core.info('Drift issue: this build did not compare drift, so the issue is left as it is.');
      return;
    }
    const api = (ctx.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
    const repo = ctx.env.GITHUB_REPOSITORY ?? '';
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(repo)) {
      core.warning('Drift issue not updated: GITHUB_REPOSITORY is not an owner/repository name.');
      return;
    }
    const gh = new GitHub(api, repo, ctx.token, ctx.send ?? httpSend);
    const mark = marker(ctx.projectUid, ctx.environment, ctx.service);
    const open = await gh.find('open', mark);
    const issue = open.length > 0 ? open[open.length - 1] : undefined;
    const runUrl = ctx.env.GITHUB_SERVER_URL && ctx.env.GITHUB_RUN_ID
      ? `${ctx.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${ctx.env.GITHUB_RUN_ID}` : null;

    if (!drifts(s)) {
      for (const i of open) {
        await gh.call('POST', `/issues/${i.number}/comments`, {
          body: `Build ${code(ctx.buildJobId)} of ${code(ctx.service)} shows no drift against ${lockWords(s)}: closing.`,
        });
        await gh.call('PATCH', `/issues/${i.number}`, { state: 'closed', state_reason: 'completed' });
        core.info(`Drift issue #${i.number} closed: no drift.`);
      }
      return;
    }

    let names = ctx.allowPublic;
    if (!names) {
      const repository = await gh.call<{ private?: boolean }>('GET', '');
      names = repository?.private === true;
    }
    const text = body(s, ctx, names, runUrl);
    const sameDrift = digestMarker(digest(s, names));
    const title = `Maestro: ${ctx.service} in ${ctx.environment} drifts from ${lockWords(s)}`.slice(0, 256);
    if (!issue) {
      const closed = await gh.find('closed', mark);
      const dismissed = closed.find((i) => i.state_reason === 'not_planned');
      if (dismissed && closed[0] === dismissed && (dismissed.body ?? '').split('\n').includes(sameDrift)) {
        core.info(`Drift issue #${dismissed.number} was closed as not planned and the drift has not changed: left closed.`);
        return;
      }
      const made = await gh.call<Issue>('POST', '/issues', { title, body: text, labels: [LABEL] });
      core.info(`Drift issue #${made.number} opened.`);
      return;
    }
    const changed = !(issue.body ?? '').split('\n').includes(sameDrift);
    await gh.call('PATCH', `/issues/${issue.number}`, { title, body: text, state: 'open' });
    if (changed) {
      await gh.call('POST', `/issues/${issue.number}/comments`, {
        body: `The drift changed with build ${code(ctx.buildJobId)} of ${code(ctx.service)}: the issue now shows it.`,
      });
    }
    // Two runs that each opened one leave the oldest: the newer ones close as its duplicates.
    for (const extra of open.slice(0, -1)) {
      await gh.call('POST', `/issues/${extra.number}/comments`, { body: `Duplicate of #${issue.number}.` });
      await gh.call('PATCH', `/issues/${extra.number}`, { state: 'closed', state_reason: 'completed' });
    }
    core.info(`Drift issue #${issue.number} updated${changed ? ': the drift changed' : ''}.`);
  } catch (err) {
    core.warning(`Drift issue not updated: ${err instanceof Error ? err.message : String(err)}`);
  }
}
