import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as core from '@actions/core';
jest.mock('@actions/core');
import { Setting } from '../../src/ciRules';
import { AgentNote, ExtensionNote, NOTE_NAME_MAX, agentNotes, extensionNotes } from '../../src/logPolicy/agents';
import { report, scan } from '../../src/steps/ciCheck';

// The CLI's suite holds a copy of this file and pins the same digest; a case is added to both by copying the file.
const SUITE = path.join(__dirname, '..', 'fixtures', 'ci-rules', 'agent-cases.json');
const AGENT_CASES_DIGEST = 'c0a851dc09d01d5611691cd3818a9b1b7f33b5566acdcabbe305edb6b17af238';

interface Cases {
  agents: { name: string; path: string; text: string; notes: { line: number; agents: string[] }[] }[];
  extensions: { name: string; settings: Setting[]; notes: ExtensionNote[] }[];
}

const bytes = fs.readFileSync(SUITE);
const cases = JSON.parse(bytes.toString('utf8')) as Cases;

beforeEach(() => jest.clearAllMocks());

it('is the copy of the agent cases the CLI holds', () => {
  expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(AGENT_CASES_DIGEST);
  expect(cases.agents.length).toBeGreaterThan(0);
  expect(cases.extensions.length).toBeGreaterThan(0);
});

it.each(cases.agents.map((c) => [c.name, c] as const))('agents: %s', (_name, c) => {
  expect(agentNotes(c.path, c.text)).toEqual(c.notes.map((n) => ({ path: c.path, ...n })));
});

it.each(cases.extensions.map((c) => [c.name, c] as const))('extensions: %s', (_name, c) => {
  expect(extensionNotes(c.settings)).toEqual(c.notes);
});

it('cuts a note name to its bound', () => {
  const long = 'a'.repeat(NOTE_NAME_MAX + 5) + '.jar';
  const [agent] = agentNotes('Dockerfile', `CMD java -javaagent:/opt/${long}\n`);
  expect(Array.from(agent.agents[0])).toHaveLength(NOTE_NAME_MAX);
  const [ext] = extensionNotes([{ name: 'OTEL_JAVAAGENT_EXTENSIONS', value: `/opt/${long}`, path: 'a.env', line: 1 }]);
  expect(Array.from(ext.extension)).toHaveLength(NOTE_NAME_MAX);
});

it('reads a long run of separators in linear time', () => {
  const started = Date.now();
  expect(agentNotes('Dockerfile', 'CMD java -javaagent:' + '/'.repeat(200000) + 'x\n')).toEqual([
    { path: 'Dockerfile', line: 1, agents: ['x'] },
  ]);
  expect(extensionNotes([{ name: 'OTEL_JAVAAGENT_EXTENSIONS', value: 'x' + '/'.repeat(200000), path: 'a.env', line: 1 }]))
    .toEqual([{ path: 'a.env', line: 1, extension: 'x', directory: true }]);
  expect(Date.now() - started).toBeLessThan(1000);
});

it('collects agent notes from each file the scan reads and extension notes from its settings, with the check off too', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'));
  fs.writeFileSync(path.join(root, 'Dockerfile'),
    'ENTRYPOINT ["java", "-javaagent:/opt/newrelic.jar", "-Dotel.javaagent.extensions=/opt/vendor.jar", "-jar", "a.jar"]\n');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'java -javaagent:/opt/newrelic.jar\n');
  for (const settings of [true, false]) {
    const read = scan(root, ['Dockerfile', 'notes.txt'], false, settings);
    expect(read.agents).toEqual([{ path: 'Dockerfile', line: 1, agents: ['newrelic.jar'] }]);
    expect(read.extensions).toEqual([{ path: 'Dockerfile', line: 1, extension: 'vendor.jar', directory: false }]);
  }
});

it('reports each note as a notice on its file and line, naming the file only', () => {
  const agents: AgentNote[] = [{ path: 'Dockerfile', line: 2, agents: ['dd-java-agent.jar', 'newrelic.jar'] }];
  const extensions: ExtensionNote[] = [
    { path: 'k8s/deploy.yaml', line: 30, extension: 'vendor.jar', directory: false },
    { path: 'k8s/deploy.yaml', line: 31, extension: 'ext', directory: true },
  ];
  report([], [], { aot: [], agents, extensions });
  expect(core.notice).toHaveBeenCalledWith(
    'Java agent not named as the OpenTelemetry agent: dd-java-agent.jar, newrelic.jar. Another agent can export the same telemetry again or change what the agent records; the OpenTelemetry agent under another name is fine.',
    { file: 'Dockerfile', startLine: 2, title: 'Maestro: another Java agent' },
  );
  expect(core.notice).toHaveBeenCalledWith(
    "Agent extension not named as a bundle's extension: vendor.jar. Another extension runs inside the agent and can change what it records or exports; your bundle's extension under another name is fine.",
    { file: 'k8s/deploy.yaml', startLine: 30, title: 'Maestro: another agent extension' },
  );
  expect(core.notice).toHaveBeenCalledWith(
    "Agent extension directory: ext. The agent loads every JAR directly in it, which this check cannot see; keep only the bundle's extension there.",
    { file: 'k8s/deploy.yaml', startLine: 31, title: 'Maestro: another agent extension' },
  );
  expect(core.notice).toHaveBeenCalledTimes(3);
  expect(core.warning).not.toHaveBeenCalled();
  expect(core.error).not.toHaveBeenCalled();
});
