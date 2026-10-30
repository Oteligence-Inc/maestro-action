import { isUtf8 } from 'buffer';
import { LineCounter, isAlias, isCollection, isMap, isScalar, isSeq, parseAllDocuments, visit as visitYaml } from 'yaml';
import type { Alias, Document, Node, Pair } from 'yaml';
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
  /** The YAML nodes read through aliases, counted against ALIAS_NODES_MAX. */
  aliasNodes: number;
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
/** The most YAML nodes one file's aliases expand to; past it the file is named and the rest of its aliases not read. */
export const ALIAS_NODES_MAX = 10000;
/** Example env files, which a deployment never reads. */
const ENV_EXAMPLES = /(^|\.)env\.(example|sample|template)$/;
/** Sequence keys whose items are a container's command line. */
const COMMAND_KEYS = new Set(['args', 'command', 'entrypoint', 'cmd']);

/**
 * The whitespace a deployment file's text is trimmed and split at: Go's unicode.IsSpace, as compose reads an env file
 * and the CLI reads every file. A command line is split at ASCII whitespace only, as the JVM and a shell split it.
 */
const SPACE = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const IS_SPACE = new RegExp(`^[${SPACE}]$`);
const SPACE_AT = new RegExp(`[${SPACE}]`);

function isSpace(c: string): boolean {
  return IS_SPACE.test(c);
}

/** `s` without the whitespace at either end, as Go's strings.TrimSpace gives it. */
export function trimSpace(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isSpace(s[start])) start++;
  while (end > start && isSpace(s[end - 1])) end--;
  return s.substring(start, end);
}

function trimSpaceStart(s: string): string {
  let start = 0;
  while (start < s.length && isSpace(s[start])) start++;
  return s.substring(start);
}

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

/**
 * A file's text as its deployment reads it, and the problem to name: a .properties file as ISO-8859-1, as Java reads
 * one; any other kind as UTF-8; a Dockerfile or env file that is not valid UTF-8 as ISO-8859-1, named, since BuildKit
 * and compose still apply its settings; a YAML file that is not valid UTF-8 not at all, as the YAML readers refuse it.
 */
export function decode(bytes: Buffer, kind: FileKind): { text: string | null; problem: string | null } {
  if (kind === 'properties') return { text: bytes.toString('latin1'), problem: null };
  if (isUtf8(bytes)) return { text: bytes.toString('utf8'), problem: null };
  if (kind === 'yaml') return { text: null, problem: 'not valid UTF-8, not read' };
  return { text: bytes.toString('latin1'), problem: 'not valid UTF-8, read as ISO-8859-1' };
}

/** A file's lines as the tools that read it split them: at CRLF, a lone CR or LF, and nowhere else. */
export function lines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

const ENV_LINE = new RegExp(`^[${SPACE}]*(?:export[${SPACE}]+)?([A-Za-z_][A-Za-z0-9_.-]*)[${SPACE}]*=(.*)$`, 's');

/** The settings a deployment file holds, from its text as `decode` gives it. */
export function extract(path: string, raw: string, kind: FileKind): Extracted {
  const out: Extracted = { settings: [], problems: [], origins: 0, aliasNodes: 0 };
  const text = raw.charCodeAt(0) === 0xfeff ? raw.substring(1) : raw;
  const same = (line: number) => line;
  switch (kind) {
    case 'yaml':
      yamlSettings(path, text, out, same, false);
      break;
    case 'dockerfile':
      dockerfileSettings(path, text, out);
      break;
    case 'env':
      for (const { line, key, value } of keyValueLines(text, ENV_LINE)) {
        add(out, path, line, key, envValue(value));
      }
      break;
    case 'properties':
      propertiesSettings(path, text, out, same);
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

/** Records a problem the file has not recorded already. */
function once(out: Extracted, path: string, line: number, reason: string): void {
  if (!out.problems.some((p) => p.reason === reason)) out.problems.push({ path, line, reason });
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
  const re = /"[^"]*"|'[^']*'|[^\t\n\v\f\r "']+(?:"[^"]*"|'[^']*'|[^\t\n\v\f\r "']*)*/g;
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
  if (trimSpace(value) === '') return;
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
      const before = trimSpace(text.substring(lineStart, i));
      alone = (before === '' || before === '-') && trimSpace(text.substring(j + 2, lineEnd)) === '';
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

const TEMPLATE_VALUE = new RegExp(`:[${SPACE}]*\\{\\{`);

/**
 * A line of template actions and nothing else, such as `{{- if .Values.x }}`, `- {{ include "x" . }}` or
 * `{{- end }} {{- end }}`, unless it holds a key whose value is an action.
 */
function wholeLineAction(line: string): boolean {
  let t = trimSpace(line);
  if (t.startsWith('-')) t = trimSpaceStart(t.substring(1));
  return t.length >= 4 && t.startsWith('{{') && t.endsWith('}}') && !TEMPLATE_VALUE.test(line);
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
    const t = trimSpace(l);
    if (t !== '' && t !== '---' && !t.startsWith('#') && !t.startsWith('%')) content = true;
  });
  if (cur.length > 0) out.push({ part: cur.join('\n'), start });
  return out;
}

const DOCUMENT_MARKER = /^(?:---|\.\.\.)(?:[ \t]|$)/;

/** The columns a line's content starts at: its indentation and any `- ` that opens a sequence item on it. */
function contentColumn(line: string): number {
  const m = /^[ ]*(?:-[ ]+)*/.exec(line);
  return m ? m[0].length : 0;
}

function indentOf(line: string): number {
  return /^[ ]*/.exec(line)?.[0].length ?? 0;
}

/** The offset of the quote that closes the quoted scalar opening at `start`, or -1. */
function quoteEnd(text: string, start: number): number {
  const q = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (q === '"' && text[i] === '\\') i++;
    else if (text[i] === q) {
      if (q === "'" && text[i + 1] === "'") i++;
      else return i;
    }
  }
  return -1;
}

/** Whether a quote at `i` inside a flow collection opens a scalar: it follows `[`, `{`, `,`, `:`, `?` or nothing. */
function opensScalar(text: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j--;
  return j < 0 || '[{,:?'.includes(text[j]);
}

/** The offset of the character that closes the flow collection or quoted scalar opening at `start`, or -1. */
function closing(text: string, start: number): number {
  if (text[start] === '"' || text[start] === "'") return quoteEnd(text, start);
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      if (--depth === 0) return i;
    } else if ((c === '"' || c === "'") && opensScalar(text, i)) {
      i = quoteEnd(text, i);
      if (i < 0) return -1;
    } else if (c === '#' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t' || text[i - 1] === '\n')) {
      i = text.indexOf('\n', i);
      if (i < 0) return -1;
    }
  }
  return -1;
}

/**
 * In a part that does not parse, the first flow collection or quoted scalar the parser ended before its closing
 * character, which it does when the construct continues on lines indented no deeper than its key: every deployment
 * reader (libyaml, go-yaml, SnakeYAML) reads those, ignoring indentation there. Indents each such line past its key and
 * says whether one changed; indenting changes no value, since a continuation line's leading space is not content. A
 * line that is a document marker is left, as yaml.v3 refuses it there.
 */
function reindent(docs: Document.Parsed[], lines: string[], counter: LineCounter): boolean {
  if (!docs.some((d) => d.errors.length > 0)) return false;
  const text = lines.join('\n');
  let open = -1;
  let end = -1;
  for (const doc of docs) {
    visitYaml(doc, (_key, node, path) => {
      const range = (node as Node | null)?.range;
      if (!range || (open >= 0 && range[0] >= open)) return;
      const quoted = isScalar(node) && (node.type === 'QUOTE_DOUBLE' || node.type === 'QUOTE_SINGLE');
      const flow = isCollection(node) && node.flow && !path.some((a) => isCollection(a) && a.flow);
      if (!quoted && !flow) return;
      const close = closing(text, range[0]);
      if (close > range[1] - 1) {
        open = range[0];
        end = close;
      }
    });
  }
  if (open < 0) return false;
  const first = counter.linePos(open).line - 1;
  const last = counter.linePos(end).line - 1;
  const indent = contentColumn(lines[first]) + 1;
  let changed = false;
  for (let line = first + 1; line <= last; line++) {
    if (/^[ \t]*$/.test(lines[line]) || indentOf(lines[line]) >= indent) continue;
    if (DOCUMENT_MARKER.test(lines[line])) return false;
    lines[line] = ' '.repeat(indent - indentOf(lines[line])) + lines[line];
    changed = true;
  }
  return changed;
}

/**
 * A document part parsed, each flow collection or quoted scalar the parser refuses for its indentation alone indented
 * until it reads it: one reparse per such collection.
 */
function parsed(part: string): { docs: Document.Parsed[]; counter: LineCounter } {
  const lines = withoutYamlVersion(part).split('\n');
  for (;;) {
    const counter = new LineCounter();
    const all = parseAllDocuments(lines.join('\n'), { lineCounter: counter, uniqueKeys: false });
    const docs = Array.isArray(all) ? all : [all as unknown as Document.Parsed];
    if (!reindent(docs, lines, counter)) return { docs, counter };
  }
}

/** An anchor name yaml.v3 reads; it refuses a document that uses another. */
const ANCHOR_NAME = /^[0-9A-Za-z_-]+$/;

/**
 * Each alias of a document and the node it names: the latest anchor of its name before it, as yaml.v3 resolves it.
 * Null when an alias names no anchor before it, or an anchor or alias has a name yaml.v3 refuses: the document is then
 * not valid YAML, as yaml.v3 and the Kubernetes reader find it.
 */
function aliasTargets(doc: Document.Parsed): Map<Alias, Node> | null {
  const anchors = new Map<string, Node>();
  const targets = new Map<Alias, Node>();
  let valid = true;
  visitYaml(doc, (_key, node) => {
    if (!node) return;
    if (isAlias(node)) {
      const target = anchors.get(node.source);
      if (!target) valid = false;
      else targets.set(node, target);
    } else if (isScalar(node) || isCollection(node)) {
      const anchor = (node as { anchor?: string }).anchor;
      if (anchor !== undefined) {
        if (!ANCHOR_NAME.test(anchor)) valid = false;
        anchors.set(anchor, node as Node);
      }
    }
  });
  return valid ? targets : null;
}

/**
 * Reads a YAML stream, each line placed at the file line `lineAt` gives it. An embedded stream (a file a ConfigMap or
 * Secret carries) is not searched for further embedded files.
 */
function yamlSettings(path: string, text: string, out: Extracted, lineAt: (line: number) => number, embedded: boolean): void {
  const joined = lines(text).join('\n');
  const source = joined.includes('{{') ? untemplated(joined) : joined;
  for (const { part, start } of documents(source)) {
    const { docs, counter } = parsed(part);
    for (const [n, doc] of docs.entries()) {
      // yaml.v3 refuses a document after `...` that does not open with `---`.
      const aliases = doc.errors.length > 0 || (n > 0 && !doc.directives?.docStart) ? null : aliasTargets(doc);
      if (!aliases) {
        // Named at the part's first line, as the CLI names it, and the rest of the part (documents after a `...`) is not
        // read, since yaml.v3 stops there: the two parsers place an error on different lines.
        out.problems.push({ path, line: lineAt(start + 1), reason: 'not valid YAML' });
        break;
      }
      const at = (node: Node | null | undefined): number => {
        const pos = node?.range?.[0];
        return lineAt(start + (pos === undefined ? 1 : counter.linePos(pos).line));
      };
      const contents = doc.contents as Node | null;
      if (!contents) continue;
      walkYaml({ path, out, at, aliases, embedded, secret: isSecret(contents) }, contents, [], 0, 0);
    }
  }
}

/** Whether a document is a Kubernetes Secret, whose data values are base64. */
function isSecret(root: Node): boolean {
  return isMap(root) && (root.items as Pair[]).some((p) => scalarText(p.key) === 'kind' && scalarText(p.value) === 'Secret');
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

/** One YAML document being read. */
interface Walk {
  path: string;
  out: Extracted;
  at: (node: Node | null | undefined) => number;
  aliases: Map<Alias, Node>;
  embedded: boolean;
  secret: boolean;
}

/**
 * A node read through the alias it may be, or null once the file's aliases have expanded past ALIAS_NODES_MAX.
 * `aliasLine` is the line of the outermost alias being expanded, 0 outside any; every node read inside one counts.
 */
function visit(w: Walk, node: Node | null | undefined, aliasLine: number): [Node | null, number] {
  const n: Node | null = node ?? null;
  if (n && isAlias(n) && aliasLine === 0) aliasLine = w.at(n);
  if (aliasLine !== 0 && ++w.out.aliasNodes > ALIAS_NODES_MAX) {
    once(w.out, w.path, aliasLine, `aliases expand past ${ALIAS_NODES_MAX} nodes, the rest not read`);
    return [null, aliasLine];
  }
  return [n && isAlias(n) ? w.aliases.get(n) ?? null : n, aliasLine];
}

/** One entry of a mapping as a deployment reads it: `written`, the node as written (an alias keeps its own line). */
interface Entry {
  key: string;
  written: Node | null;
  value: Node | null;
  aliasLine: number;
}

/** A `<<` key yaml.v3 merges: a plain untagged one, or one tagged `!!merge` (read by the parser as a symbol). */
function isMergeKey(node: unknown): boolean {
  if (!isScalar(node)) return false;
  if (node.tag === 'tag:yaml.org,2002:merge') return true;
  return node.type === 'PLAIN' && node.tag === undefined && node.value === '<<';
}

/**
 * A mapping's entries with its merge keys applied: its own first, then each merged mapping's in turn, a key already
 * given taking precedence, as YAML's merge key reads them. Merges nest at most DEPTH_MAX deep, so a mapping that merges
 * itself is named rather than read for ever.
 */
function entries(w: Walk, map: Node, aliasLine: number, depth = 0): Entry[] {
  if (depth > DEPTH_MAX) {
    once(w.out, w.path, w.at(map), `nested deeper than ${DEPTH_MAX} levels, not read below`);
    return [];
  }
  const out: Entry[] = [];
  const seen = new Set<string>();
  const merges: (Node | null)[] = [];
  for (const pair of (map as unknown as { items: Pair[] }).items) {
    if (isMergeKey(pair.key)) {
      merges.push(pair.value as Node | null);
      continue;
    }
    const key = scalarText(pair.key);
    if (key === null) continue;
    const [value, al] = visit(w, pair.value as Node | null, aliasLine);
    seen.add(key);
    out.push({ key, written: pair.value as Node | null, value, aliasLine: al });
  }
  for (const m of merges) {
    const [src, al] = visit(w, m, aliasLine);
    if (!src) continue;
    const sources: [Node | null, number][] = isSeq(src) ? (src.items as Node[]).map((item) => visit(w, item, al)) : [[src, al]];
    for (const [s, sal] of sources) {
      if (!s || !isMap(s)) continue;
      for (const e of entries(w, s, sal, depth + 1)) {
        if (seen.has(e.key)) continue;
        seen.add(e.key);
        out.push(e);
      }
    }
  }
  return out;
}

/** The kind of file a data or stringData key names, or null. */
function embeddedKind(key: string): FileKind | null {
  const k = key.toLowerCase();
  if (k.endsWith('.yaml') || k.endsWith('.yml')) return 'yaml';
  if (k.endsWith('.properties')) return 'properties';
  return null;
}

/** The bytes a Kubernetes Secret's data value holds, or null when it is not base64; like Kubernetes, it ignores CR and LF. */
function base64Bytes(text: string): Buffer | null {
  const t = text.replace(/[\r\n]/g, '');
  if (t.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(t)) return null;
  return Buffer.from(t, 'base64');
}

/**
 * Reads a file a ConfigMap's or Secret's value carries, from the bytes a mounted copy holds: a literal block's lines at
 * their own lines, any other value's settings at its line.
 */
function readEmbedded(w: Walk, kind: FileKind, written: Node | null, text: string, encoded: boolean): void {
  const at = w.at(written);
  const bytes = encoded ? base64Bytes(text) : Buffer.from(text, 'utf8');
  if (!bytes) return;
  const { text: body, problem } = decode(bytes, kind);
  if (body === null) {
    w.out.problems.push({ path: w.path, line: at, reason: problem ?? 'not read' });
    return;
  }
  const literal = !encoded && isScalar(written) && written.type === 'BLOCK_LITERAL';
  const lineAt = literal ? (k: number) => at + k : () => at;
  if (kind === 'properties') propertiesSettings(w.path, body, w.out, lineAt);
  else yamlSettings(w.path, body.charCodeAt(0) === 0xfeff ? body.substring(1) : body, w.out, lineAt, true);
}

function walkYaml(w: Walk, node: Node, keys: string[], depth: number, aliasLine: number): void {
  const { path, out } = w;
  if (depth > DEPTH_MAX) {
    once(out, path, w.at(node), `nested deeper than ${DEPTH_MAX} levels, not read below`);
    return;
  }
  if (isMap(node)) {
    const list = entries(w, node, aliasLine);
    envEntry(w, list);
    const parent = keys.length > 0 ? keys[keys.length - 1].toLowerCase() : '';
    for (const { key, written, value, aliasLine: al } of list) {
      if (!value) continue;
      const lower = key.toLowerCase();
      const text = scalarText(value);
      if (text !== null) {
        const line = w.at(written);
        // A Secret's data values are base64; one that is not, or does not decode to text, sets nothing.
        const encoded = parent === 'data' && w.secret;
        const bytes = encoded ? base64Bytes(text) : null;
        const setting = !encoded ? text : bytes && isUtf8(bytes) ? bytes.toString('utf8') : null;
        if (setting !== null) {
          add(out, path, line, keyPathNames([...keys, key]), setting);
          if (COMMAND_KEYS.has(lower)) commandLine(setting, path, line, out);
        }
        const kind = embeddedKind(key);
        if (kind && !w.embedded && (parent === 'data' || parent === 'stringdata')) {
          readEmbedded(w, kind, written, text, encoded);
        }
      } else if (isSeq(value) && COMMAND_KEYS.has(lower)) {
        for (const item of value.items as Node[]) {
          const t = scalarText(visit(w, item, al)[0]);
          if (t !== null) commandElement(t, path, w.at(item), out);
        }
      } else if (isSeq(value) && lower === 'environment') {
        for (const item of value.items as Node[]) {
          const [it, ial] = visit(w, item, al);
          if (!it) continue;
          const t = scalarText(it);
          const eq = t === null ? -1 : t.indexOf('=');
          if (t !== null && eq > 0) add(out, path, w.at(item), t.substring(0, eq), t.substring(eq + 1));
          else walkYaml(w, it, [...keys, key], depth + 1, ial);
        }
      } else {
        walkYaml(w, value, [...keys, key], depth + 1, al);
      }
    }
  } else if (isSeq(node)) {
    for (const item of node.items as Node[]) {
      const [it, al] = visit(w, item, aliasLine);
      if (it) walkYaml(w, it, keys, depth + 1, al);
    }
  }
}

/** A Kubernetes env entry ({name, value}) as the setting it names. */
function envEntry(w: Walk, list: Entry[]): void {
  let name: string | null = null;
  let written: Node | null = null;
  let value: Node | null = null;
  for (const e of list) {
    if (e.key === 'name') name = scalarText(e.value);
    if (e.key === 'value') {
      written = e.written;
      value = e.value;
    }
  }
  const text = scalarText(value);
  if (name && text !== null) add(w.out, w.path, w.at(written), name, text);
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

const DOCKER_INSTRUCTION = new RegExp(`^[${SPACE}]*(ENV|CMD|ENTRYPOINT)[${SPACE}](.*)$`, 'is');
/** A parser directive line, which only the lines before a Dockerfile's first other line can be. */
const DOCKER_DIRECTIVE = /^#[ \t]*([A-Za-z][A-Za-z0-9]*)[ \t]*=[ \t]*(.*?)[ \t]*$/;
/** The parser directives BuildKit knows; a line naming another is a comment, which ends them. */
const DOCKER_DIRECTIVES = new Set(['syntax', 'escape', 'check']);

/** The character a Dockerfile continues a line with: a backslash, or the one its escape directive names. */
function dockerEscape(physical: string[]): string {
  let escape = '\\';
  for (const l of physical) {
    const m = DOCKER_DIRECTIVE.exec(l);
    if (!m || !DOCKER_DIRECTIVES.has(m[1].toLowerCase())) break;
    if (m[1].toLowerCase() === 'escape' && (m[2] === '`' || m[2] === '\\')) escape = m[2];
  }
  return escape;
}

function dockerfileSettings(path: string, text: string, out: Extracted): void {
  const physical = lines(text);
  const escape = dockerEscape(physical);
  for (let i = 0; i < physical.length; i++) {
    const start = i + 1;
    const parts = [physical[i]];
    while (i + 1 < physical.length) {
      const last = parts[parts.length - 1].replace(/[ \t]+$/, '');
      if (!last.endsWith(escape)) break;
      parts[parts.length - 1] = last.substring(0, last.length - 1) + ' ';
      parts.push(physical[++i]);
    }
    const m = DOCKER_INSTRUCTION.exec(parts.join(''));
    if (!m) continue;
    const instruction = m[1].toUpperCase();
    const rest = trimSpace(m[2]);
    if (instruction === 'ENV') {
      if (/^[A-Za-z_][A-Za-z0-9_.-]*=/.test(rest)) {
        for (const t of tokens(rest)) {
          const eq = t.indexOf('=');
          if (eq > 0) add(out, path, start, t.substring(0, eq), unquote(t.substring(eq + 1)));
        }
      } else {
        const sp = rest.search(SPACE_AT);
        if (sp > 0) add(out, path, start, rest.substring(0, sp), unquote(trimSpace(rest.substring(sp))));
      }
    } else if (rest.startsWith('[')) {
      // An exec form is a JSON array of strings; Docker runs anything else in a shell, which no JVM starts from.
      let elements: unknown;
      try {
        elements = JSON.parse(rest);
      } catch {
        elements = null;
      }
      if (!Array.isArray(elements) || !elements.every((e) => typeof e === 'string')) {
        out.problems.push({ path, line: start, reason: `${instruction} is not a JSON array of strings` });
        continue;
      }
      for (const e of elements as string[]) commandElement(e, path, start, out);
    } else {
      commandLine(rest, path, start, out);
    }
  }
}

function keyValueLines(text: string, re: RegExp): { line: number; key: string; value: string }[] {
  const out: { line: number; key: string; value: string }[] = [];
  lines(text).forEach((l, i) => {
    if (trimSpace(l).startsWith('#')) return;
    const m = re.exec(l);
    if (m) out.push({ line: i + 1, key: m[1], value: trimSpace(m[2]) });
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
const PROPERTY_ESCAPES: Record<string, string> = { t: '\t', n: '\n', r: '\r', f: '\f' };

/** Thrown for a `\u` escape without four hex digits, which java.util.Properties refuses. */
export class MalformedEscape extends Error {}

/**
 * `s` with java.util.Properties' escapes read: `\uXXXX`, `\t`, `\n`, `\r` and `\f`, and a backslash before any other
 * character as that character.
 */
function unescape(s: string): string {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') {
      out += s[i];
      continue;
    }
    if (++i === s.length) break;
    const c = s[i];
    if (c === 'u') {
      const hex = s.substring(i + 1, i + 5);
      if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw new MalformedEscape();
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else {
      out += PROPERTY_ESCAPES[c] ?? c;
    }
  }
  return out;
}

/**
 * One logical properties line as java.util.Properties reads it: the key ends at the first unescaped `=`, `:` or
 * space, one `=` or `:` after the spaces that follow it is part of the separator, and the escapes in both are read.
 * Throws {@link MalformedEscape} for a malformed `\u` escape.
 */
export function property(logical: string): { key: string; value: string } {
  let i = 0;
  while (i < logical.length && PROPERTY_SPACE.has(logical[i])) i++;
  const keyStart = i;
  for (; i < logical.length; i++) {
    const c = logical[i];
    if (c === '\\' && i + 1 < logical.length) {
      i++;
      continue;
    }
    if (c === '=' || c === ':' || PROPERTY_SPACE.has(c)) break;
  }
  const key = logical.substring(keyStart, i);
  while (i < logical.length && PROPERTY_SPACE.has(logical[i])) i++;
  if (i < logical.length && (logical[i] === '=' || logical[i] === ':')) {
    i++;
    while (i < logical.length && PROPERTY_SPACE.has(logical[i])) i++;
  }
  return { key: unescape(key), value: unescape(logical.substring(i)) };
}

function propertiesSettings(path: string, text: string, out: Extracted, lineAt: (line: number) => number): void {
  const physical = lines(text);
  for (let i = 0; i < physical.length; i++) {
    const start = i + 1;
    if (/^[ \t\f]*(?:[#!]|$)/.test(physical[i])) continue;
    const parts = [physical[i]];
    while (continues(parts[parts.length - 1]) && i + 1 < physical.length) {
      parts[parts.length - 1] = parts[parts.length - 1].slice(0, -1);
      parts.push(physical[++i].replace(/^[ \t\f]+/, ''));
    }
    let read: { key: string; value: string };
    try {
      read = property(parts.join(''));
    } catch (e) {
      if (!(e instanceof MalformedEscape)) throw e;
      out.problems.push({ path, line: lineAt(start), reason: 'a malformed \\uxxxx escape, line not read' });
      continue;
    }
    if (read.key !== '') add(out, path, lineAt(start), read.key, read.value);
  }
}

const ENV_COMMENT = new RegExp(`[${SPACE}]#`);

/**
 * An env file value as compose reads it: a quoted value up to its closing quote, an unquoted one up to a comment that a
 * space and # start.
 */
export function envValue(raw: string): string {
  const t = trimSpace(raw);
  const q = t[0];
  if (q === '"' || q === "'") {
    const close = t.indexOf(q, 1);
    return close > 0 ? t.substring(1, close) : t;
  }
  const comment = t.search(ENV_COMMENT);
  return trimSpace(comment >= 0 ? t.substring(0, comment) : t);
}

function unquote(v: string): string {
  const t = trimSpace(v);
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.substring(1, t.length - 1);
  }
  return t;
}
