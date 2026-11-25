jest.mock('@actions/core');
import * as core from '@actions/core';
import { body, digest, DriftIssueContext, GitHubSend, LABEL, marker, summarize, syncDriftIssue } from '../../src/steps/driftIssue';

interface FakeIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: 'open' | 'closed';
  state_reason?: string | null;
  comments: string[];
  pull_request?: unknown;
}

/** An in-memory GitHub REST API for one repository: issues newest first, their comments, the repository's visibility. */
class FakeGitHub {
  issues: FakeIssue[] = [];
  calls: string[] = [];
  private = true;
  failWith: number | null = null;
  dropLabels = false;
  tokens: string[] = [];

  send: GitHubSend = async (method, url, headers, raw) => {
    const u = new URL(url);
    this.calls.push(`${method} ${u.pathname}${u.search}`);
    this.tokens.push(headers.authorization);
    if (this.failWith) return { status: this.failWith, json: { message: 'secret detail' } };
    const path = u.pathname.replace('/repos/acme/app', '');
    const payload = raw ? JSON.parse(raw) : undefined;
    if (method === 'GET' && path === '') return { status: 200, json: { private: this.private } };
    if (method === 'GET' && path === '/issues') {
      const page = Number(u.searchParams.get('page') ?? '1');
      const per = Number(u.searchParams.get('per_page') ?? '30');
      const all = [...this.issues].reverse().filter((i) => i.state === u.searchParams.get('state'));
      return { status: 200, json: all.slice((page - 1) * per, page * per) };
    }
    if (method === 'POST' && path === '/issues') {
      const issue: FakeIssue = { number: this.issues.length + 1, title: payload.title, body: payload.body,
        labels: this.dropLabels ? [] : payload.labels, state: 'open', comments: [] };
      this.issues.push(issue);
      return { status: 201, json: issue };
    }
    const m = /^\/issues\/(\d+)(\/comments)?$/.exec(path);
    const issue = m ? this.issues.find((i) => i.number === Number(m[1])) : undefined;
    if (!issue) return { status: 404, json: {} };
    if (m![2] && method === 'POST') {
      issue.comments.push(payload.body);
      return { status: 201, json: {} };
    }
    if (method === 'PATCH') {
      Object.assign(issue, payload);
      return { status: 200, json: issue };
    }
    return { status: 405, json: {} };
  };

  open(): number[] {
    return this.issues.filter((i) => i.state === 'open').map((i) => i.number);
  }
}

const ENV = { GITHUB_API_URL: 'https://api.github.test', GITHUB_REPOSITORY: 'acme/app', GITHUB_SERVER_URL: 'https://github.test',
  GITHUB_RUN_ID: '77', GITHUB_EVENT_NAME: 'push' };

function ctx(gh: FakeGitHub, over: Partial<DriftIssueContext> = {}): DriftIssueContext {
  return { token: 'ghs_tok', allowPublic: false, projectUid: 'proj_1', environment: 'production', service: 'orders',
    ownNames: ['orders'], buildJobId: 'job_1', env: ENV, send: gh.send, ...over };
}

const zero = { recommendedNotInLock: { count: 0, keys: [] }, lockedNotInJar: { count: 0, keys: [] } };
const drift = (services: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ status: 'checked', lockVersion: 4, services, ...extra });
const ADDED = drift({ orders: { recommendedNotInLock: { count: 1, keys: ['orders::com.acme.Orders.audit'] },
  lockedNotInJar: { count: 0, keys: [] } }, billing: zero,
  payments: { recommendedNotInLock: { count: 1, keys: ['payments::com.acme.Pay.secret'] }, lockedNotInJar: { count: 0, keys: [] } } });
const REMOVED = drift({ orders: { recommendedNotInLock: { count: 0, keys: [] },
  lockedNotInJar: { count: 2, keys: ['orders::com.acme.Orders.old', 'orders::com.acme.Orders.gone'] } } });
const NONE = drift({ orders: zero, payments: { recommendedNotInLock: { count: 3, keys: ['payments::x'] } } });

beforeEach(() => jest.clearAllMocks());

describe('summarize', () => {
  it('reads only a compared drift, and only the run\'s own services', () => {
    for (const status of ['no_lock', 'lock_has_no_analysis', 'unreadable', 'unbound', undefined]) {
      expect(summarize({ status, services: {} }, ['orders'])).toBeNull();
    }
    expect(summarize(null)).toBeNull();
    expect(summarize({ status: 'checked', services: [] })).toBeNull();
    expect(summarize({ status: 'same_analysis', lockVersion: 3 })).toEqual({ lockVersion: 3, services: {}, unmatched: [],
      engineChanged: false, goalsChanged: false });
    const s = summarize(ADDED, ['orders'])!;
    expect(Object.keys(s.services)).toEqual(['orders']);
    expect(Object.keys(summarize(ADDED, [])!.services)).toEqual(['orders', 'payments']);
    expect(summarize(drift({}, { unmatchedServices: ['b', 'orders', 'a', 7] }), ['orders'])!.unmatched).toEqual(['orders']);
    expect(summarize(drift({}, { unmatchedServices: ['b', 'a'] }), [])!.unmatched).toEqual(['a', 'b']);
    expect(Object.keys(summarize(drift({ b: { lockedNotInJar: { count: 1 } }, B: { lockedNotInJar: { count: 1 } },
      a: { lockedNotInJar: { count: 1 } } }), [])!.services)).toEqual(['B', 'a', 'b']);
  });

  it('a service named __proto__ is a service, not the prototype', () => {
    const s = summarize(JSON.parse('{"status":"checked","services":{"__proto__":{"lockedNotInJar":{"count":1}}}}'), [])!;
    expect(Object.keys(s.services)).toEqual(['__proto__']);
  });
});

describe('the digest', () => {
  it('changes with the lock version and every method named, and without names only with the counts', () => {
    const a = summarize(ADDED, ['orders'])!;
    expect(digest(a, true)).toBe(digest(summarize(ADDED, ['orders'])!, true));
    expect(digest({ ...a, lockVersion: 5 }, true)).not.toBe(digest(a, true));
    const renamed = summarize(drift({ orders: { recommendedNotInLock: { count: 1, keys: ['orders::com.acme.Orders.other'] } } }), ['orders'])!;
    expect(digest(renamed, true)).not.toBe(digest(a, true));
    expect(digest(renamed, false)).toBe(digest(a, false));
    expect(digest({ ...a, unmatched: ['orders'] }, true)).not.toBe(digest(a, true));
  });
});

describe('the drift issue', () => {
  it('opens one issue for the service when its build drifts, naming only its own methods in a private repository', async () => {
    const gh = new FakeGitHub();
    await syncDriftIssue(ADDED, ctx(gh));
    expect(gh.issues).toHaveLength(1);
    const issue = gh.issues[0];
    expect(issue.labels).toEqual([LABEL]);
    expect(issue.title).toBe('Maestro: orders in production drifts from lock v4');
    expect(issue.body).toContain('`orders::com.acme.Orders.audit`');
    expect(issue.body).not.toContain('Pay.secret');
    expect(issue.body).not.toContain('payments');
    expect(issue.body.split('\n')).toContain(marker('proj_1', 'production', 'orders'));
    expect(issue.body).toContain('([run](https://github.test/acme/app/actions/runs/77))');
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
    expect(gh.issues[0].body).toContain(digest(summarize(ADDED, ['orders'])!, false));
    expect(gh.issues[0].body).not.toContain(digest(summarize(ADDED, ['orders'])!, true));

    const named = new FakeGitHub();
    named.private = false;
    await syncDriftIssue(ADDED, ctx(named, { allowPublic: true }));
    expect(named.issues[0].body).toContain('Orders.audit');
    expect(named.calls).not.toContain('GET /repos/acme/app');
  });

  it('edits the issue on each later build, commenting only when the drift changed, and keeps it open', async () => {
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
    expect(gh.calls.filter((c) => c.startsWith('PATCH'))).toHaveLength(2);
    expect(gh.issues[0].state).toBe('open');
  });

  it('closes the issue when a build of the service shows no drift, whatever its peers read', async () => {
    const gh = new FakeGitHub();
    await syncDriftIssue(NONE, ctx(gh));
    expect(gh.issues).toHaveLength(0);
    await syncDriftIssue(ADDED, ctx(gh));
    await syncDriftIssue(NONE, ctx(gh, { buildJobId: 'job_9' }));
    expect(gh.issues[0].state).toBe('closed');
    expect(gh.issues[0].state_reason).toBe('completed');
    expect(gh.issues[0].comments).toEqual(['Build `job_9` of `orders` shows no drift against lock v4: closing.']);
    await syncDriftIssue(ADDED, ctx(gh));
    expect(gh.open()).toEqual([2]);
  });

  it("leaves another service's issue alone when this one builds clean", async () => {
    const gh = new FakeGitHub();
    await syncDriftIssue(drift({ payments: { lockedNotInJar: { count: 1, keys: ['payments::p'] } } }),
      ctx(gh, { service: 'payments', ownNames: ['payments'] }));
    await syncDriftIssue(drift({ orders: zero, payments: zero }), ctx(gh, { service: 'orders', ownNames: ['orders'] }));
    expect(gh.open()).toEqual([1]);
  });

  it('a build that compared nothing, or a pull request run, leaves the issue as it is', async () => {
    const gh = new FakeGitHub();
    await syncDriftIssue(ADDED, ctx(gh));
    await syncDriftIssue({ status: 'no_lock' }, ctx(gh));
    await syncDriftIssue(NONE, ctx(gh, { env: { ...ENV, GITHUB_EVENT_NAME: 'pull_request' } }));
    await syncDriftIssue(NONE, ctx(gh, { env: { ...ENV, GITHUB_EVENT_NAME: 'pull_request_target' } }));
    expect(gh.open()).toEqual([1]);
    expect(gh.calls.filter((c) => c.startsWith('PATCH'))).toEqual([]);
  });

  it('closing an unmatched service is not a clean build', async () => {
    const gh = new FakeGitHub();
    await syncDriftIssue(drift({ orders: zero }, { status: 'unmatched', unmatchedServices: ['orders'] }), ctx(gh));
    expect(gh.open()).toEqual([1]);
    expect(gh.issues[0].body).toContain('holds no methods for `orders`');
  });

  it('says so when the engine or the goals changed since the lock', async () => {
    const gh = new FakeGitHub();
    await syncDriftIssue({ ...ADDED, engineChanged: true, goalsChanged: true }, ctx(gh));
    expect(gh.issues[0].body).toContain('The analysis engine changed since the lock');
    expect(gh.issues[0].body).toContain('The goals changed since the lock');
  });

  it('leaves an issue a person closed as not planned closed while the drift is the same, and reopens on a change', async () => {
    const gh = new FakeGitHub();
    await syncDriftIssue(ADDED, ctx(gh));
    Object.assign(gh.issues[0], { state: 'closed', state_reason: 'not_planned' });
    await syncDriftIssue(ADDED, ctx(gh, { buildJobId: 'job_2' }));
    expect(gh.issues).toHaveLength(1);
    await syncDriftIssue(REMOVED, ctx(gh, { buildJobId: 'job_3' }));
    expect(gh.open()).toEqual([2]);
  });

  it('finds its issue by its marker, whatever its labels, and never a pull request or a marker inside a line', async () => {
    const gh = new FakeGitHub();
    gh.dropLabels = true;
    await syncDriftIssue(ADDED, ctx(gh));
    await syncDriftIssue(NONE, ctx(gh));
    expect(gh.issues[0].state).toBe('closed');

    const planted = new FakeGitHub();
    const mark = marker('proj_1', 'production', 'orders');
    planted.issues.push({ number: 1, title: 'x', body: `text ${mark} more`, labels: [LABEL], state: 'open', comments: [] });
    planted.issues.push({ number: 2, title: 'pr', body: mark, labels: [LABEL], state: 'open', comments: [], pull_request: {} });
    await syncDriftIssue(NONE, ctx(planted));
    expect(planted.open()).toEqual([1, 2]);
  });

  it('reads past the first page of open issues', async () => {
    const gh = new FakeGitHub();
    await syncDriftIssue(ADDED, ctx(gh));
    for (let i = 0; i < 150; i++) {
      gh.issues.push({ number: gh.issues.length + 1, title: 'other', body: 'x', labels: [], state: 'open', comments: [] });
    }
    await syncDriftIssue(NONE, ctx(gh));
    expect(gh.issues[0].state).toBe('closed');
    expect(gh.calls).toContain('GET /repos/acme/app/issues?state=open&per_page=100&page=2');
  });

  it('closes the newer of two issues two runs opened, keeping the oldest', async () => {
    const gh = new FakeGitHub();
    await syncDriftIssue(ADDED, ctx(gh));
    gh.issues.push({ ...gh.issues[0], number: 2, comments: [] });
    await syncDriftIssue(ADDED, ctx(gh, { buildJobId: 'job_2' }));
    expect(gh.open()).toEqual([1]);
    expect(gh.issues[1].comments).toEqual(['Duplicate of #1.']);
  });

  it('warns and never fails the step when GitHub refuses, without echoing its answer', async () => {
    const gh = new FakeGitHub();
    gh.failWith = 403;
    await expect(syncDriftIssue(ADDED, ctx(gh))).resolves.toBeUndefined();
    expect(core.warning).toHaveBeenCalledWith('Drift issue not updated: GitHub answered 403 to GET /issues');
    expect(JSON.stringify((core.warning as jest.Mock).mock.calls)).not.toContain('secret detail');
    for (const repo of ['', '../..', 'acme/..', 'acme']) {
      await syncDriftIssue(ADDED, ctx(gh, { env: { ...ENV, GITHUB_REPOSITORY: repo } }));
      expect(core.warning).toHaveBeenLastCalledWith('Drift issue not updated: GITHUB_REPOSITORY is not an owner/repository name.');
    }
  });

  it('keeps a name from the bytecode inside its inline code', () => {
    const s = summarize(drift({ 'svc`x': { recommendedNotInLock: { count: 1, keys: ['a`|b\n</td> @u #1'] } } }), [])!;
    const text = body(s, ctx(new FakeGitHub()), true, null);
    expect(text).toContain('`svcx`');
    expect(text).toContain('`a\\|b</td> @u #1`');
    expect(text).not.toContain('a`|b');
  });

  it('names the methods job-manager sends, at most ten, with the full count', () => {
    const keys = Array.from({ length: 12 }, (_, i) => `svc::m${String(i).padStart(2, '0')}`);
    const s = summarize(drift({ svc: { recommendedNotInLock: { count: 30, keys } } }), [])!;
    const text = body(s, ctx(new FakeGitHub()), true, null);
    expect(text).toContain('30: `svc::m00`');
    expect(text).toContain('`svc::m09` and 20 more');
    expect(text).not.toContain('svc::m10');
  });
});
