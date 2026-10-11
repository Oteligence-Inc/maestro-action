import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..');
const actionYml = fs.readFileSync(path.join(root, 'action.yml'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

function declared(section: 'inputs' | 'outputs'): string[] {
  const body = actionYml.match(new RegExp(`^${section}:\\n([\\s\\S]*?)(?=^\\S)`, 'm'))?.[1] ?? '';
  return [...body.matchAll(/^ {2}([a-z-]+):/gm)].map((m) => m[1]);
}

const readmeRows = new Set([...readme.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]));

describe('README documents the action interface', () => {
  it.each(['inputs', 'outputs'] as const)('reads %s from action.yml', (section) => {
    expect(declared(section).length).toBeGreaterThan(2);
  });

  it.each(['inputs', 'outputs'] as const)('has a row for every declared %s', (section) => {
    expect(declared(section).filter((name) => !readmeRows.has(name))).toEqual([]);
  });

  it('has no row for a name action.yml does not declare', () => {
    const all = new Set([...declared('inputs'), ...declared('outputs')]);
    expect([...readmeRows].filter((name) => !all.has(name))).toEqual([]);
  });
});
