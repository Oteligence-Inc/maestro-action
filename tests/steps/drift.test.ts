jest.mock('@actions/core');
import * as core from '@actions/core';
import { reportDrift } from '../../src/steps/drift';

const warning = core.warning as jest.Mock;
const info = core.info as jest.Mock;

beforeEach(() => jest.clearAllMocks());

function checked(services: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { status: 'checked', lockVersion: 4, services, ...extra };
}

function svc(rec: string[], gone: string[], recCount = rec.length, goneCount = gone.length) {
  return { recommendedNotInLock: { count: recCount, keys: rec }, lockedNotInJar: { count: goneCount, keys: gone } };
}

it("warns on the run's own service, naming each kind of drift", () => {
  reportDrift(checked({ 'fund-transfer-service': svc(['fts::a.B.added'], ['fts::a.B.gone']) }), ['fund-transfer-service']);

  expect(warning).toHaveBeenCalledWith(expect.stringMatching(
    /^Drift against lock v4 in fund-transfer-service: 1 method\(s\) the analysis now recommends are not in the lock: fts::a\.B\.added\./));
  expect(warning).toHaveBeenCalledWith(expect.stringMatching(
    /1 locked method\(s\) are no longer in the JAR or can no longer be instrumented: fts::a\.B\.gone\./));
  expect(info).not.toHaveBeenCalledWith(expect.stringContaining('No drift'));
});

it("prints the server's full count beside the names it sent", () => {
  const keys = Array.from({ length: 10 }, (_, i) => `s::a.B.m${i}`);
  reportDrift(checked({ s: svc(keys, [], 120) }), ['s']);

  expect(warning).toHaveBeenCalledWith(expect.stringContaining('120 method(s)'));
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('s::a.B.m9 and 110 more'));
});

it('says no drift when the check found none, naming nothing', () => {
  reportDrift(checked({}), ['s']);

  expect(warning).not.toHaveBeenCalled();
  expect(info).toHaveBeenCalledWith('No drift against lock v4.');
});

it("gives peers' drift as one count line, without their names", () => {
  reportDrift(checked({ other: svc(['other::x.Y.z'], []) }), ['mine']);

  expect(warning).not.toHaveBeenCalled();
  expect(info).toHaveBeenCalledWith(expect.stringMatching(/^Other services of this environment drift from lock v4 by 1 method/));
  expect(info.mock.calls.flat().join('\n')).not.toContain('x.Y.z');
});

it('names lock services the analysis has none for, and never says no drift then', () => {
  reportDrift({ status: 'unmatched', lockVersion: 4, services: {}, unmatchedServices: ['billing'] }, ['mine']);

  expect(warning).toHaveBeenCalledWith(expect.stringContaining('no service matching billing'));
  expect(info).not.toHaveBeenCalledWith(expect.stringContaining('No drift'));
});

it("says when the engine changed since the lock", () => {
  reportDrift(checked({ s: svc(['s::a.B.n'], []) }, { engineChanged: true }), ['s']);

  expect(warning).toHaveBeenCalledWith(expect.stringContaining('The analysis engine changed since the lock'));
});

it.each([
  ['same_analysis', /Built from lock v4's own analysis/],
  ['unreadable', /Drift against lock v4 was not checked \(unreadable\)/],
  ['lock_has_no_analysis', /not checked \(lock has no analysis\)/],
  ['no_lock', /not checked \(no lock\)/],
])('reports %s as information', (status, line) => {
  reportDrift({ status, lockVersion: 4 }, ['s']);

  expect(info).toHaveBeenCalledWith(expect.stringMatching(line));
  expect(warning).not.toHaveBeenCalled();
});

it('warns when the analysis was not made from the build', () => {
  reportDrift({ status: 'unbound', lockVersion: 4 }, ['s']);

  expect(warning).toHaveBeenCalledWith(expect.stringContaining("not made from this build's JARs"));
});

it.each([undefined, null, 'x', 7, {}, { status: 'later_status' }, { status: 'checked', services: 'x' }])(
  'prints nothing it cannot read and never throws (%p)', (drift) => {
    expect(() => reportDrift(drift, ['s'])).not.toThrow();
    expect(warning).not.toHaveBeenCalled();
  });

it('reads a malformed group as what it holds', () => {
  reportDrift(checked({ s: { recommendedNotInLock: { count: 'many', keys: ['s::a.B.k', 5] }, lockedNotInJar: null } }), ['s']);

  expect(warning).toHaveBeenCalledWith(expect.stringContaining('1 method(s) the analysis now recommends are not in the lock: s::a.B.k.'));
});
