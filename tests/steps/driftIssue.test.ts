jest.mock('@actions/core');
import * as core from '@actions/core';
import { body, DriftIssueContext, LABEL, marker, summarize, syncDriftIssue } from '../../src/steps/driftIssue';

interface FakeIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: 'open' | 'closed';
  state_reason?: string;
  comments: string[];
}

/** An in-memory GitHub REST API for one repository: issues, their comments, and the repository's visibility. */
class FakeGitHub {
  issues: FakeIssue[] = [];
  calls: string[] = [];
  private = true;
  failWith: number | null = null;
  tokens: string[] = [];

  fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? 'GET';
    this.calls.push(`${method} ${u.pathname}${u.search}`);
    this.tokens.push(String((init?.headers as Record<string, string>)?.authorization));
    const json = (status: number, value: unknown) =>
      ({ ok: status < 300, status, json: async () => value }) as unknown as Response;
    if (this.failWith) return json(this.failWith, { message: 'secret detail' });
    const path = u.pathname.replace('/repos/acme/app', '');
    const payload = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method === 'GET' && path === '') return json(200, { private: this.private });
    if (method === 'GET' && path === '/issues') {
      const label = u.searchParams.get('labels');
      return json(200, this.issues.filter((i) => i.state === u.searchParams.get('state') && (!label || i.labels.includes(label))));
    }
    if (method === 'POST' && path === '/issues') {
      const issue: FakeIssue = { number: this.issues.length + 1, title: payload.title, body: payload.body,
        labels: payload.labels, state: 'open', comments: [] };
      this.issues.push(issue);
      return json(201, issue);
    }
    const m = /^\/issues\/(\d+)(\/comments)?$/.exec(path);
    const issue = m ? this.issues.find((i) => i.number === Number(m[1])) : undefined;
    if (!issue) return json(404, {});
    if (m![2] && method === 'POST') {
      issue.comments.push(payload.body);
      return json(201, {});
    }
    if (method === 'PATCH') {
      Object.assign(issue, payload);
      return json(200, issue);
    }
    return json(405, {});
  }) as unknown as typeof fetch;
}

const ENV = { GITHUB_API_URL: 'https://api.github.test', GITHUB_REPOSITORY: 'acme/app', GITHUB_SERVER_URL: 'https://github.test', GITHUB_RUN_ID: '77' };

function ctx(gh: FakeGitHub, over: Partial<DriftIssueContext> = {}): DriftIssueContext {
  return { token: 'ghs_tok', allowPublic: false, projectUid: 'proj_1', environment: 'production', service: 'orders',
    buildJobId: 'job_1', env: ENV, fetchImpl: gh.fetch, ...over };
}

const drift = (services: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ status: 'checked', lockVersion: 4, services, ...extra });
const ADDED = drift({ orders: { recommendedNotInLock: { count: 1, keys: ['orders::com.acme.Orders.audit'] },
  lockedNotInJar: { count: 0, keys: [] } }, billing: { recommendedNotInLock: { count: 0, keys: [] },
  lockedNotInJar: { count: 0, keys: [] } } });
const REMOVED = drift({ orders: { recommendedNotInLock: { count: 0, keys: [] },
  lockedNotInJar: { count: 2, keys: ['orders::com.acme.Orders.old', 'orders::com.acme.Orders.gone'] } } });
const NONE = drift({ orders: { recommendedNotInLock: { count: 0, keys: [] }, lockedNotInJar: { count: 0, keys: [] } } });

beforeEach(() => jest.clearAllMocks());

describe('summarize', () => {
  it('reads only a compared drift, keeping the services that drift', () => {
    for (const status of ['no_lock', 'lock_has_no_analysis', 'unreadable', 'unbound', undefined]) {
      expect(summarize({ status, services: {} })).toBeNull();
    }
    expect(summarize(null)).toBeNull();
    expect(summarize({ status: 'checked', services: [] })).toBeNull();
    expect(summarize({ status: 'same_analysis', lockVersion: 3 })).toEqual({ lockVersion: 3, services: {}, unmatched: [] });
    const s = summarize(ADDED)!;
    expect(Object.keys(s.services)).toEqual(['orders']);
    expect(s.lockVersion).toBe(4);
    expect(summarize(drift({}, { unmatchedServices: ['b', 'a', 7] }))!.unmatched).toEqual(['a', 'b']);
  });
});

describe('the drift issue', () => {
  it('opens one issue for the environment when a build drifts, naming the methods in a private repository', async () => {
    const gh = new FakeGitHub();
    await syncDriftIssue(ADDED, ctx(gh));
    expect(gh.issues).toHaveLength(1);
    const issue = gh.issues[0];
    expect(issue.labels).toEqual([LABEL]);
    expect(issue.title).toBe('Maestro: production drifts from lock v4');
    expect(issue.body).toContain('`orders::com.acme.Orders.audit`');
    expect(issue.body).toContain(marker('proj_1', 'production'));
    expect(issue.body).toContain('([run](https://github.test/acme/app/actions/runs/77))');
    expect(issue.body).not.toContain('billing');
    expect(gh.tokens.every((t) => t === 'Bearer ghs_tok')).toBe(true);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('keeps method names out of a public repository unless drift-issue-public says otherwise', async () => {
    const gh = new FakeGitHub();
    gh.private = false;
    await syncDriftIssue(ADDED, ctx(gh));
    expect(gh.issues[0].body).not.toContain('Orders.audit');
    expect(gh.issues[0].body).toContain('| `orders` | 1 | 0 |');
    expect(gh.issues[0].body).toContain('this repository is public');

    const named = new FakeGitHub();
    named.private = false;
    await syncDriftIssue(ADDED, ctx(named, { allowPublic: true }));
    expect(named.issues[0].body).toContain('Orders.audit');
    expect(named.calls).not.toContain('GET /repos/acme/app');
  });

  it('edits the issue on each later build, commenting only when the drift changed', async () => {
    const gh = new FakeGitHub();
    await syncDriftIssue(ADDED, ctx(gh));
    await syncDriftIssue(ADDED, ctx(gh, { buildJobId: 'job_2' }));
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0].comments).toEqual([]);
    expect(gh.issues[0].body).toContain('`job_2`');

    await syncDriftIssue(REMOVED, ctx(gh, { buildJobId: 'job_3' }));
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0].body).toContain('Orders.gone');
    expect(gh.issues[0].body).not.toContain('Orders.audit');
    expect(gh.issues[0].comments).toEqual(['The drift changed with build `job_3` of `orders`: the issue now shows it.']);
  });

  it('closes the issue when a build shows no drift, and opens a new one when the drift returns', async () => {
    const gh = new FakeGitHub();
    await syncDriftIssue(NONE, ctx(gh));
    expect(gh.issues).toHaveLength(0);
    await syncDriftIssue(ADDED, ctx(gh));
    await syncDriftIssue({ status: 'same_analysis', lockVersion: 4 }, ctx(gh, { buildJobId: 'job_9' }));
    expect(gh.issues[0].state).toBe('closed');
    expect(gh.issues[0].state_reason).toBe('completed');
    expect(gh.issues[0].comments).toEqual(['Build `job_9` of `orders` shows no drift against lock v4: closing.']);
    await syncDriftIssue(ADDED, ctx(gh));
    expect(gh.issues).toHaveLength(2);
    expect(gh.issues[1].state).toBe('open');
  });

  it("leaves another environment's issue alone, and an issue as it is after a build that compared nothing", async () => {
    const gh = new FakeGitHub();
    await syncDriftIssue(ADDED, ctx(gh, { environment: 'staging' }));
    await syncDriftIssue(NONE, ctx(gh));
    expect(gh.issues[0].state).toBe('open');
    await syncDriftIssue({ status: 'no_lock' }, ctx(gh, { environment: 'staging' }));
    expect(gh.issues[0].state).toBe('open');
    expect(gh.calls.filter((c) => c.startsWith('PATCH'))).toEqual([]);
  });

  it('warns and never fails the step when GitHub refuses, without echoing its answer', async () => {
    const gh = new FakeGitHub();
    gh.failWith = 403;
    await expect(syncDriftIssue(ADDED, ctx(gh))).resolves.toBeUndefined();
    expect(core.warning).toHaveBeenCalledWith('Drift issue not updated: GitHub answered 403 to GET /issues');
    expect(JSON.stringify((core.warning as jest.Mock).mock.calls)).not.toContain('secret detail');
    await syncDriftIssue(ADDED, ctx(gh, { env: { ...ENV, GITHUB_REPOSITORY: '' } }));
    expect(core.warning).toHaveBeenLastCalledWith('Drift issue not updated: GITHUB_REPOSITORY is not set.');
  });

  it('keeps a name from the bytecode inside its inline code', () => {
    const s = summarize(drift({ 'svc`x': { recommendedNotInLock: { count: 1, keys: ['a`|b\n</td>'] } } }))!;
    const text = body(s, ctx(new FakeGitHub()), true, null);
    expect(text).toContain('`svcx`');
    expect(text).toContain('`a\\|b</td>`');
    expect(text).not.toContain('a`|b');
  });

  it('names at most twenty methods of a group, with the full count', () => {
    const keys = Array.from({ length: 25 }, (_, i) => `svc::m${String(i).padStart(2, '0')}`);
    const s = summarize(drift({ svc: { recommendedNotInLock: { count: 30, keys } } }))!;
    const text = body(s, ctx(new FakeGitHub()), true, null);
    expect(text).toContain('30: `svc::m00`');
    expect(text).toContain('`svc::m19` and 10 more');
    expect(text).not.toContain('svc::m20');
  });
});
