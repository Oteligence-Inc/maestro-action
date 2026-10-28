import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CASES_DIGEST, NAME, RuleSet, Setting, TESTS, evaluate, fold, passesTest, trimAscii, unreadable } from '../src/ciRules';

const SUITE = path.join(__dirname, 'fixtures', 'ci-rules', 'evaluation-cases.json');
const suite = JSON.parse(fs.readFileSync(SUITE, 'utf8')) as {
  version: number;
  ruleSets: Record<string, RuleSet>;
  cases: { name: string; ruleSet: string; settings: Setting[]; findings: { rule: string; severity: string; name: string; path: string; line: number }[] }[];
};

describe('the shared evaluation fixture suite', () => {
  it('is the copy this release pins', () => {
    expect(crypto.createHash('sha256').update(fs.readFileSync(SUITE)).digest('hex')).toBe(CASES_DIGEST);
  });

  it('holds every case', () => {
    expect(suite.cases.length).toBeGreaterThanOrEqual(21);
  });

  it.each(suite.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const set = suite.ruleSets[c.ruleSet];
    expect(set).toBeDefined();
    expect(unreadable(set)).toBeNull();
    const got = evaluate(set, c.settings).map((f) => `${f.rule}|${f.severity}|${f.name}|${f.path}|${f.line}`);
    expect(got).toEqual(c.findings.map((f) => `${f.rule}|${f.severity}|${f.name}|${f.path}|${f.line}`));
  });
});

describe('folding and values', () => {
  it('folds a name as the reference does, and trims only spaces and control characters', () => {
    expect(fold(' LOGGING_LEVEL_ROOT\t')).toBe('logging.level.root');
    expect(fold('--debug')).toBe('debug');
    expect(fold(null)).toBe('');
    expect(trimAscii(' x ')).toBe(' x ');
    expect(trimAscii(' \tx\n')).toBe('x');
  });

  it('has the one name shape job-manager lists', () => {
    expect(NAME.test('logging.level.com.acme-x_1')).toBe(true);
    expect(NAME.test('logging.level.outer$inner')).toBe(false);
  });

  it('refuses a test it does not know when asked to evaluate one', () => {
    const set = Object.values(suite.ruleSets)[0];
    expect(() => passesTest({ ...set.rules[0], test: 'regex' }, 'x', set)).toThrow('unknown test regex');
    expect(TESTS).toContain('spring_set');
  });
});
