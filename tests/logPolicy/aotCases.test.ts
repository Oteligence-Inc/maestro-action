import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as core from '@actions/core';
jest.mock('@actions/core');
import { AotNote, aotNotes } from '../../src/logPolicy/aot';
import { report, scan } from '../../src/steps/ciCheck';

// The CLI's suite holds a copy of this file and pins the same digest; a case is added to both by copying the file.
const SUITE = path.join(__dirname, '..', 'fixtures', 'ci-rules', 'aot-cases.json');
const AOT_CASES_DIGEST = '0b348acb1fa1497fd1dae23bca92d37438d4080aa64cb04d776d3fbdffd4a418';

interface Case {
  name: string;
  path: string;
  text: string;
  notes: { line: number; flags: string[] }[];
}

const bytes = fs.readFileSync(SUITE);
const cases = (JSON.parse(bytes.toString('utf8')) as { cases: Case[] }).cases;

it('is the copy of the AOT cases the CLI holds', () => {
  expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(AOT_CASES_DIGEST);
  expect(cases.length).toBeGreaterThan(0);
});

it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
  expect(aotNotes(c.path, c.text)).toEqual(c.notes.map((n) => ({ path: c.path, ...n })));
});

it('collects the notes of each file the scan reads, and none from a file it does not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aot-'));
  fs.writeFileSync(path.join(root, 'Dockerfile'), 'ENTRYPOINT ["java", "-XX:AOTCache=a.aot", "-jar", "a.jar"]\n');
  fs.writeFileSync(path.join(root, 'notes.txt'), '-XX:AOTCache=a.aot\n');
  expect(scan(root, ['Dockerfile', 'notes.txt']).aot).toEqual([{ path: 'Dockerfile', line: 1, flags: ['-XX:AOTCache'] }]);
});

it('reports each note as a notice on its file and line, never with a value', () => {
  const notes: AotNote[] = [{ path: 'Dockerfile', line: 2, flags: ['-XX:AOTMode', '-XX:AOTCache'] }];
  report([], [], notes);
  expect(core.notice).toHaveBeenCalledWith(
    'AOT cache: -XX:AOTMode -XX:AOTCache. Train the cache with the -javaagent flags it runs with: one trained without the agent is rejected when the agent is attached.',
    { file: 'Dockerfile', startLine: 2, title: 'Maestro: JDK AOT cache' },
  );
  expect(core.warning).not.toHaveBeenCalled();
  expect(core.error).not.toHaveBeenCalled();
});
