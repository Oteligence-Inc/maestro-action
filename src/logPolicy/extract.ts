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


/** Environment variables whose value is a JVM command line. */
const JVM_OPTIONS = new Set(['java.tool.options', 'java.opts', 'jdk.java.options']);
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
  if (lower === '.env' || lower.endsWith('.env') || lower.startsWith('.env.')) return 'env';
  if (lower.endsWith('.properties')) return 'properties';
  return null;
}

export function extract(path: string, text: string, kind: FileKind): Extracted {
  const out: Extracted = { settings: [], problems: [], origins: 0 };
  switch (kind) {
    case 'yaml':
      yamlSettings(path, text, out);
      break;
    case 'dockerfile':
      dockerfileSettings(path, text, out);
      break;
    case 'env':
      for (const { line, key, value } of keyValueLines(text, /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/)) {
        add(out, path, line, key, unquote(value));
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

function tokens(commandLine: string): string[] {
  const out: string[] = [];
  const re = /"[^"]*"|'[^']*'|[^\s"']+(?:"[^"]*"|'[^']*'|[^\s"']*)*/g;
  for (const m of commandLine.matchAll(re)) out.push(m[0]);
  return out;
}

function springJson(out: Extracted, path: string, line: number, value: string): void {
  if (value.trim() === '' || value.includes('${') || value.includes('{{')) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
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
  return text
    .split('\n')
    .map((l) => (/^\s*(?:-\s*)?\{\{.*\}\}\s*$/.test(l) && !/:\s*\{\{/.test(l) ? '' : l))
    .join('\n')
    .replace(/\{\{[^}]*\}\}/g, '__TEMPLATE__');
}

function yamlSettings(path: string, text: string, out: Extracted): void {
  const source = text.includes('{{') ? untemplated(text) : text;
  const lines = new LineCounter();
  const docs = parseAllDocuments(source, { lineCounter: lines, uniqueKeys: false });
  const list = Array.isArray(docs) ? docs : [docs];
  const lineOf = (node: Node | null | undefined): number => {
    const start = node?.range?.[0];
    return start === undefined ? 1 : lines.linePos(start).line;
  };
  for (const doc of list) {
    if (doc.errors.length > 0) {
      const at = doc.errors[0].linePos?.[0]?.line ?? 1;
      out.problems.push({ path, line: at, reason: 'not valid YAML' });
      continue;
    }
    walkYaml(doc.contents as Node | null, [], path, out, lineOf);
  }
}

function scalarText(node: unknown): string | null {
  if (!isScalar(node)) return null;
  const v = node.value;
  if (v === null || v === undefined) return '';
  return typeof v === 'object' ? null : String(v);
}

function walkYaml(node: Node | null, keys: string[], path: string, out: Extracted, lineOf: (n: Node | null | undefined) => number): void {
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
          if (t !== null) commandLine(t, path, lineOf(item), out);
        }
      } else if (isSeq(value) && key.toLowerCase() === 'environment') {
        for (const item of value.items as Node[]) {
          const t = scalarText(item);
          const eq = t === null ? -1 : t.indexOf('=');
          if (t !== null && eq > 0) add(out, path, lineOf(item), t.substring(0, eq), t.substring(eq + 1));
          else walkYaml(item, [...keys, key], path, out, lineOf);
        }
      } else {
        walkYaml(value, [...keys, key], path, out, lineOf);
      }
    }
  } else if (isSeq(node)) {
    for (const item of node.items as Node[]) walkYaml(item, keys, path, out, lineOf);
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
    if (i === 0 || fold(name).split('.').filter((s) => s !== '').length >= 2) out.push(name);
  }
  return out;
}

function commandLine(text: string, path: string, line: number, out: Extracted): void {
  for (const s of commandLineSettings(text)) add(out, path, line, s.name, s.value);
}

function dockerfileSettings(path: string, text: string, out: Extracted): void {
  const physical = text.split('\n');
  for (let i = 0; i < physical.length; i++) {
    const start = i + 1;
    let logical = physical[i];
    while (/\\\s*$/.test(logical) && i + 1 < physical.length) {
      logical = logical.replace(/\\\s*$/, ' ') + physical[++i];
    }
    const m = /^\s*(ENV|CMD|ENTRYPOINT)\s+(.*)$/i.exec(logical);
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
    } else {
      let line = rest;
      if (rest.startsWith('[')) {
        try {
          const parts = JSON.parse(rest);
          if (Array.isArray(parts)) line = parts.map((p) => `'${String(p).replace(/'/g, '')}'`).join(' ');
        } catch {
          out.problems.push({ path, line: start, reason: `${instruction} is not a JSON array` });
          continue;
        }
      }
      commandLine(line, path, start, out);
    }
  }
}

function keyValueLines(text: string, re: RegExp): { line: number; key: string; value: string }[] {
  const out: { line: number; key: string; value: string }[] = [];
  text.split('\n').forEach((l, i) => {
    if (/^\s*#/.test(l)) return;
    const m = re.exec(l.replace(/\r$/, ''));
    if (m) out.push({ line: i + 1, key: m[1], value: m[2].trim() });
  });
  return out;
}

function propertiesLines(text: string): { line: number; key: string; value: string }[] {
  const out: { line: number; key: string; value: string }[] = [];
  const physical = text.replace(/^﻿/, '').split('\n');
  for (let i = 0; i < physical.length; i++) {
    const start = i + 1;
    let logical = physical[i].replace(/\r$/, '');
    if (/^\s*[#!]/.test(logical) || logical.trim() === '') continue;
    while (/(^|[^\\])(\\\\)*\\$/.test(logical) && i + 1 < physical.length) {
      logical = logical.slice(0, -1) + physical[++i].replace(/\r$/, '').trimStart();
    }
    const m = /^\s*((?:\\.|[^=:\s\\])+)\s*[=:\s]\s*(.*)$/.exec(logical);
    if (m) out.push({ line: start, key: m[1].replace(/\\(.)/g, '$1'), value: m[2].trim() });
    else out.push({ line: start, key: logical.trim(), value: '' });
  }
  return out;
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.substring(1, t.length - 1);
  }
  return t;
}
