import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Finding, RuleSet } from '../../src/ciRules';
import { Problem } from '../../src/logPolicy/extract';
import { findingsOf, scan } from '../../src/steps/ciCheck';
import evaluation from '../fixtures/ci-rules/evaluation-cases.json';

// The CLI's suite holds a copy of this file and pins the same digest. Each suite checks only its own copy, so a case
// is added to both by copying the file and its digest to both repositories.
const SUITE = path.join(__dirname, '..', 'fixtures', 'ci-rules', 'extraction-cases.json');
const EXTRACTION_CASES_DIGEST = '8f6b8e80e890278565b266da0e91302220415c2de6a6ab95c066a6c5a284a2f7';

interface Case {
  name: string;
  files: { path: string; text?: string; base64?: string }[];
  findings: Finding[];
  problems: Problem[];
}

const bytes = fs.readFileSync(SUITE);
const cases = (JSON.parse(bytes.toString('utf8')) as { cases: Case[] }).cases;
const lockFree = Object.values((evaluation as unknown as { ruleSets: Record<string, RuleSet> }).ruleSets).find(
  (s) => s.lockFree,
) as RuleSet;

it('is the copy of the extraction cases the CLI holds', () => {
  expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(EXTRACTION_CASES_DIGEST);
});

describe.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
  it("gives the case's findings and problems", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extraction-'));
    try {
      for (const file of c.files) {
        const abs = path.join(root, file.path);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, file.base64 !== undefined ? Buffer.from(file.base64, 'base64') : Buffer.from(file.text ?? '', 'utf8'));
      }
      const read = scan(root, c.files.map((f) => f.path));
      expect({ findings: findingsOf(lockFree, read.settings), problems: read.problems }).toEqual({
        findings: c.findings,
        problems: c.problems,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
