jest.mock('@actions/core');
import * as core from '@actions/core';
import { methodName, reportReleaseNote } from '../../src/steps/releaseNote';

const notice = core.notice as jest.Mock;
const warning = core.warning as jest.Mock;

beforeEach(() => jest.clearAllMocks());

const none = { count: 0, keys: [] };
function note(extra: Record<string, unknown> = {}, lock: Record<string, unknown> = {}) {
  return {
    previous: { jobId: 'build_1', lockVersion: 3 },
    service: 'fund-transfer-service',
    lock: { from: 3, to: 3, methodsAdded: none, methodsRemoved: none, attributesAdded: none, attributesRemoved: none, ...lock },
    methodsGone: { ...none, spans: [] },
    newlyRecommended: { ...none, label: 'scoring output' },
    newSensitive: { count: 0, compared: true, services: {} },
    ci: { checked: true, status: 'passed', newFindings: 0 },
    empty: false,
    ...extra,
  };
}

it('says no change since the previous build for an empty note', () => {
  reportReleaseNote(note({ empty: true }));
  expect(notice).toHaveBeenCalledWith('Release note: no change since build build_1 (lock v3).');
});

it('says a first build has nothing to compare with', () => {
  reportReleaseNote(note({ previous: null }));
  expect(notice).toHaveBeenCalledWith(
    'Release note: no earlier build of this service was registered in this environment, so nothing to compare with.');
});

it('names the methods gone with their spans, the lock change, the findings and the scoring output', () => {
  reportReleaseNote(note({
    methodsGone: { count: 1, keys: ['fts::com.acme.Transfer.audit(I)V'], spans: ['Transfer.audit'] },
    newSensitive: { count: 2, compared: true },
    ci: { checked: true, status: 'warned', newFindings: 1 },
    newlyRecommended: { count: 12, keys: ['fts::com.acme.Transfer.fee'], label: 'scoring output' },
  }, {
    to: 4,
    methodsAdded: { count: 1, keys: ['fts::com.acme.Transfer.send'] },
    methodsRemoved: { count: 1, keys: ['fts::com.acme.Transfer.old'] },
    attributesAdded: { count: 1, keys: ['fts::com.acme.Transfer.send :: order.total'] },
    attributesRemoved: { count: 1, keys: ['fts::com.acme.Transfer.send :: order.id'] },
  }));

  expect(notice).toHaveBeenCalledTimes(1);
  expect(notice.mock.calls[0][0]).toBe([
    'Release note since build build_1 (lock v3):',
    'Lock v3 to v4.',
    'Methods added to the lock: com.acme.Transfer.send.',
    'Methods removed from the lock: com.acme.Transfer.old.',
    'Span attributes added: order.total on com.acme.Transfer.send.',
    'Span attributes removed: order.id on com.acme.Transfer.send.',
    'Locked methods the JAR no longer has: com.acme.Transfer.audit. Spans the previous build\'s inventory lists for them: Transfer.audit.',
    '2 new sensitive log statements, each named in a warning above.',
    'CI log policy check warned: 1 finding the previous build\'s check did not have.',
    'Newly recommended by this analysis (scoring output, not built until you lock again): com.acme.Transfer.fee and 11 more.',
  ].join('\n'));
  expect(warning).not.toHaveBeenCalled();
});

it('prints nothing for a job-manager that sends no note, or a note it cannot read', () => {
  reportReleaseNote(undefined);
  reportReleaseNote('note');
  reportReleaseNote({ empty: true });
  reportReleaseNote({ lock: {}, empty: 'yes' });
  expect(notice).not.toHaveBeenCalled();
});

it('trusts a count no smaller than the names it sent, else counts the names', () => {
  reportReleaseNote(note({ methodsGone: { count: 0, keys: ['s::a.B.m', 's::a.B.n'] } }));
  expect(notice.mock.calls[0][0]).toContain('Locked methods the JAR no longer has: a.B.m, a.B.n.');
});

it('names a method without its service key or descriptor', () => {
  expect(methodName('fts::com.acme.A.b(Ljava/lang/String;)V')).toBe('com.acme.A.b');
  expect(methodName('com.acme.A.b')).toBe('com.acme.A.b');
});

it('says a list it could not compare, or could not name, rather than guess', () => {
  reportReleaseNote(note({
    methodsGone: { count: 0, keys: [], compared: false },
    newlyRecommended: { count: 0, keys: [], compared: true, partial: true, before: 12, now: 11 },
    ci: { checked: true, status: 'warned', newFindings: 0, compared: false },
  }));
  expect(notice.mock.calls[0][0]).toBe([
    'Release note since build build_1 (lock v3):',
    "Locked methods no longer in the JAR were not compared: a build's drift was not checked.",
    "CI log policy check: the previous build's check cannot be compared with this one's.",
    'Methods the analysis recommends (scoring output): 12 before, 11 now; the drift names only the first of them, so they are not named here.',
  ].join('\n'));
});

it('says nothing could be compared when a non-empty note names nothing', () => {
  reportReleaseNote(note());
  expect(notice).toHaveBeenCalledWith('Release note since build build_1 (lock v3):\nNothing could be compared.');
});
