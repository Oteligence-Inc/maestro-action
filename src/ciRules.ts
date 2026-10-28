// The CI rule set the platform serves for an environment's service, and its evaluation. This is the TypeScript copy of
// discrete-job-functions' djf-core CiRules.evaluate; the shared fixture suite (tests/fixtures/ci-rules) holds the two
// to the same answers, and CASES_DIGEST pins which copy of that suite this release was tested against.

/** The rule-set version this Action reads. */
export const VERSION = 1;

/** The SHA-256 of the evaluation fixture suite this release was tested against; the server serves its own. */
export const CASES_DIGEST = 'b2b18f1ba97efadc13c76c13eda51fb550aef35be24be5eeab53a865a31804ae';

/** Every test a version 1 rule may name; a rule naming another fails loudly. */
export const TESTS = [
  'any',
  'otel_true',
  'otel_false',
  'spring_set',
  'below_floor',
  'not_exporter',
  'exposes_loggers',
  'profile_below_floor',
] as const;

export interface Rule {
  id: string;
  severity: string;
  exact: string[];
  prefixes: string[];
  suffixes: string[];
  except: string[];
  test: string;
  values: string[];
  since: number;
}

export interface RuleSet {
  version: number;
  mode: string;
  floor: string;
  exporter: string | null;
  lockFree: boolean;
  rules: Rule[];
  digest: string;
}

/** One setting read from a deployment file, as it was written. */
export interface Setting {
  name: string;
  value: string;
  path: string;
  line: number;
}

export interface Finding {
  rule: string;
  severity: string;
  name: string;
  path: string;
  line: number;
}

const LEVELS = ['ALL', 'TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL', 'OFF'];

/** The shape of a folded name a finding carries; job-manager lists no other. */
export const NAME = /^[a-z0-9._-]{1,200}$/;

/**
 * A folded name as a finding carries it: a character outside NAME reads as _, which folding never leaves, and a name
 * past 200 characters is cut. A setting on such a name is still judged.
 */
export function findingName(folded: string): string {
  return folded.replace(/[^a-z0-9._-]/g, '_').substring(0, 200);
}

/** A template placeholder anywhere, or a value written as $VAR or @name@: it passes no test but any. */
const PLACEHOLDER = /^(?:[\s\S]*(?:\$\{|\$\(|#\{|\{\{|__TEMPLATE__)[\s\S]*|\$[A-Za-z_][\s\S]*|@[A-Za-z0-9_.-]+@)$/;

/** Java's String.trim: spaces and control characters at either end, and nothing else. */
export function trimAscii(v: string): string {
  let start = 0;
  let end = v.length;
  while (start < end && v.charCodeAt(start) <= 0x20) start++;
  while (end > start && v.charCodeAt(end - 1) <= 0x20) end--;
  return v.substring(start, end);
}

/** A setting name folded as every interpreter folds it; an interpreter strips a -D prefix before folding. */
export function fold(name: string | null | undefined): string {
  if (name === null || name === undefined) return '';
  let n = trimAscii(name).toLowerCase().replace(/_/g, '.').replace(/-/g, '.');
  while (n.startsWith('.')) n = n.substring(1);
  return n;
}

export function evaluate(set: RuleSet, settings: Setting[]): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const s of settings) {
    const name = fold(s.name);
    if (!name) continue;
    const shown = findingName(name);
    for (const r of set.rules) {
      if (!matches(r, name) || !passesTest(r, s.value, set)) continue;
      const key = `${r.id}|${shown}|${s.path}|${s.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ rule: r.id, severity: r.severity, name: shown, path: s.path, line: s.line });
    }
  }
  return out;
}

export function matches(r: Rule, name: string): boolean {
  if (r.except.includes(name)) return false;
  if (r.exact.includes(name)) return true;
  if (r.prefixes.some((p) => name.startsWith(p))) return true;
  return r.suffixes.some((x) => name.endsWith(x));
}

export function passesTest(r: Rule, raw: string | null | undefined, set: RuleSet): boolean {
  const v = raw === null || raw === undefined ? '' : trimAscii(raw);
  if (!(TESTS as readonly string[]).includes(r.test)) throw new Error(`unknown test ${r.test}`);
  if (r.test === 'any') return true;
  // A list test reads its elements whatever else the list holds: a placeholder element names nothing it looks for.
  if (r.test === 'exposes_loggers') return v.split(',').some((p) => trimAscii(p) === 'loggers' || trimAscii(p) === '*');
  if (r.test === 'profile_below_floor') return v.split(',').some((p) => r.values.includes(trimAscii(p)));
  if (PLACEHOLDER.test(v)) return false;
  switch (r.test) {
    case 'otel_true':
      return v.toLowerCase() === 'true';
    case 'otel_false':
      return v !== '' && v.toLowerCase() !== 'true';
    case 'spring_set':
      return v !== 'false';
    case 'below_floor':
      return isLevel(v) && below(v.toUpperCase(), set.floor);
    case 'not_exporter':
      return v !== '' && v.toLowerCase() !== 'none' && set.exporter !== null && v.toLowerCase() !== set.exporter.toLowerCase();
    default:
      throw new Error(`unknown test ${r.test}`);
  }
}

function isLevel(v: string): boolean {
  const u = v.toUpperCase();
  return LEVELS.includes(u === 'WARNING' ? 'WARN' : u);
}

function below(level: string, floor: string): boolean {
  const l = level === 'WARNING' ? 'WARN' : level;
  const i = LEVELS.indexOf(l);
  return i >= 0 && i < LEVELS.indexOf(floor);
}

const MODES = ['OFF', 'WARN', 'FAIL', 'FAIL_ON_NEW'];
const FLOORS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'];
const SEVERITIES = ['error', 'warning'];
/** A rule id as the platform names one; any other is refused rather than printed. */
const RULE_ID = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The reason a served rule set cannot be read by this Action, or null when it can. */
export function unreadable(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return 'the rule set is empty';
  const set = body as Partial<RuleSet>;
  if (set.version !== VERSION) {
    return `the platform serves rule-set version ${String(set.version)} and this Action reads version ${VERSION}`;
  }
  if (typeof set.mode !== 'string' || typeof set.floor !== 'string' || typeof set.digest !== 'string') {
    return 'the rule set has no mode, floor or digest';
  }
  if (!MODES.includes(set.mode)) return 'the rule set names a mode this Action does not know';
  if (!FLOORS.includes(set.floor)) return 'the rule set names a floor this Action does not know';
  if (!/^[0-9a-f]{64}$/.test(set.digest)) return 'the rule set digest is out of shape';
  if (set.exporter !== null && set.exporter !== undefined && typeof set.exporter !== 'string') {
    return 'the rule set exporter is out of shape';
  }
  if (!Array.isArray(set.rules)) return 'the rule set has no rules';
  for (const r of set.rules) {
    if (typeof r?.id !== 'string' || !RULE_ID.test(r.id)) return 'a rule id is out of shape';
    if (!(TESTS as readonly string[]).includes(r?.test)) {
      return `rule ${r.id} uses a test this Action does not know`;
    }
    if (!SEVERITIES.includes(r.severity)) return `rule ${r.id} names a severity this Action does not know`;
    for (const list of [r.exact, r.prefixes, r.suffixes, r.except, r.values]) {
      if (!Array.isArray(list)) return `rule ${String(r.id)} is out of shape`;
    }
  }
  return null;
}
