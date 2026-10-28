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
  readMapping,
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
    ['an unknown test', { rules: [rule('NEW', 'error', { test: 'regex' })] }, 'does not know (regex)'],
    ['no digest', { digest: undefined }, 'no mode, floor or digest'],
  ])('refuses a rule set with %s, loudly', async (_what, over, message) => {
    nock(BASE).get(RULES).query(true).reply(200, { data: { ...ruleSet('WARN'), ...over } });
    await expect(fetchRules(client(), 'proj_1', 'prod', 'orders')).rejects.toThrow(message);
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
    expect(await logPolicyCheck(client(), 'proj_1', 'prod', 'orders', '/nonexistent', null)).toBeNull();
    expect(core.setOutput).toHaveBeenCalledWith('log-policy-check', 'off');
  });

  it('is not run, with a warning, outside a git checkout', async () => {
    nock(BASE).get(RULES).query(true).reply(200, served('FAIL'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-git-'));
    expect(await logPolicyCheck(client(), 'proj_1', 'prod', 'orders', dir, null)).toBeNull();
    expect(core.setOutput).toHaveBeenCalledWith('log-policy-check', 'not-run');
  });

  it('prints each finding by rule, name, file and line, and never a value', async () => {
    nock(BASE).get(RULES).query(true).reply(200, served('WARN'));
    const root = repo({ 'deploy/.env': `LOGGING_LEVEL_ROOT=DEBUG\nDEBUG=${secret}\nSPRING_APPLICATION_JSON={${secret}\n` });
    const result = await logPolicyCheck(client(), 'proj_1', 'prod', 'orders', root, null);
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
    await expect(logPolicyCheck(client(), 'proj_1', 'prod', 'orders', root, null)).rejects.toBeInstanceOf(UserError);
    expect(core.setOutput).toHaveBeenCalledWith('log-policy-check', 'failed');
  });

  it("checks only the files the mapping gives the service and environment", async () => {
    nock(BASE).get(RULES).query(true).reply(200, served('FAIL'));
    const root = repo({
      'deploy/orders/prod.env': 'LOGGING_LEVEL_ROOT=INFO\n',
      'deploy/payments/prod.env': 'LOGGING_LEVEL_ROOT=DEBUG\n',
      '.maestro/check.yml': 'services:\n  - service: orders\n    environment: prod\n    paths: ["deploy/orders/**"]\n',
    });
    const result = await logPolicyCheck(client(), 'proj_1', 'prod', 'orders', root, readMapping(root));
    expect(result?.total).toBe(0);
  });
});

describe('the mapping file', () => {
  it('is absent when the repository has none', () => {
    expect(readMapping(repo({ 'a.env': '' }))).toBeNull();
  });

  it.each([
    ['not YAML', 'services: [unclosed'],
    ['no services', 'other: 1\n'],
    ['an entry without paths', 'services:\n  - service: orders\n    environment: prod\n'],
  ])('refuses one that is %s', (_what, text) => {
    expect(() => readMapping(repo({ '.maestro/check.yml': text }))).toThrow(UserError);
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
