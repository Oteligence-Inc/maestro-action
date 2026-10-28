import * as core from '@actions/core';
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { parse as parseYaml } from 'yaml';
import { MaestroApi, expectOk } from '../api';
import { CASES_DIGEST, Finding, RuleSet, VERSION, evaluate, unreadable } from '../ciRules';
import { Problem, SourcedSetting, extract, kindOf } from '../logPolicy/extract';
import { UserError } from '../util/errors';
import { envPath } from './resolveConfig';

/** The most findings a check sends; the total beside them counts the rest. Matches job-manager's limit. */
export const FINDINGS_MAX = 500;
/** A file larger than this is named and not read. */
export const FILE_MAX_BYTES = 1024 * 1024;
/** Where a repository says which of its files deploy which service to which environment. */
export const MAPPING_FILE = '.maestro/check.yml';

/** The largest mapping file read. */
export const MAPPING_MAX_BYTES = 64 * 1024;

/** Paths a check never reads, even when a mapping names them. */
const NEVER_READ = /(^|\/)\.git\//;
/**
 * Paths a check without a mapping does not read: tooling, build output, tests, and the packaged configuration the
 * analysis reads. A mapping's own globs are read wherever they point.
 */
const SKIPPED = [
  /(^|\/)\.git\//,
  /(^|\/)\.github\//,
  /(^|\/)\.o11y\//,
  /(^|\/)node_modules\//,
  /(^|\/)target\//,
  /(^|\/)build\//,
  /(^|\/)dist\//,
  /(^|\/)vendor\//,
  /(^|\/)src\/test\//,
  /(^|\/)src\/main\/resources\//,
  /^\.maestro\//,
];

/** The rule set as served, with the baseline of findings an environment's first checked build recorded. */
export interface ServedRules {
  ruleSet: RuleSet;
  casesDigest: string | null;
  baseline: string[] | null;
}

/** The check result a build carries; job-manager re-checks its digest and decides the build. */
export interface CheckResult {
  service: string;
  ruleSetDigest: string;
  total: number;
  findings: { rule: string; name: string; path: string; line: number }[];
}

export interface Verdict {
  outcome: 'passed' | 'warned' | 'failed';
  newFindings: number | null;
  reason: string | null;
}

/** One service's check as run: its outcome, the result a build carries (null when none ran), and why it failed. */
export interface CheckRun {
  outcome: 'passed' | 'warned' | 'failed' | 'off' | 'not-run';
  result: CheckResult | null;
  reason: string | null;
}

/** The repository as a check reads it: its tracked files (null outside a git checkout) and its mapping. */
export interface Repo {
  files: string[] | null;
  mapping: MappingEntry[] | null;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Text for the log with its control characters shown as `?`, so a value cannot start a workflow command. */
export function printable(text: string): string {
  return text.replace(CONTROLS, '?');
}

function enforcing(mode: string): boolean {
  return mode === 'FAIL' || mode === 'FAIL_ON_NEW';
}

export interface Scan {
  settings: SourcedSetting[];
  problems: Problem[];
  read: number;
  leftOut: number;
}

export interface MappingEntry {
  service: string;
  environment: string;
  paths: string[];
}

export function fingerprint(f: { rule: string; name: string; path: string }): string {
  return `${f.rule}|${f.name}|${f.path}`;
}

/** GET .../envs/{env}/ci-rules for one service, at the one version this Action reads. */
export async function fetchRules(
  api: MaestroApi,
  projectUid: string,
  environment: string,
  service: string,
  lockedVersionUid?: string,
): Promise<ServedRules> {
  const lock = lockedVersionUid ? `&lockedVersionUid=${encodeURIComponent(lockedVersionUid)}` : '';
  const res = await api.get<{ data?: Record<string, unknown> }>(
    `${envPath(projectUid, environment)}/ci-rules?service=${encodeURIComponent(service)}&versions=${VERSION}${lock}`,
  );
  if (res.statusCode === 404) {
    const code = (res.body as { data?: { code?: unknown } } | undefined)?.data?.code;
    if (code === 'ci_rules_service_unknown') {
      throw new UserError(
        `The locked analysis of "${printable(environment)}" holds no service named "${printable(service)}", so its log ` +
          'policy rules cannot be read. Use the name the environment lists it under.',
      );
    }
    if (code === 'ci_rules_lock_unknown') {
      throw new UserError(`Env "${printable(environment)}" holds no lock by the uid this run builds; run the workflow again.`);
    }
    throw new UserError(`Env "${printable(environment)}" was not found, so its log policy rules cannot be read.`);
  }
  expectOk(res, 'ci-rules');
  const data = res.body?.data;
  const why = unreadable(data);
  if (why) throw new UserError(`This Action cannot read the log policy rules: ${why}. Update the Maestro Action.`);
  const body = data as Record<string, unknown>;
  const baseline = Array.isArray(body.baseline) ? body.baseline.map(String) : null;
  const casesDigest = typeof body.casesDigest === 'string' ? body.casesDigest : null;
  return { ruleSet: body as unknown as RuleSet, casesDigest, baseline };
}

/** The repository's tracked files, `/`-separated and relative to its root. */
export function trackedFiles(root: string): string[] | null {
  try {
    // A repository's own config can name an fsmonitor command, which git would run; this read runs none.
    const out = execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', root, 'ls-files', '-z'], {
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // A path in a merge conflict is listed once per stage.
    return [...new Set(out.toString('utf8').split('\0').filter((p) => p !== ''))];
  } catch {
    return null;
  }
}

/** A repository path the platform accepts in a check result. */
export function sendablePath(p: string): boolean {
  if (p === '' || p.length > 400 || p.startsWith('/') || p.includes('\\')) return false;
  if (p.split('/').some((part) => part === '..' || part === '')) return false;
  return !/[\u0000-\u001f\u007f]/.test(p);
}

/**
 * The repository's `.maestro/check.yml`, or null when it has none. The file must be tracked, a regular file inside the
 * root and at most {@link MAPPING_MAX_BYTES}; a service, environment or path in it may not hold a control character.
 */
export function readMapping(root: string, tracked: string[]): MappingEntry[] | null {
  const file = path.join(root, MAPPING_FILE);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!tracked.includes(MAPPING_FILE)) {
    throw new UserError(`${MAPPING_FILE} is not tracked; commit it, since the check reads tracked files only.`);
  }
  if (!stat.isFile()) throw new UserError(`${MAPPING_FILE} is not a regular file.`);
  if (!fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep)) {
    throw new UserError(`${MAPPING_FILE} is not inside the repository.`);
  }
  if (stat.size > MAPPING_MAX_BYTES) throw new UserError(`${MAPPING_FILE} is larger than ${MAPPING_MAX_BYTES} bytes.`);
  let doc: unknown;
  try {
    doc = parseYaml(fs.readFileSync(file, 'utf8'), { logLevel: 'silent' });
  } catch {
    throw new UserError(`${MAPPING_FILE} is not valid YAML.`);
  }
  const services = (doc as { services?: unknown } | null)?.services;
  if (!Array.isArray(services) || services.length === 0) {
    throw new UserError(`${MAPPING_FILE} must list services, each with service, environment and paths.`);
  }
  return services.map((e, i) => {
    const entry = e as Partial<MappingEntry> | null;
    if (
      typeof entry?.service !== 'string' ||
      typeof entry.environment !== 'string' ||
      !Array.isArray(entry.paths) ||
      entry.paths.length === 0 ||
      !entry.paths.every((g) => typeof g === 'string')
    ) {
      throw new UserError(`${MAPPING_FILE}: entry ${i + 1} needs service, environment and a list of paths.`);
    }
    if ([entry.service, entry.environment, ...entry.paths].some((t) => CONTROL.test(t))) {
      throw new UserError(`${MAPPING_FILE}: entry ${i + 1} holds a control character.`);
    }
    return { service: entry.service, environment: entry.environment, paths: entry.paths };
  });
}

/** The repository's tracked files and its mapping. */
export function readRepo(root: string): Repo {
  const files = trackedFiles(root);
  return { files, mapping: files === null ? null : readMapping(root, files) };
}

/** The files the mapping assigns to one service and environment, or every file when there is no mapping. */
export function filesFor(files: string[], mapping: MappingEntry[] | null, service: string, environment: string): string[] {
  if (!mapping) return files;
  const globs = mapping.filter((e) => e.service === service && e.environment === environment).flatMap((e) => e.paths);
  return files.filter((f) => globs.some((g) => minimatch(f, g, { dot: true })));
}

/** Reads the deployment files among `files`: regular files only, inside the root, never a link. */
export function scan(root: string, files: string[], mapped = false): Scan {
  const result: Scan = { settings: [], problems: [], read: 0, leftOut: 0 };
  const realRoot = fs.realpathSync(root);
  let origins = 0;
  for (const rel of files) {
    const kind = kindOf(rel);
    if (!kind || NEVER_READ.test(rel) || (!mapped && SKIPPED.some((re) => re.test(rel)))) continue;
    if (!sendablePath(rel)) {
      result.leftOut++;
      continue;
    }
    const abs = path.join(root, rel);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const real = fs.realpathSync(abs);
    if (!real.startsWith(realRoot + path.sep)) continue;
    if (stat.size > FILE_MAX_BYTES) {
      result.problems.push({ path: rel, line: 1, reason: `larger than ${FILE_MAX_BYTES} bytes, not read` });
      continue;
    }
    const bytes = fs.readFileSync(abs);
    if (bytes.includes(0)) {
      result.problems.push({ path: rel, line: 1, reason: 'holds a NUL byte, not read' });
      continue;
    }
    const found = extract(rel, bytes.toString('utf8'), kind);
    result.read++;
    for (const s of found.settings) result.settings.push({ ...s, origin: origins + s.origin });
    origins += found.origins;
    result.problems.push(...found.problems);
  }
  return result;
}

/** The findings of a scan: for each source setting, one finding per rule, under the longest name it matched. */
export function findingsOf(set: RuleSet, settings: SourcedSetting[]): Finding[] {
  const byOrigin = new Map<number, SourcedSetting[]>();
  for (const s of settings) {
    const group = byOrigin.get(s.origin) ?? [];
    group.push(s);
    byOrigin.set(s.origin, group);
  }
  const out: Finding[] = [];
  for (const group of byOrigin.values()) {
    const ruled = new Set<string>();
    for (const f of evaluate(set, group)) {
      if (ruled.has(f.rule)) continue;
      ruled.add(f.rule);
      out.push(f);
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule));
}

export function checkResult(service: string, set: RuleSet, findings: Finding[]): CheckResult {
  return {
    service,
    ruleSetDigest: set.digest,
    total: findings.length,
    findings: findings.slice(0, FINDINGS_MAX).map((f) => ({ rule: f.rule, name: f.name, path: f.path, line: f.line })),
  };
}

/**
 * What the environment's mode makes of a check, as job-manager will decide it: FAIL fails an error-severity finding,
 * FAIL_ON_NEW one whose fingerprint its baseline does not hold, and either fails a check that lists fewer findings
 * than it counts. A warning is reported and never fails the step.
 */
export function verdict(mode: string, findings: Finding[], total: number, baseline: string[] | null): Verdict {
  if (total === 0) return { outcome: 'passed', newFindings: baseline ? 0 : null, reason: null };
  const listed = findings.slice(0, FINDINGS_MAX);
  const errors = listed.filter((f) => f.severity === 'error');
  const truncated = total > listed.length;
  if (mode === 'FAIL' && (errors.length > 0 || truncated)) {
    return { outcome: 'failed', newFindings: null, reason: 'the environment fails a build on an error-severity finding' };
  }
  if (mode === 'FAIL_ON_NEW' && baseline) {
    const known = new Set(baseline);
    const fresh = errors.filter((f) => !known.has(fingerprint(f))).length;
    if (fresh > 0 || truncated) {
      return {
        outcome: 'failed',
        newFindings: fresh + (truncated ? 1 : 0),
        reason: 'the environment is production and fails a build on error-severity findings new since its first checked build',
      };
    }
    return { outcome: 'warned', newFindings: 0, reason: null };
  }
  return { outcome: 'warned', newFindings: null, reason: null };
}

/** One log line per finding: its rule, the setting's name, and where. Never a value. */
export function report(findings: Finding[], problems: Problem[]): void {
  for (const f of findings) {
    const message = `${f.rule}: ${f.name}`;
    const where = { file: f.path, startLine: f.line, title: `Maestro log policy: ${f.rule}` };
    if (f.severity === 'error') core.error(message, where);
    else core.warning(message, where);
  }
  for (const p of problems) {
    core.warning(`Log policy check could not read ${p.path} line ${p.line}: ${p.reason}`, { file: p.path, startLine: p.line });
  }
}

/** Writes the job summary's table: rule, setting, file and line. */
async function summarize(title: string, findings: Finding[], line: string): Promise<void> {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try {
    const rows = findings.slice(0, 100).map((f) => [f.rule, f.severity, f.name, `${f.path}:${f.line}`]);
    const s = core.summary.addHeading(title, 3).addRaw(line, true);
    if (rows.length > 0) {
      s.addTable([
        [
          { data: 'Rule', header: true },
          { data: 'Severity', header: true },
          { data: 'Setting', header: true },
          { data: 'Where', header: true },
        ],
        ...rows,
      ]);
    }
    await s.write();
  } catch (e) {
    core.debug(`Job summary not written: ${(e as Error).message}`);
  }
}

export function casesDigestOfFile(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Runs the environment's log policy check over the repository's deployment files for one service, and reports its
 * findings. A failed check is returned, not thrown. With no git checkout the check cannot run: that fails where the
 * environment refuses a build with no check (`FAIL`), and in a check-only run in either enforcing mode. A mapping that
 * maps no file to the service and environment warns, and fails where the mode enforces.
 */
export async function runCheck(
  api: MaestroApi,
  projectUid: string,
  environment: string,
  service: string,
  root: string,
  repo: Repo,
  opts: { checkOnly: boolean; lockedVersionUid?: string },
): Promise<CheckRun> {
  const who = `${printable(service)} in ${printable(environment)}`;
  const served = await fetchRules(api, projectUid, environment, service, opts.lockedVersionUid);
  const mode = served.ruleSet.mode;
  if (mode === 'OFF') {
    core.info(`Log policy check: off for ${printable(environment)}.`);
    return { outcome: 'off', result: null, reason: null };
  }
  if (served.casesDigest && CASES_DIGEST && served.casesDigest !== CASES_DIGEST) {
    core.warning(
      'This Action was tested against another copy of the log policy rules than the platform holds. Update the Maestro Action.',
    );
  }
  if (repo.files === null) {
    const refused = mode === 'FAIL' || (opts.checkOnly && enforcing(mode));
    const why = 'the workspace is not a git checkout, and the check reads tracked files only';
    if (refused) {
      return {
        outcome: 'failed',
        result: null,
        reason: `${why}; the environment's mode ${mode} needs the check, so check out the repository before this step`,
      };
    }
    core.warning(`Log policy check not run for ${who}: ${why}.`);
    return { outcome: 'not-run', result: null, reason: null };
  }
  let mine = repo.files;
  if (repo.mapping) {
    const entries = repo.mapping.filter((e) => e.service === service && e.environment === environment);
    const empty = entries.length === 0
      ? `${MAPPING_FILE} maps no files to ${who}`
      : entries
          .map((e, i) => (filesFor(repo.files ?? [], [e], service, environment).length === 0 ? i + 1 : 0))
          .filter((n) => n > 0)
          .map((n) => `${MAPPING_FILE} entry ${n} for ${who} matches no tracked file`)
          .join('; ');
    if (empty) {
      if (enforcing(mode)) return { outcome: 'failed', result: null, reason: empty };
      core.warning(`Log policy check: ${empty}.`);
    }
    mine = filesFor(repo.files, entries, service, environment);
  }
  const read = scan(root, mine, repo.mapping !== null);
  const findings = findingsOf(served.ruleSet, read.settings);
  const result = checkResult(service, served.ruleSet, findings);
  const decided = verdict(mode, findings, result.total, served.baseline);
  report(findings, read.problems);
  const errors = findings.filter((f) => f.severity === 'error').length;
  const scope = repo.mapping ? ` (the files ${MAPPING_FILE} maps to ${who})` : '';
  const line =
    `Log policy check for ${who}: ${read.read} deployment file(s) read${scope}, ` +
    `${result.total} finding(s), ${errors} error(s); mode ${mode}` +
    (decided.newFindings !== null ? `, ${decided.newFindings} new since the first checked build` : '') +
    (served.baseline === null && mode === 'FAIL_ON_NEW' ? ', no baseline yet: this build records it' : '') +
    (read.leftOut > 0 ? `; ${read.leftOut} file(s) left out for their path` : '') +
    '.';
  core.info(line);
  await summarize(`Maestro log policy: ${who}`, findings, line);
  return { outcome: decided.outcome, result, reason: decided.reason ? `${decided.reason}. Each finding above names its rule, file and line` : null };
}

/**
 * The check a build runs before its upload: returns the result the build carries, or null when none ran, and throws
 * when the environment's mode fails the build, before anything is uploaded.
 */
export async function logPolicyCheck(
  api: MaestroApi,
  projectUid: string,
  environment: string,
  service: string,
  root: string,
  lockedVersionUid?: string,
): Promise<CheckResult | null> {
  const run = await runCheck(api, projectUid, environment, service, root, readRepo(root), {
    checkOnly: false,
    lockedVersionUid,
  });
  core.setOutput('log-policy-check', run.outcome);
  core.setOutput('log-policy-findings', String(run.result?.total ?? 0));
  if (run.outcome === 'failed') {
    throw new UserError(`Log policy check failed for ${printable(service)} in ${printable(environment)}: ${run.reason}.`);
  }
  return run.result;
}
