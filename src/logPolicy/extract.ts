import { LineCounter, isMap, isPair, isScalar, isSeq, parseAllDocuments } from 'yaml';
import type { Node, Pair } from 'yaml';
import { Setting, fold } from '../ciRules';

/** A file the check could not read in full: its path and line, never its content. */
export interface Problem {
  path: string;
  line: number;
  reason: string;
}

/** A setting with the source it came from: the names one YAML key is read as share one origin. */
export interface SourcedSetting extends Setting {
  origin: number;
}

export interface Extracted {
  settings: SourcedSetting[];
  problems: Problem[];
  origins: number;
}

export type FileKind = 'yaml' | 'dockerfile' | 'env' | 'properties';


/** Environment variables whose value is a JVM command line; `_JAVA_OPTIONS` folds to `java.options`. */
const JVM_OPTIONS = new Set(['java.tool.options', 'java.opts', 'jdk.java.options', 'java.options']);
/** Mapping keys whose children are environment variables, read under their own names. */
const ENV_KEYS = new Set(['environment', 'env', 'data', 'stringdata']);
/** The most settings one file gives; past it the file is named and the rest not read. */
export const SETTINGS_MAX = 20000;
/** The deepest YAML nesting read; a deeper node is named and not read. */
export const DEPTH_MAX = 64;
/** Example env files, which a deployment never reads. */
const ENV_EXAMPLES = /(^|\.)env\.(example|sample|template)$/;
/** Sequence keys whose items are a container's command line. */
const COMMAND_KEYS = new Set(['args', 'command', 'entrypoint', 'cmd']);

/** The kind of deployment file a repository path is, or null for a file the check does not read. */
export function kindOf(path: string): FileKind | null {
  const base = path.split('/').pop() ?? '';
  const lower = base.toLowerCase();
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'yaml';
  if (lower === 'dockerfile' || lower === 'containerfile' || lower.endsWith('.dockerfile') || lower.startsWith('dockerfile.')) {
    return 'dockerfile';
  }
  if (ENV_EXAMPLES.test(lower)) return null;
  if (lower === '.env' || lower.endsWith('.env') || lower.startsWith('.env.')) return 'env';
  if (lower.endsWith('.properties')) return 'properties';
  return null;
}

/** A file's lines as the tools that read it split them: at CRLF, a lone CR or LF, and nowhere else. */
export function lines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

export function extract(path: string, raw: string, kind: FileKind): Extracted {
  const out: Extracted = { settings: [], problems: [], origins: 0 };
  const text = raw.charCodeAt(0) === 0xfeff ? raw.substring(1) : raw;
  switch (kind) {
    case 'yaml':
      yamlSettings(path, text, out);
      break;
    case 'dockerfile':
      dockerfileSettings(path, text, out);
      break;
    case 'env':
      for (const { line, key, value } of keyValueLines(text, /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/s)) {
        add(out, path, line, key, envValue(value));
      }
      break;
    case 'properties':
      for (const { line, key, value } of propertiesLines(text)) add(out, path, line, key, value);
      break;
  }
  return out;
}

/**
 * Adds one setting read under one or more names (one origin), and what its value holds when a name says it is a
 * command line or Spring's JSON.
 */
function add(out: Extracted, path: string, line: number, names: string | string[], value: string): void {
  if (out.settings.length >= SETTINGS_MAX) {
    if (!out.problems.some((p) => p.reason.startsWith('more than'))) {
      out.problems.push({ path, line, reason: `more than ${SETTINGS_MAX} settings, the rest not read` });
    }
    return;
  }
  const origin = out.origins++;
  let expanded = false;
  for (const name of Array.isArray(names) ? names : [names]) {
    const folded = fold(name);
    if (folded) out.settings.push({ name: folded, value, path, line, origin });
    if (expanded) continue;
    if (JVM_OPTIONS.has(folded)) {
      expanded = true;
      for (const s of commandLineSettings(value)) add(out, path, line, s.name, s.value);
    } else if (folded === 'spring.application.json') {
      expanded = true;
      springJson(out, path, line, value);
    }
  }
}

/** The settings a command line passes: {@code -Dk=v}, {@code -Dk}, {@code --k=v} and {@code --k}. */
export function commandLineSettings(commandLine: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const raw of tokens(commandLine)) {
    const token = unquote(raw);
    let body: string | null = null;
    if (token.startsWith('-D') && token.length > 2) body = token.substring(2);
    else if (token.startsWith('--') && token.length > 2) body = token.substring(2);
    if (body === null) continue;
    const eq = body.indexOf('=');
    out.push(eq < 0 ? { name: body, value: '' } : { name: body.substring(0, eq), value: unquote(body.substring(eq + 1)) });
  }
  return out;
}

/** The setting one argument of an exec-form command passes, read whole: an element is one argument, spaces and all. */
export function argumentSetting(arg: string): { name: string; value: string } | null {
  let body: string | null = null;
  if (arg.startsWith('-D') && arg.length > 2) body = arg.substring(2);
  else if (arg.startsWith('--') && arg.length > 2) body = arg.substring(2);
  if (body === null) return null;
  const eq = body.indexOf('=');
  return eq < 0 ? { name: body, value: '' } : { name: body.substring(0, eq), value: body.substring(eq + 1) };
}

/** One element of an exec-form command: an argument when it starts with `-`, else a command line (`sh -c "..."`). */
function commandElement(element: string, path: string, line: number, out: Extracted): void {
  if (element.startsWith('-')) {
    const s = argumentSetting(element);
    if (s) add(out, path, line, s.name, s.value);
  } else {
    commandLine(element, path, line, out);
  }
}

function tokens(commandLine: string): string[] {
  const out: string[] = [];
  const re = /"[^"]*"|'[^']*'|[^\s"']+(?:"[^"]*"|'[^']*'|[^\s"']*)*/g;
  for (const m of commandLine.matchAll(re)) out.push(m[0]);
  return out;
}

/** Spring's JSON with each placeholder read as a template value, quoted where it stands bare. */
function springJsonParsed(value: string): unknown {
  const marked = replaceTemplates(value, { dollar: true }, () => '__TEMPLATE__');
  try {
    return JSON.parse(marked);
  } catch {
    return JSON.parse(replaceTemplates(value, { dollar: true, strings: true }, () => '"__TEMPLATE__"')
      .replace(/"[^"]*"/g, (m) => replaceTemplates(m, { dollar: true }, () => '__TEMPLATE__')));
  }
}

function springJson(out: Extracted, path: string, line: number, value: string): void {
  if (value.trim() === '') return;
  let parsed: unknown;
  try {
    parsed = springJsonParsed(value);
  } catch {
    out.problems.push({ path, line, reason: 'SPRING_APPLICATION_JSON is not JSON' });
    return;
  }
  const walk = (node: unknown, prefix: string): void => {
    if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, prefix ? `${prefix}.${k}` : k);
    } else if (prefix) {
      add(out, path, line, prefix, node === null ? '' : String(node));
    }
  };
  walk(parsed, '');
}

/** A Helm template's actions removed, so the YAML around them parses; a value written as a template reads as one. */
export function untemplated(text: string): string {
  const lined = blankMultiLineActions(text)
    .split('\n')
    .map((l) => (wholeLineAction(l) ? '' : l))
    .join('\n');
  return replaceTemplates(lined, {}, (m) => '__TEMPLATE__' + '\n'.repeat(m.split('\n').length - 1));
}

/**
 * `text` with each `{{...}}` (and, with `dollar`, each `${...}`) replaced by `sub`, read as the regular expression
 * `"[^"]*"|\$\{[^}]*\}|\{\{[^}]*\}\}` reads it (the string alternative only with `strings`, and a string kept as it
 * is), in one pass: the next `}` and `"` are each found once, so a file of unclosed braces costs linear time.
 */
export function replaceTemplates(
  text: string,
  opts: { dollar?: boolean; strings?: boolean },
  sub: (m: string) => string,
): string {
  let close = -2;
  let quote = -2;
  const next = (cached: number, ch: string, from: number) => (cached !== -1 && cached < from ? text.indexOf(ch, from) : cached);
  let out = '';
  let last = 0;
  for (let p = 0; p < text.length; ) {
    const c = text[p];
    if (opts.strings && c === '"') {
      quote = next(quote, '"', p + 1);
      if (quote >= 0) {
        p = quote + 1;
        continue;
      }
    }
    let end = -1;
    if (opts.dollar && c === '$' && text[p + 1] === '{') {
      close = next(close, '}', p + 2);
      if (close >= 0) end = close + 1;
    }
    if (end < 0 && c === '{' && text[p + 1] === '{') {
      close = next(close, '}', p + 2);
      if (close >= 0 && text[close + 1] === '}') end = close + 2;
    }
    if (end >= 0) {
      out += text.substring(last, p) + sub(text.substring(p, end));
      last = p = end;
    } else {
      p++;
    }
  }
  return out + text.substring(last);
}

/**
 * The text with each action that spans lines and stands alone on them (a `{{/* ... *\/}}` header, a long `{{- if }}`)
 * blanked, its line count kept; one sharing its lines with YAML is left for the line pass.
 */
function blankMultiLineActions(text: string): string {
  let out = '';
  let from = 0;
  for (let i = text.indexOf('{{'); i >= 0; i = text.indexOf('{{', from)) {
    const j = text.indexOf('}}', i + 2);
    if (j < 0) break;
    const action = text.substring(i, j + 2);
    // The line bounds are found only for an action that spans lines, so the scan stays linear.
    let alone = false;
    let lineStart = 0;
    let lineEnd = 0;
    if (action.includes('\n')) {
      lineStart = text.lastIndexOf('\n', i - 1) + 1;
      lineEnd = text.indexOf('\n', j + 2);
      if (lineEnd < 0) lineEnd = text.length;
      const before = text.substring(lineStart, i).trim();
      alone = (before === '' || before === '-') && text.substring(j + 2, lineEnd).trim() === '';
    }
    if (alone) {
      out += text.substring(from, lineStart) + '\n'.repeat(action.split('\n').length - 1);
      from = lineEnd;
    } else {
      out += text.substring(from, j + 2);
      from = j + 2;
    }
  }
  return out + text.substring(from);
}

/**
 * A line of template actions and nothing else, such as `{{- if .Values.x }}`, `- {{ include "x" . }}` or
 * `{{- end }} {{- end }}`, unless it holds a key whose value is an action.
 */
function wholeLineAction(line: string): boolean {
  let t = line.trim();
  if (t.startsWith('-')) t = t.substring(1).trimStart();
  return t.length >= 4 && t.startsWith('{{') && t.endsWith('}}') && !/:\s*\{\{/.test(line);
}

/**
 * A YAML stream split at its document markers, each part with the line it starts on, so a document that does not parse
 * costs only itself. A part of directives and comments alone stays with the document after it.
 */
export function documents(text: string): { part: string; start: number }[] {
  const out: { part: string; start: number }[] = [];
  let cur: string[] = [];
  let start = 0;
  let content = false;
  text.split('\n').forEach((l, i) => {
    if ((l === '---' || l.startsWith('--- ') || l.startsWith('---\t')) && content) {
      out.push({ part: cur.join('\n'), start });
      cur = [];
      start = i;
      content = false;
    }
    cur.push(l);
    const t = l.trim();
    if (t !== '' && t !== '---' && !t.startsWith('#') && !t.startsWith('%')) content = true;
  });
  if (cur.length > 0) out.push({ part: cur.join('\n'), start });
  return out;
}

function yamlSettings(path: string, text: string, out: Extracted): void {
  const joined = lines(text).join('\n');
  const source = joined.includes('{{') ? untemplated(joined) : joined;
  for (const { part, start } of documents(source)) {
    const counter = new LineCounter();
    const docs = parseAllDocuments(withoutYamlVersion(part), { lineCounter: counter, uniqueKeys: false });
    const list = Array.isArray(docs) ? docs : [docs];
    const lineOf = (node: Node | null | undefined): number => {
      const at = node?.range?.[0];
      return start + (at === undefined ? 1 : counter.linePos(at).line);
    };
    for (const doc of list) {
      if (doc.errors.length > 0) {
        // Named at the document's first line, as the CLI names it: the two parsers place an error on different lines.
        out.problems.push({ path, line: start + 1, reason: 'not valid YAML' });
        continue;
      }
      walkYaml(doc.contents as Node | null, [], path, out, lineOf, 0);
    }
  }
}

/**
 * `text` with each `%YAML` directive line blanked: both interpreters then read every file under one schema, YAML 1.2
 * with the 1.1 boolean words, whatever version a file declares and wherever the line stands.
 */
export function withoutYamlVersion(text: string): string {
  return text.replace(/^%YAML[ \t][^\n]*$/gm, '');
}

/** A plain word SnakeYAML and the Kubernetes YAML reader take as a YAML 1.1 boolean, where YAML 1.2 reads a string. */
const YAML11_BOOLEAN = /^(?:yes|Yes|YES|on|On|ON|no|No|NO|off|Off|OFF)$/;

function boolText(source: string): string {
  const t = source.toLowerCase();
  if (t === 'yes' || t === 'on') return 'true';
  if (t === 'no' || t === 'off') return 'false';
  return t;
}

function scalarText(node: unknown): string | null {
  if (!isScalar(node)) return null;
  const v = node.value;
  if (v === null || v === undefined) return '';
  const untagged = node.tag === undefined || node.tag === '!';
  if (typeof v === 'string' && node.type === 'PLAIN' && untagged && YAML11_BOOLEAN.test(v)) return /^(?:yes|on)$/i.test(v) ? 'true' : 'false';
  // An explicit !!bool is read from its text, as the CLI reads it: the words of YAML 1.1 as booleans, any other as written.
  if (node.tag === 'tag:yaml.org,2002:bool' && typeof node.source === 'string') return boolText(node.source);
  return typeof v === 'object' ? null : String(v);
}

function walkYaml(
  node: Node | null,
  keys: string[],
  path: string,
  out: Extracted,
  lineOf: (n: Node | null | undefined) => number,
  depth: number,
): void {
  if (depth > DEPTH_MAX) {
    if (!out.problems.some((p) => p.reason.startsWith('nested deeper'))) {
      out.problems.push({ path, line: lineOf(node), reason: `nested deeper than ${DEPTH_MAX} levels, not read below` });
    }
    return;
  }
  if (isMap(node)) {
    envEntry(node.items as Pair[], path, out, lineOf);
    for (const pair of node.items as Pair[]) {
      if (!isPair(pair)) continue;
      const key = scalarText(pair.key);
      if (key === null) continue;
      const value = pair.value as Node | null;
      const text = scalarText(value);
      if (text !== null) {
        add(out, path, lineOf(value ?? (pair.key as Node)), keyPathNames([...keys, key]), text);
        if (COMMAND_KEYS.has(key.toLowerCase())) commandLine(text, path, lineOf(value), out);
      } else if (isSeq(value) && COMMAND_KEYS.has(key.toLowerCase())) {
        for (const item of value.items as Node[]) {
          const t = scalarText(item);
          if (t !== null) commandElement(t, path, lineOf(item), out);
        }
      } else if (isSeq(value) && key.toLowerCase() === 'environment') {
        for (const item of value.items as Node[]) {
          const t = scalarText(item);
          const eq = t === null ? -1 : t.indexOf('=');
          if (t !== null && eq > 0) add(out, path, lineOf(item), t.substring(0, eq), t.substring(eq + 1));
          else walkYaml(item, [...keys, key], path, out, lineOf, depth + 1);
        }
      } else {
        walkYaml(value, [...keys, key], path, out, lineOf, depth + 1);
      }
    }
  } else if (isSeq(node)) {
    for (const item of node.items as Node[]) walkYaml(item, keys, path, out, lineOf, depth + 1);
  }
}

/** A Kubernetes env entry ({name, value}) as the setting it names. */
function envEntry(items: Pair[], path: string, out: Extracted, lineOf: (n: Node | null | undefined) => number): void {
  let name: string | null = null;
  let valueNode: Node | null = null;
  let hasValue = false;
  for (const pair of items) {
    if (!isPair(pair)) continue;
    const k = scalarText(pair.key);
    if (k === 'name') name = scalarText(pair.value);
    if (k === 'value') {
      hasValue = scalarText(pair.value) !== null;
      valueNode = pair.value as Node;
    }
  }
  if (name && hasValue) add(out, path, lineOf(valueNode), name, scalarText(valueNode) ?? '');
}

/**
 * The names a nested key path is read as: the whole path, and each tail of it that folds to at least two segments,
 * so a level written under a chart's own key ({@code config.logging.level.root}) or as an environment variable in a
 * ConfigMap ({@code data.LOGGING_LEVEL_ROOT}) is read, while a lone {@code debug} under another tool's key is not.
 */
export function keyPathNames(keys: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const name = keys.slice(i).join('.');
    const envChild = i === keys.length - 1 && i > 0 && ENV_KEYS.has(keys[i - 1].toLowerCase());
    if (i === 0 || envChild || fold(name).split('.').filter((s) => s !== '').length >= 2) out.push(name);
  }
  return out;
}

function commandLine(text: string, path: string, line: number, out: Extracted): void {
  for (const s of commandLineSettings(text)) add(out, path, line, s.name, s.value);
}

function dockerfileSettings(path: string, text: string, out: Extracted): void {
  const physical = lines(text);
  for (let i = 0; i < physical.length; i++) {
    const start = i + 1;
    const parts = [physical[i]];
    while (parts[parts.length - 1].trimEnd().endsWith('\\') && i + 1 < physical.length) {
      const last = parts[parts.length - 1].trimEnd();
      parts[parts.length - 1] = last.substring(0, last.length - 1) + ' ';
      parts.push(physical[++i]);
    }
    const logical = parts.join('');
    const m = /^\s*(ENV|CMD|ENTRYPOINT)\s(.*)$/is.exec(logical);
    if (!m) continue;
    const instruction = m[1].toUpperCase();
    const rest = m[2].trim();
    if (instruction === 'ENV') {
      if (/^[A-Za-z_][A-Za-z0-9_.-]*=/.test(rest)) {
        for (const t of tokens(rest)) {
          const eq = t.indexOf('=');
          if (eq > 0) add(out, path, start, t.substring(0, eq), unquote(t.substring(eq + 1)));
        }
      } else {
        const sp = rest.search(/\s/);
        if (sp > 0) add(out, path, start, rest.substring(0, sp), unquote(rest.substring(sp + 1).trim()));
      }
    } else if (rest.startsWith('[')) {
      let elements: unknown;
      try {
        elements = JSON.parse(rest);
      } catch {
        elements = null;
      }
      if (!Array.isArray(elements)) {
        out.problems.push({ path, line: start, reason: `${instruction} is not a JSON array` });
        continue;
      }
      for (const e of elements) commandElement(String(e), path, start, out);
    } else {
      commandLine(rest, path, start, out);
    }
  }
}

function keyValueLines(text: string, re: RegExp): { line: number; key: string; value: string }[] {
  const out: { line: number; key: string; value: string }[] = [];
  lines(text).forEach((l, i) => {
    if (/^\s*#/.test(l)) return;
    const m = re.exec(l);
    if (m) out.push({ line: i + 1, key: m[1], value: m[2].trim() });
  });
  return out;
}

/** True when a properties line ends in an odd run of backslashes, which continues it on the next line. */
function continues(line: string): boolean {
  let n = 0;
  for (let i = line.length - 1; i >= 0 && line[i] === '\\'; i--) n++;
  return n % 2 === 1;
}

const PROPERTY_SPACE = new Set([' ', '\t', '\f']);

/**
 * One logical properties line as java.util.Properties reads it: the key ends at the first unescaped `=`, `:` or
 * space, and one `=` or `:` after the spaces that follow it is part of the separator.
 */
export function property(logical: string): { key: string; value: string } {
  let i = 0;
  while (i < logical.length && PROPERTY_SPACE.has(logical[i])) i++;
  let key = '';
  for (; i < logical.length; i++) {
    const c = logical[i];
    if (c === '\\' && i + 1 < logical.length) {
      key += logical[++i];
      continue;
    }
    if (c === '=' || c === ':' || PROPERTY_SPACE.has(c)) break;
    key += c;
  }
  while (i < logical.length && PROPERTY_SPACE.has(logical[i])) i++;
  if (i < logical.length && (logical[i] === '=' || logical[i] === ':')) {
    i++;
    while (i < logical.length && PROPERTY_SPACE.has(logical[i])) i++;
  }
  return { key, value: logical.substring(i).trim() };
}

function propertiesLines(text: string): { line: number; key: string; value: string }[] {
  const out: { line: number; key: string; value: string }[] = [];
  const physical = lines(text);
  for (let i = 0; i < physical.length; i++) {
    const start = i + 1;
    if (/^[ \t\f]*[#!]/.test(physical[i]) || physical[i].trim() === '') continue;
    const parts = [physical[i]];
    while (continues(parts[parts.length - 1]) && i + 1 < physical.length) {
      parts[parts.length - 1] = parts[parts.length - 1].slice(0, -1);
      parts.push(physical[++i].replace(/^[ \t\f]+/, ''));
    }
    const { key, value } = property(parts.join(''));
    if (key !== '') out.push({ line: start, key, value });
  }
  return out;
}

/**
 * An env file value as compose reads it: a quoted value up to its closing quote, an unquoted one up to a comment that a
 * space and # start.
 */
export function envValue(raw: string): string {
  const t = raw.trim();
  const q = t[0];
  if (q === '"' || q === "'") {
    const close = t.indexOf(q, 1);
    return close > 0 ? t.substring(1, close) : t;
  }
  const comment = t.search(/\s#/);
  return (comment >= 0 ? t.substring(0, comment) : t).trim();
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.substring(1, t.length - 1);
  }
  return t;
}
