import { PLACEHOLDER, Setting, fold, trimAscii } from '../ciRules';
import { kindOf } from './extract';

/**
 * A line of a deployment file that starts the JVM with a Java agent other than the OpenTelemetry agent, which can
 * export the same telemetry again or change what the agent records. The CLI's `AgentNotes` reads the same lines
 * (tests/fixtures/ci-rules/agent-cases.json).
 */
export interface AgentNote {
  path: string;
  line: number;
  agents: string[];
}

/**
 * An otel.javaagent.extensions entry that is not a bundle's extension: a JAR the bundle does not ship, or a directory,
 * every JAR of which the agent loads. The CLI's `ExtensionNotes` gives the same notes.
 */
export interface ExtensionNote {
  path: string;
  line: number;
  extension: string;
  directory: boolean;
}

/** The bound, in code points, on the name a note shows. */
export const NOTE_NAME_MAX = 200;

// A -javaagent flag standing as its own token; its JAR path ends at its options' =. Whitespace is ASCII only, as Go's
// class is in the CLI's copy.
const JAVA_AGENT_FLAG = /(?:^|[\t\n\f\r "'[,=])-javaagent:([^\t\n\f\r "',\]=]+)/g;
// A path naming the OpenTelemetry agent: otel or opentelemetry as a word in any segment, as every distribution of it is
// named.
const OTEL_AGENT_PATH = /(?:^|[^a-z])(?:otel|opentelemetry)(?:[^a-z]|$)/i;
// A path a template fills in, which names nothing the check can judge.
const UNREADABLE_PATH = /[$@{}]/;

/**
 * The lines of one file's text that start a Java agent other than the OpenTelemetry agent, one note per line naming each
 * such agent's file once, skipping comment lines and paths a template fills in.
 */
export function agentNotes(path: string, text: string): AgentNote[] {
  const out: AgentNote[] = [];
  const properties = kindOf(path) === 'properties';
  text.replace(/^\uFEFF/, '').split('\n').forEach((line, i) => {
    const trimmed = line.replace(/\r$/, '').replace(/^[ \t]+/, '');
    if (trimmed.startsWith('#') || (properties && trimmed.startsWith('!'))) return;
    const agents: string[] = [];
    for (const m of line.matchAll(JAVA_AGENT_FLAG)) {
      if (UNREADABLE_PATH.test(m[1]) || OTEL_AGENT_PATH.test(m[1])) continue;
      const name = lastSegment(m[1]);
      if (name !== '' && !agents.includes(name)) agents.push(name);
    }
    if (agents.length > 0) out.push({ path, line: i + 1, agents });
  });
  return out;
}

/**
 * The entries of each otel.javaagent.extensions setting that are not a bundle's extension (a JAR named
 * <service>-extension.jar), once per file, line and entry, in the settings' order. An entry a template fills in is
 * skipped, and the value's other entries are still read.
 */
export function extensionNotes(settings: Setting[]): ExtensionNote[] {
  const out: ExtensionNote[] = [];
  const seen = new Set<string>();
  for (const s of settings) {
    if (fold(s.name) !== 'otel.javaagent.extensions') continue;
    for (const raw of (s.value ?? '').split(',')) {
      const entry = trimAscii(raw);
      if (entry === '' || PLACEHOLDER.test(entry) || UNREADABLE_PATH.test(entry)) continue;
      const name = lastSegment(entry);
      if (name === '') continue;
      const lower = name.replace(/[A-Z]/g, (c) => c.toLowerCase());
      if (lower.endsWith('-extension.jar')) continue;
      const note: ExtensionNote = { path: s.path, line: s.line, extension: name, directory: !lower.endsWith('.jar') };
      const key = JSON.stringify(note);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(note);
      }
    }
  }
  return out;
}

/** A path's last non-empty segment, / or \ separated, cut to NOTE_NAME_MAX code points. */
function lastSegment(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '');
  const name = trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1);
  const points = Array.from(name);
  return points.length > NOTE_NAME_MAX ? points.slice(0, NOTE_NAME_MAX).join('') : name;
}
