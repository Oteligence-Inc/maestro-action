import * as core from '@actions/core';
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Minimatch } from 'minimatch';
import { parseAllDocuments } from 'yaml';
import { MaestroApi, expectOk } from '../api';
import { CASES_DIGEST, Finding, RuleSet, VERSION, evaluate, unreadable } from '../ciRules';
import { AotNote, aotNotes } from '../logPolicy/aot';
import { Problem, SourcedSetting, decode, extract, kindOf, trimSpace, withoutYamlVersion } from '../logPolicy/extract';
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
  aot: AotNote[];
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
        `The locked analysis of "${printable(environment)}" holds no single service named "${printable(service)}" ` +
          '(none, or two sharing it), so its log policy rules cannot be read. Use the service key or the name the ' +
          'environment lists it under.',
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
    // Parsed silently, so no line of the file reaches the log; any error, a duplicate key included, refuses it.
    // One document, as the CLI reads it, under the same schema whatever version it declares.
    const parsed = parseAllDocuments(withoutYamlVersion(fs.readFileSync(file, 'utf8')), { logLevel: 'silent' });
    const docs = Array.isArray(parsed) ? parsed : [parsed];
    if (docs.length !== 1 || docs[0].errors.length > 0) throw new Error('not valid YAML');
    doc = docs[0].toJS();
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
      trimSpace(entry.service) === '' ||
      typeof entry.environment !== 'string' ||
      trimSpace(entry.environment) === '' ||
      !Array.isArray(entry.paths) ||
      entry.paths.length === 0 ||
      !entry.paths.every((g) => typeof g === 'string' && g !== '')
    ) {
      throw new UserError(`${MAPPING_FILE}: entry ${i + 1} needs service, environment and a list of paths.`);
    }
    if ([entry.service, entry.environment, ...entry.paths].some((t) => CONTROL.test(t))) {
      throw new UserError(`${MAPPING_FILE}: entry ${i + 1} holds a control character.`);
    }
    const unsupported = entry.paths.map(globRefusal).find((r) => r !== null);
    if (unsupported) throw new UserError(`${MAPPING_FILE}: entry ${i + 1}: ${unsupported}.`);
    return { service: entry.service, environment: entry.environment, paths: entry.paths };
  });
}

/**
 * Why a mapping path is refused, or null: the glob syntax both the Action and the CLI read the same way is `*`, `?`,
 * `**` as a whole segment, `[...]` and `{a,b}` of literal alternatives. A negation, an extglob, an escape, a brace
 * holding a wildcard, a range or no comma, and `**` inside a segment are refused rather than read two ways.
 */
export function globRefusal(glob: string): string | null {
  if (glob.startsWith('!')) return `a path may not start with ! (list the paths to check instead)`;
  if (/[@!+?*]\(/.test(glob)) return 'a path may not use an extglob such as @(a|b)';
  if (glob.includes('\\')) return 'a path may not use a backslash escape';
  if (glob.includes('(') || glob.includes(')')) return 'a path may not hold ( or )';
  if (glob.includes('${')) return 'a path may not hold ${';
  if (glob.split('/').some((seg) => seg.includes('**') && seg !== '**')) return '** must be a whole path segment';
  // One left-to-right pass over the braces and the classes, so a mapping of unclosed braces costs linear time.
  let patterns = 1;
  let open = -1;
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === '{') {
      if (open >= 0) return 'a {...} must list literal alternatives separated by commas';
      open = i;
    } else if (glob[i] === '}') {
      if (open < 0) return 'a path has an unbalanced brace';
      const body = glob.substring(open + 1, i);
      if (!body.includes(',') || body.includes('..') || /[*?[{]/.test(body)) {
        return 'a {...} must list literal alternatives separated by commas';
      }
      patterns *= body.split(',').length;
      if (patterns > GLOB_PATTERNS_MAX) return `a path's braces may make at most ${GLOB_PATTERNS_MAX} patterns`;
      open = -1;
    }
  }
  if (open >= 0) return 'a path has an unbalanced brace';
  for (let i = glob.indexOf('['); i >= 0; ) {
    const end = glob.indexOf(']', i + 1);
    if (end < 0) break;
    const body = glob.substring(i + 1, end);
    if (body.includes('/') || rangeOverSlash(body)) return 'a [...] may not hold or span /';
    if (body.includes('[:') || /^[!^]?$/.test(body)) return 'a [...] must list characters or ranges';
    i = glob.indexOf('[', end + 1);
  }
  return null;
}

/** What a mapping path's braces may expand to: minimatch builds every pattern for every file it tests. */
export const GLOB_PATTERNS_MAX = 64;

/** A range such as `+-0` whose ends lie either side of `/`, which minimatch never matches and the CLI's regex would. */
function rangeOverSlash(body: string): boolean {
  for (let i = 1; i + 1 < body.length; i++) {
    if (body[i] === '-' && body[i - 1] <= '/' && body[i + 1] >= '/') return true;
  }
  return false;
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
  // Each glob is compiled once, not once per file.
  const matchers = globs.map((g) => new Minimatch(g, { dot: true }));
  return files.filter((f) => matchers.some((m) => m.match(f)));
}

/** Reads the deployment files among `files`: regular files only, inside the root, never a link. */
export function scan(root: string, files: string[], mapped = false): Scan {
  const result: Scan = { settings: [], problems: [], aot: [], read: 0, leftOut: 0 };
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
    const { text, problem } = decode(bytes, kind);
    if (problem) result.problems.push({ path: rel, line: 1, reason: problem });
    if (text === null) continue;
    result.aot.push(...aotNotes(rel, text));
    const found = extract(rel, text, kind);
    result.read++;
    for (const s of found.settings) result.settings.push({ ...s, origin: origins + s.origin });
    origins += found.origins;
    result.problems.push(...found.problems);
  }
  return result;
}

/**
 * The findings of a scan: for each source setting, one finding per rule, under the longest name it matched; a finding
 * two sources give (a YAML anchor read where it stands and through an alias) is given once.
 */
export function findingsOf(set: RuleSet, settings: SourcedSetting[]): Finding[] {
  const byOrigin = new Map<number, SourcedSetting[]>();
  for (const s of settings) {
    const group = byOrigin.get(s.origin) ?? [];
    group.push(s);
    byOrigin.set(s.origin, group);
  }
  const out: Finding[] = [];
  const given = new Set<string>();
  for (const group of byOrigin.values()) {
    const ruled = new Set<string>();
    for (const f of evaluate(set, group)) {
      const key = `${f.rule}|${f.name}|${f.path}|${f.line}`;
      if (ruled.has(f.rule) || given.has(key)) continue;
      ruled.add(f.rule);
      given.add(key);
      out.push(f);
    }
  }
  // UTF-16 code-unit order, as the CLI and job-manager compare strings: the first FINDINGS_MAX the two send are the same.
  const order = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return out.sort((a, b) => order(a.path, b.path) || a.line - b.line || order(a.rule, b.rule) || order(a.name, b.name));
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

/** One log line per finding: its rule, the setting's name, and where; and a notice per AOT cache line. Never a value. */
export function report(findings: Finding[], problems: Problem[], aot: AotNote[] = []): void {
  for (const f of findings) {
    const message = `${f.rule}: ${f.name}`;
    const where = { file: f.path, startLine: f.line, title: `Maestro log policy: ${f.rule}` };
    if (f.severity === 'error') core.error(message, where);
    else core.warning(message, where);
  }
  for (const p of problems) {
    core.warning(`Log policy check could not read ${p.path} line ${p.line}: ${p.reason}`, { file: p.path, startLine: p.line });
  }
  for (const n of aot) {
    core.notice(`AOT cache: ${n.flags.join(' ')}. Train the cache with the -javaagent flags it runs with: one trained without the agent is rejected when the agent is attached.`, {
      file: n.path,
      startLine: n.line,
      title: 'Maestro: JDK AOT cache',
    });
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
    // The AOT cache notes are not log policy findings, so an environment that turns the check off still gets them.
    if (repo.files !== null) report([], [], scan(root, repo.files, false).aot);
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
  report(findings, read.problems, read.aot);
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
