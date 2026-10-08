import nock from 'nock';
jest.mock('@actions/core');
import { MaestroApi } from '../../src/api';
import { analysisServiceNames } from '../../src/steps/analysisService';

const BASE = 'https://api.oteligence.com';
function client(): MaestroApi {
  const a = new MaestroApi(BASE);
  a.setToken('jwt');
  return a;
}

afterEach(() => nock.cleanAll());

function stubPreview(jobId: string, services: unknown[]) {
  nock(BASE)
    .get(`/api/job-manager/jobs/${jobId}/preview`)
    .reply(200, { data: { previewJsonUrl: 'https://s3.example.com/preview.json' } });
  nock('https://s3.example.com').get('/preview.json').reply(200, JSON.stringify({ services }));
}

it("names the uploaded JAR by the analysis's key, then its display name", async () => {
  stubPreview('an_1', [
    { name: 'account-service', serviceKey: 'account-service', jarUid: 'art-account' },
    { name: 'transaction-service', serviceKey: 'transaction-service@1a2b3c4d', jarUid: 'art-mine' },
  ]);

  await expect(analysisServiceNames(client(), 'an_1', 'art-mine')).resolves.toEqual([
    'transaction-service@1a2b3c4d',
    'transaction-service',
  ]);
});

it('gives a name only one upload carries once, and reads a preview with no key by its name', async () => {
  stubPreview('an_5', [{ name: 'transaction-service', serviceKey: 'transaction-service', jarUid: 'art-mine' }]);
  await expect(analysisServiceNames(client(), 'an_5', 'art-mine')).resolves.toEqual(['transaction-service']);

  stubPreview('an_6', [{ name: 'transaction-service', jarUid: 'art-mine' }]);
  await expect(analysisServiceNames(client(), 'an_6', 'art-mine')).resolves.toEqual(['transaction-service']);
});

it('returns nothing without an artifact uid, and asks no question', async () => {
  await expect(analysisServiceNames(client(), 'an_2', null)).resolves.toEqual([]);
  expect(nock.pendingMocks()).toEqual([]);
});

it('returns nothing when the preview is unavailable', async () => {
  nock(BASE).get('/api/job-manager/jobs/an_3/preview').reply(409, { message: 'Job is not complete yet' });

  await expect(analysisServiceNames(client(), 'an_3', 'art-mine')).resolves.toEqual([]);
});

it('returns nothing when no service in the preview came from the upload', async () => {
  stubPreview('an_4', [{ name: 'account-service', jarUid: 'art-account' }]);

  await expect(analysisServiceNames(client(), 'an_4', 'art-mine')).resolves.toEqual([]);
});
