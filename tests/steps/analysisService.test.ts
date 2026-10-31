import nock from 'nock';
jest.mock('@actions/core');
import { MaestroApi } from '../../src/api';
import { readAnalysisOfUpload } from '../../src/steps/analysisService';

const BASE = 'https://api.oteligence.com';
function client(): MaestroApi {
  const a = new MaestroApi(BASE);
  a.setToken('jwt');
  return a;
}

afterEach(() => nock.cleanAll());

const namesOf = async (...args: Parameters<typeof readAnalysisOfUpload>) => (await readAnalysisOfUpload(...args)).names;

function stubPreview(jobId: string, services: unknown[]) {
  nock(BASE)
    .get(`/api/job-manager/jobs/${jobId}/preview`)
    .reply(200, { data: { previewJsonUrl: 'https://s3.example.com/preview.json' } });
  nock('https://s3.example.com').get('/preview.json').reply(200, JSON.stringify({ services }));
}

it("names the uploaded JAR by the analysis's key, then its display name", async () => {
  // Two uploads share the name, so each is keyed by its class-content fingerprint.
  stubPreview('an_1', [
    { name: 'transaction-service', serviceKey: 'transaction-service@5e6f7a8b', jarUid: 'art-other' },
    { name: 'transaction-service', serviceKey: 'transaction-service@1a2b3c4d', jarUid: 'art-mine' },
  ]);

  await expect(namesOf(client(), 'an_1', 'art-mine')).resolves.toEqual([
    'transaction-service@1a2b3c4d',
    'transaction-service',
  ]);
});

it('gives a name only one upload carries once, and reads a preview with no key by its name', async () => {
  stubPreview('an_5', [{ name: 'transaction-service', serviceKey: 'transaction-service', jarUid: 'art-mine' }]);
  await expect(namesOf(client(), 'an_5', 'art-mine')).resolves.toEqual(['transaction-service']);

  stubPreview('an_6', [{ name: 'transaction-service', jarUid: 'art-mine' }]);
  await expect(namesOf(client(), 'an_6', 'art-mine')).resolves.toEqual(['transaction-service']);

  stubPreview('an_7', [{ name: 'transaction-service', serviceKey: '', jarUid: 'art-mine' }]);
  await expect(namesOf(client(), 'an_7', 'art-mine')).resolves.toEqual(['transaction-service']);
});

it('returns nothing without an artifact uid, and asks no question', async () => {
  await expect(namesOf(client(), 'an_2', null)).resolves.toEqual([]);
  expect(nock.pendingMocks()).toEqual([]);
});

it('returns nothing when the preview is unavailable', async () => {
  nock(BASE).get('/api/job-manager/jobs/an_3/preview').reply(409, { message: 'Job is not complete yet' });

  await expect(namesOf(client(), 'an_3', 'art-mine')).resolves.toEqual([]);
});

it('returns nothing when no service in the preview came from the upload', async () => {
  stubPreview('an_4', [{ name: 'account-service', jarUid: 'art-account' }]);

  await expect(namesOf(client(), 'an_4', 'art-mine')).resolves.toEqual([]);
});

it("returns what the analysis left out of the uploaded JAR, and nothing of another upload's", async () => {
  stubPreview('an_8', [
    { name: 'orders', jarUid: 'art-mine', notices: ['1 class could not be parsed and is not analysed: A.class.', 7, ''] },
    { name: 'ledger', jarUid: 'art-other', notices: ['not mine'] },
  ]);
  await expect(readAnalysisOfUpload(client(), 'an_8', 'art-mine')).resolves.toEqual({
    names: ['orders'],
    notices: ['1 class could not be parsed and is not analysed: A.class.'],
    warnings: [],
  });
});

it('returns no notices for a JAR the scan read in full, or a preview from an older engine', async () => {
  stubPreview('an_9', [{ name: 'orders', jarUid: 'art-mine' }]);
  await expect(readAnalysisOfUpload(client(), 'an_9', 'art-mine')).resolves.toEqual({ names: ['orders'], notices: [], warnings: [] });
});

it("returns the uploaded JAR's in-app tracer warnings apart from its notices, and nothing of another upload's", async () => {
  stubPreview('an_10', [
    { name: 'orders', jarUid: 'art-mine', notices: ['n'], warnings: ['This service bundles X.', 3, ''] },
    { name: 'ledger', jarUid: 'art-other', warnings: ['not mine'] },
  ]);
  await expect(readAnalysisOfUpload(client(), 'an_10', 'art-mine')).resolves.toEqual({
    names: ['orders'],
    notices: ['n'],
    warnings: ['This service bundles X.'],
  });
});
