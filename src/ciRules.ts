// The CI rule set the platform serves for an environment's service, and its evaluation. This is the TypeScript copy of
// discrete-job-functions' djf-core CiRules.evaluate; the shared fixture suite (tests/fixtures/ci-rules) holds the two
// to the same answers, and CASES_DIGEST pins which copy of that suite this release was tested against.

/** The rule-set version this Action reads. */
export const VERSION = 1;

/** The SHA-256 of the evaluation fixture suite this release was tested against; the server serves its own. */
export const CASES_DIGEST = '9c0845b43f3c3fecf2dc78b75bbc189b358da5aedbbe78b3048acfef912e5ea7';

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

/** The shape of a folded name a finding may carry; job-manager lists no other. */
export const NAME = /^[a-z0-9._-]{1,200}$/;

const PLACEHOLDER = /^(?:[\s\S]*(?:\$\{|\{\{|__TEMPLATE__)[\s\S]*|\$[A-Za-z_][\s\S]*)$/;

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
    for (const r of set.rules) {
      if (!matches(r, name) || !passesTest(r, s.value, set)) continue;
      const key = `${r.id}|${name}|${s.path}|${s.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ rule: r.id, severity: r.severity, name, path: s.path, line: s.line });
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
    case 'exposes_loggers':
      return v.split(',').some((part) => trimAscii(part) === 'loggers' || trimAscii(part) === '*');
    case 'profile_below_floor':
      return v.split(',').some((part) => r.values.includes(trimAscii(part)));
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
  if (!Array.isArray(set.rules)) return 'the rule set has no rules';
  for (const r of set.rules) {
    if (!(TESTS as readonly string[]).includes(r?.test)) {
      return `rule ${String(r?.id)} uses a test this Action does not know (${String(r?.test)})`;
    }
    for (const list of [r.exact, r.prefixes, r.suffixes, r.except, r.values]) {
      if (!Array.isArray(list)) return `rule ${String(r.id)} is out of shape`;
    }
  }
  return null;
}
