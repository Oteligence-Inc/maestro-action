import { kindOf } from './extract';

/**
 * A line of a deployment file that starts the JVM with a JDK AOT cache, which is trained with the same -javaagent flags
 * the service runs with: a cache trained without the agent is rejected when the agent is attached. The CLI's `AOTNotes`
 * reads the same lines (tests/fixtures/ci-rules/aot-cases.json).
 */
export interface AotNote {
  path: string;
  line: number;
  flags: string[];
}

// An AOT cache flag standing as its own token; -XX:AOTConfiguration only ever appears beside -XX:AOTMode.
const AOT_FLAG = /(?:^|[\s"'[,=])(-XX:(?:AOTCacheOutput|AOTCache|AOTMode))=([^\s"',\]]*)/g;

/** The lines of one file's text that set an AOT cache flag, one note per line, skipping comments and -XX:AOTMode=off. */
export function aotNotes(path: string, text: string): AotNote[] {
  const out: AotNote[] = [];
  const properties = kindOf(path) === 'properties';
  text.split('\n').forEach((line, i) => {
    const trimmed = line.replace(/\r$/, '').replace(/^[ \t]+/, '');
    if (trimmed.startsWith('#') || (properties && trimmed.startsWith('!'))) return;
    const flags: string[] = [];
    for (const m of line.matchAll(AOT_FLAG)) {
      if (m[1] === '-XX:AOTMode' && m[2].toLowerCase() === 'off') continue;
      if (!flags.includes(m[1])) flags.push(m[1]);
    }
    if (flags.length > 0) out.push({ path, line: i + 1, flags });
  });
  return out;
}
