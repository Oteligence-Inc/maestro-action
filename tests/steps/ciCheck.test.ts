import nock from 'nock';
jest.mock('@actions/core');
import * as core from '@actions/core';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MaestroApi } from '../../src/api';
import { Rule, RuleSet } from '../../src/ciRules';
import {
  FINDINGS_MAX,
  checkResult,
  fetchRules,
  filesFor,
  findingsOf,
  fingerprint,
  logPolicyCheck,
  printable,
  readMapping,
  readRepo,
  runCheck,
  scan,
  sendablePath,
  trackedFiles,
  verdict,
} from '../../src/steps/ciCheck';
import { UserError } from '../../src/util/errors';

const BASE = 'https://api.oteligence.com';
const RULES = '/api/job-manager/projects/proj_1/envs/prod/ci-rules';

function client(): MaestroApi {
  const a = new MaestroApi(BASE);
  a.setToken('jwt');
  return a;
}

function rule(id: string, severity: string, over: Partial<Rule>): Rule {
  return { id, severity, exact: [], prefixes: [], suffixes: [], except: [], test: 'any', values: [], since: 1, ...over };
}

function ruleSet(mode: string): RuleSet {
  return {
    version: 1,
    mode,
    floor: 'INFO',
    exporter: 'otlp',
    lockFree: false,
    digest: 'a'.repeat(64),
    rules: [
      rule('LOG_LEVEL_BELOW_FLOOR', 'error', { prefixes: ['logging.level.'], test: 'below_floor' }),
      rule('SPRING_DEBUG', 'warning', { exact: ['debug', 'trace'], test: 'spring_set' }),
      rule('SQL_SANITIZER_OFF', 'error', { suffixes: ['.statement.sanitizer.enabled'], test: 'otel_false' }),
    ],
  };
}

function served(mode: string, extra: Record<string, unknown> = {}) {
  return { data: { ...ruleSet(mode), casesDigest: null, baseline: null, ...extra } };
}

/** A git repository holding `files`, all committed unless named in `untracked`. */
function repo(files: Record<string, string>, untracked: string[] = []): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-check-'));
  execFileSync('git', ['init', '-q', root]);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const tracked = Object.keys(files).filter((f) => !untracked.includes(f));
  if (tracked.length > 0) execFileSync('git', ['-C', root, 'add', '--', ...tracked]);
  return root;
}

afterEach(() => {
  nock.cleanAll();
  jest.clearAllMocks();
});

describe('fetchRules', () => {
  it('asks for one service at the version this Action reads', async () => {
    nock(BASE).get(RULES).query({ service: 'orders', versions: '1' }).reply(200, served('WARN', { baseline: ['x'] }));
    const got = await fetchRules(client(), 'proj_1', 'prod', 'orders');
    expect(got.ruleSet.mode).toBe('WARN');
    expect(got.baseline).toEqual(['x']);
  });

  it.each([
    ['another version', { version: 2 }, 'version 2'],
    ['an unknown test', { rules: [rule('NEW', 'error', { test: 'regex' })] }, 'NEW uses a test this Action does not know'],
    ['no digest', { digest: undefined }, 'no mode, floor or digest'],
    ['an unknown mode', { mode: 'FAIL_LOUDLY' }, 'a mode this Action does not know'],
    ['an unknown floor', { floor: 'VERBOSE' }, 'a floor this Action does not know'],
    ['a digest out of shape', { digest: 'abc' }, 'digest is out of shape'],
    ['an unknown severity', { rules: [rule('NEW', 'fatal', {})] }, 'a severity this Action does not know'],
    ['a rule id out of shape', { rules: [rule('new\n::warning::x', 'error', {})] }, 'a rule id is out of shape'],
  ])('refuses a rule set with %s, loudly', async (_what, over, message) => {
    nock(BASE).get(RULES).query(true).reply(200, { data: { ...ruleSet('WARN'), ...over } });
    await expect(fetchRules(client(), 'proj_1', 'prod', 'orders')).rejects.toThrow(message);
  });

  it('asks for the rules of the lock the build names', async () => {
    nock(BASE).get(RULES).query({ service: 'orders', versions: '1', lockedVersionUid: 'lv_4' }).reply(200, served('FAIL'));
    expect((await fetchRules(client(), 'proj_1', 'prod', 'orders', 'lv_4')).ruleSet.mode).toBe('FAIL');
  });

  it('names a service the locked analysis does not hold, apart from a missing environment', async () => {
    nock(BASE).get(RULES).query(true).reply(404, { data: { code: 'ci_rules_service_unknown' } });
    await expect(fetchRules(client(), 'proj_1', 'prod', 'orders')).rejects.toThrow('holds no service named "orders"');
  });

  it('names an environment that does not exist', async () => {
    nock(BASE).get(RULES).query(true).reply(404, { message: 'Environment not found' });
    await expect(fetchRules(client(), 'proj_1', 'prod', 'orders')).rejects.toThrow('Env "prod" was not found');
  });
});

describe('which files are read', () => {
  it('reads tracked deployment files only: never an untracked file, a link, tooling, tests or packaged config', () => {
    const root = repo(
      {
        'deploy/values.yaml': 'env:\n  LOGGING_LEVEL_ROOT: DEBUG\n',
        'deploy/untracked.yaml': 'env:\n  LOGGING_LEVEL_ROOT: DEBUG\n',
        '.github/workflows/ci.yml': 'env:\n  LOGGING_LEVEL_ROOT: DEBUG\n',
        'src/main/resources/application.yml': 'logging:\n  level:\n    root: DEBUG\n',
        'src/test/resources/application.yml': 'logging:\n  level:\n    root: DEBUG\n',
        'node_modules/x/values.yaml': 'env:\n  LOGGING_LEVEL_ROOT: DEBUG\n',
        '.o11y/maestro.env': 'LOGGING_LEVEL_ROOT=DEBUG\n',
      },
      ['deploy/untracked.yaml'],
    );
    fs.symlinkSync(path.join(root, 'deploy/values.yaml'), path.join(root, 'deploy/link.yaml'));
    execFileSync('git', ['-C', root, 'add', 'deploy/link.yaml']);
    const files = trackedFiles(root)!;
    expect(files).toContain('deploy/link.yaml');
    const read = scan(root, files);
    expect(read.read).toBe(1);
    expect(new Set(read.settings.map((s) => s.path))).toEqual(new Set(['deploy/values.yaml']));
  });

  it('names a file too large to read, and reads the rest', () => {
    const root = repo({ 'big.env': 'A=1\n'.repeat(300_000), 'small.env': 'DEBUG=true\n' });
    const read = scan(root, trackedFiles(root)!);
    expect(read.problems).toEqual([{ path: 'big.env', line: 1, reason: expect.stringContaining('larger than') }]);
    expect(read.settings.map((s) => s.name)).toEqual(['debug']);
  });

  it('lists a path once while it is in a merge conflict', () => {
    const root = repo({ 'a.env': 'DEBUG=1\n' });
    const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args]);
    git('commit', '-qm', 'base');
    git('checkout', '-qb', 'other');
    fs.writeFileSync(path.join(root, 'a.env'), 'DEBUG=2\n');
    git('commit', '-qam', 'other');
    git('checkout', '-q', '-');
    fs.writeFileSync(path.join(root, 'a.env'), 'DEBUG=3\n');
    git('commit', '-qam', 'mine');
    try {
      git('merge', '-q', 'other');
    } catch {
      // the conflict is the fixture
    }
    expect(execFileSync('git', ['-C', root, 'ls-files', '-z']).toString().split('\0').filter(Boolean)).toHaveLength(3);
    expect(trackedFiles(root)).toEqual(['a.env']);
  });

  it('runs no fsmonitor command the repository configures', () => {
    const root = repo({ 'a.env': 'DEBUG=true\n' });
    const marker = path.join(root, 'RAN');
    const hook = path.join(root, 'hook.sh');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
    execFileSync('git', ['-C', root, 'config', 'core.fsmonitor', hook]);
    expect(trackedFiles(root)).toEqual(['a.env']);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('names a file holding a NUL byte, and reads the rest', () => {
    const root = repo({ 'bin.env': 'DEBUG=true\u0000\n', 'ok.env': 'DEBUG=true\n' });
    const read = scan(root, trackedFiles(root)!);
    expect(read.problems).toEqual([{ path: 'bin.env', line: 1, reason: 'holds a NUL byte, not read' }]);
    expect(read.settings.map((s) => s.path)).toEqual(['ok.env']);
  });

  it('reads a file a mapping names where a check without one does not look', () => {
    const root = repo({ 'build/helm/values.yaml': 'env:\n  LOGGING_LEVEL_ROOT: DEBUG\n' });
    expect(scan(root, trackedFiles(root)!).read).toBe(0);
    expect(scan(root, trackedFiles(root)!, true).read).toBe(1);
  });

  it('reports a workspace that is not a git checkout as no files', () => {
    expect(trackedFiles(fs.mkdtempSync(path.join(os.tmpdir(), 'not-git-')))).toBeNull();
  });

  it.each([
    ['deploy/values.yaml', true],
    ['../etc/values.yaml', false],
    ['/abs.yaml', false],
    ['a\\b.yaml', false],
    ['a//b.yaml', false],
    ['tab\tname.yaml', false],
    ['x'.repeat(401), false],
  ])('sends %s as a path: %s', (p, ok) => {
    expect(sendablePath(p)).toBe(ok);
  });
});

describe('findings', () => {
  it('gives one finding per rule for one setting, under the longest name it matched', () => {
    const root = repo({
      'v.yaml': 'otel:\n  instrumentation:\n    jdbc:\n      statement-sanitizer:\n        enabled: false\n',
    });
    const found = findingsOf(ruleSet('WARN'), scan(root, trackedFiles(root)!).settings);
    expect(found).toEqual([
      {
        rule: 'SQL_SANITIZER_OFF',
        severity: 'error',
        name: 'otel.instrumentation.jdbc.statement.sanitizer.enabled',
        path: 'v.yaml',
        line: 5,
      },
    ]);
  });

  it('keeps two settings on one line apart', () => {
    const root = repo({ 'Dockerfile': 'ENV LOGGING_LEVEL_A=DEBUG LOGGING_LEVEL_B=TRACE\n' });
    const found = findingsOf(ruleSet('WARN'), scan(root, trackedFiles(root)!).settings);
    expect(found.map((f) => f.name)).toEqual(['logging.level.a', 'logging.level.b']);
  });

  it('sends at most FINDINGS_MAX findings beside the whole total', () => {
    const many = Array.from({ length: FINDINGS_MAX + 3 }, (_, i) => ({
      rule: 'LOG_LEVEL_BELOW_FLOOR', severity: 'error', name: `logging.level.a${i}`, path: 'x.env', line: i + 1,
    }));
    const result = checkResult('orders', ruleSet('WARN'), many);
    expect(result.total).toBe(FINDINGS_MAX + 3);
    expect(result.findings).toHaveLength(FINDINGS_MAX);
    expect(Object.keys(result.findings[0]).sort()).toEqual(['line', 'name', 'path', 'rule']);
  });
});

describe('the verdict, as job-manager decides it', () => {
  const error = { rule: 'LOG_LEVEL_BELOW_FLOOR', severity: 'error', name: 'logging.level.root', path: 'v.yaml', line: 2 };
  const warning = { rule: 'SPRING_DEBUG', severity: 'warning', name: 'debug', path: '.env', line: 1 };

  it('passes a clean check in every mode', () => {
    for (const mode of ['WARN', 'FAIL', 'FAIL_ON_NEW']) expect(verdict(mode, [], 0, null).outcome).toBe('passed');
  });

  it('fails an error-severity finding in FAIL mode, reports a warning, and only warns in WARN mode', () => {
    expect(verdict('FAIL', [error], 1, null).outcome).toBe('failed');
    expect(verdict('FAIL', [warning], 1, null).outcome).toBe('warned');
    expect(verdict('WARN', [error], 1, null).outcome).toBe('warned');
  });

  it("accepts production's first checked build, then fails only error-severity findings new since its baseline", () => {
    expect(verdict('FAIL_ON_NEW', [error], 1, null)).toEqual({ outcome: 'warned', newFindings: null, reason: null });
    expect(verdict('FAIL_ON_NEW', [error], 1, [fingerprint(error)]).outcome).toBe('warned');
    expect(verdict('FAIL_ON_NEW', [error], 1, ['OTHER|x|y'])).toMatchObject({ outcome: 'failed', newFindings: 1 });
    expect(verdict('FAIL_ON_NEW', [warning], 1, ['OTHER|x|y']).outcome).toBe('warned');
  });

  it('fails a truncated check where the mode enforces, even when every listed finding is known', () => {
    expect(verdict('FAIL_ON_NEW', [error], 11, [fingerprint(error)])).toMatchObject({ outcome: 'failed', newFindings: 1 });
    expect(verdict('FAIL', [warning], 11, null).outcome).toBe('failed');
  });
});

describe('logPolicyCheck', () => {
  const secret = 'hunter2-not-a-log-level';

  it('is off when the environment says so, and reads nothing', async () => {
    nock(BASE).get(RULES).query(true).reply(200, served('OFF'));
    expect(await logPolicyCheck(client(), 'proj_1', 'prod', 'orders', '/nonexistent')).toBeNull();
    expect(core.setOutput).toHaveBeenCalledWith('log-policy-check', 'off');
  });

  it('is not run, with a warning, outside a git checkout where the mode accepts a build with no check', async () => {
    for (const mode of ['WARN', 'FAIL_ON_NEW']) {
      nock(BASE).get(RULES).query(true).reply(200, served(mode));
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-git-'));
      expect(await logPolicyCheck(client(), 'proj_1', 'prod', 'orders', dir)).toBeNull();
      expect(core.setOutput).toHaveBeenLastCalledWith('log-policy-findings', '0');
      expect(core.setOutput).toHaveBeenCalledWith('log-policy-check', 'not-run');
    }
  });

  it('fails before anything is uploaded outside a git checkout where the mode refuses a build with no check', async () => {
    nock(BASE).get(RULES).query(true).reply(200, served('FAIL'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-git-'));
    await expect(logPolicyCheck(client(), 'proj_1', 'prod', 'orders', dir)).rejects.toThrow('check out the repository');
    expect(core.setOutput).toHaveBeenCalledWith('log-policy-check', 'failed');
  });

  it('fails a check-only run outside a git checkout in either enforcing mode, and not in WARN', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-git-'));
    const repoOf = readRepo(dir);
    for (const [mode, outcome] of [['FAIL_ON_NEW', 'failed'], ['FAIL', 'failed'], ['WARN', 'not-run']]) {
      nock(BASE).get(RULES).query(true).reply(200, served(mode));
      const run = await runCheck(client(), 'proj_1', 'prod', 'orders', dir, repoOf, { checkOnly: true });
      expect(run.outcome).toBe(outcome);
    }
  });

  it('prints a service and environment with their control characters shown as ?', () => {
    expect(printable('orders\n::error::x\r')).toBe('orders?::error::x?');
    expect(printable('a' + String.fromCharCode(0x2028) + 'b')).toBe('a?b');
  });

  it('prints each finding by rule, name, file and line, and never a value', async () => {
    nock(BASE).get(RULES).query(true).reply(200, served('WARN'));
    const root = repo({ 'deploy/.env': `LOGGING_LEVEL_ROOT=DEBUG\nDEBUG=${secret}\nSPRING_APPLICATION_JSON={${secret}\n` });
    const result = await logPolicyCheck(client(), 'proj_1', 'prod', 'orders', root);
    expect(result).toMatchObject({ service: 'orders', ruleSetDigest: 'a'.repeat(64), total: 2 });
    expect(core.warning).toHaveBeenCalledWith('SPRING_DEBUG: debug', expect.objectContaining({ file: 'deploy/.env', startLine: 2 }));
    expect(core.error).toHaveBeenCalledWith('LOG_LEVEL_BELOW_FLOOR: logging.level.root', {
      file: 'deploy/.env', startLine: 1, title: 'Maestro log policy: LOG_LEVEL_BELOW_FLOOR',
    });
    const printed = JSON.stringify([
      (core.error as jest.Mock).mock.calls, (core.warning as jest.Mock).mock.calls, (core.info as jest.Mock).mock.calls,
    ]);
    expect(printed).toContain('SPRING_APPLICATION_JSON is not JSON');
    expect(printed).not.toContain('hunter2');
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(core.setOutput).toHaveBeenCalledWith('log-policy-check', 'warned');
  });

  it('fails before anything is uploaded when the mode fails the check', async () => {
    nock(BASE).get(RULES).query(true).reply(200, served('FAIL'));
    const root = repo({ 'deploy/.env': 'LOGGING_LEVEL_ROOT=DEBUG\n' });
    await expect(logPolicyCheck(client(), 'proj_1', 'prod', 'orders', root)).rejects.toBeInstanceOf(UserError);
    expect(core.setOutput).toHaveBeenCalledWith('log-policy-check', 'failed');
  });

  it("checks only the files the mapping gives the service and environment", async () => {
    nock(BASE).get(RULES).query(true).reply(200, served('FAIL'));
    const root = repo({
      'deploy/orders/prod.env': 'LOGGING_LEVEL_ROOT=INFO\n',
      'deploy/payments/prod.env': 'LOGGING_LEVEL_ROOT=DEBUG\n',
      '.maestro/check.yml': 'services:\n  - service: orders\n    environment: prod\n    paths: ["deploy/orders/**"]\n',
    });
    const result = await logPolicyCheck(client(), 'proj_1', 'prod', 'orders', root);
    expect(result?.total).toBe(0);
  });

  const mapped = (paths: string) => ({
    'deploy/orders/prod.env': 'LOGGING_LEVEL_ROOT=DEBUG\n',
    '.maestro/check.yml': `services:\n  - service: payments\n    environment: prod\n    paths: [${paths}]\n`,
  });

  it('warns where a mapping maps nothing to the service and the mode does not enforce, and fails where it does', async () => {
    nock(BASE).get(RULES).query(true).reply(200, served('WARN'));
    const root = repo(mapped('"deploy/**"'));
    expect((await logPolicyCheck(client(), 'proj_1', 'prod', 'orders', root))?.total).toBe(0);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('maps no files to orders in prod'));

    nock(BASE).get(RULES).query(true).reply(200, served('FAIL_ON_NEW'));
    await expect(logPolicyCheck(client(), 'proj_1', 'prod', 'orders', root)).rejects.toThrow('maps no files to orders in prod');
  });

  it('fails where the mode enforces when a mapping entry for the service matches no tracked file', async () => {
    nock(BASE).get(RULES).query(true).reply(200, served('FAIL'));
    const root = repo(mapped('"helm/payments/**"'));
    await expect(logPolicyCheck(client(), 'proj_1', 'prod', 'payments', root)).rejects.toThrow(
      'entry 1 for payments in prod matches no tracked file',
    );
    nock(BASE).get(RULES).query(true).reply(200, served('FAIL'));
    const ok = repo(mapped('"deploy/**"'));
    await expect(logPolicyCheck(client(), 'proj_1', 'prod', 'payments', ok)).rejects.toThrow('error-severity finding');
  });
});

const readOf = (root: string) => readMapping(root, trackedFiles(root)!);

describe('the mapping file', () => {
  it('is absent when the repository has none', () => {
    expect(readOf(repo({ 'a.env': '' }))).toBeNull();
  });

  it.each([
    ['not YAML', 'services: [unclosed'],
    ['no services', 'other: 1\n'],
    ['an entry without paths', 'services:\n  - service: orders\n    environment: prod\n'],
    ['holding a control character', 'services:\n  - service: "orders\\n::error::x"\n    environment: prod\n    paths: ["a"]\n'],
  ])('refuses one that is %s', (_what, text) => {
    expect(() => readOf(repo({ '.maestro/check.yml': text }))).toThrow(UserError);
  });

  const good = 'services:\n  - service: orders\n    environment: prod\n    paths: ["a/**"]\n';

  it('reads a tracked one, and refuses one that is untracked, a link or too large', () => {
    expect(readOf(repo({ '.maestro/check.yml': good }))).toEqual([{ service: 'orders', environment: 'prod', paths: ['a/**'] }]);
    expect(() => readOf(repo({ '.maestro/check.yml': good }, ['.maestro/check.yml']))).toThrow('is not tracked');
    const linked = repo({ 'elsewhere.yml': good });
    fs.mkdirSync(path.join(linked, '.maestro'));
    fs.symlinkSync(path.join(linked, 'elsewhere.yml'), path.join(linked, '.maestro/check.yml'));
    execFileSync('git', ['-C', linked, 'add', '.maestro/check.yml']);
    expect(() => readOf(linked)).toThrow('is not a regular file');
    expect(() => readOf(repo({ '.maestro/check.yml': good + '#'.repeat(70 * 1024) }))).toThrow('larger than');
  });

  it('prints nothing of a mapping it cannot parse', () => {
    const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const log = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => readOf(repo({ '.maestro/check.yml': 'services:\n  - !!secret hunter2\n' }))).toThrow(UserError);
    expect(JSON.stringify([warn.mock.calls, log.mock.calls])).not.toContain('hunter2');
    warn.mockRestore();
    log.mockRestore();
  });

  it('reads no mapping outside a git checkout', () => {
    expect(readRepo(fs.mkdtempSync(path.join(os.tmpdir(), 'not-git-')))).toEqual({ files: null, mapping: null });
  });

  it('assigns files by glob to a service and environment, and leaves the rest out', () => {
    const mapping = [{ service: 'orders', environment: 'prod', paths: ['deploy/orders/**', 'compose.yml'] }];
    expect(filesFor(['deploy/orders/a.yaml', 'deploy/payments/a.yaml', 'compose.yml'], mapping, 'orders', 'prod')).toEqual([
      'deploy/orders/a.yaml',
      'compose.yml',
    ]);
    expect(filesFor(['deploy/orders/a.yaml'], mapping, 'orders', 'staging')).toEqual([]);
    expect(filesFor(['x.yaml'], null, 'orders', 'prod')).toEqual(['x.yaml']);
  });
});
