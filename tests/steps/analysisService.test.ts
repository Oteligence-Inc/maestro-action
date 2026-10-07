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

it("names the uploaded JAR by the analysis's service name, plain and duplicate-keyed", async () => {
  stubPreview('an_1', [
    { name: 'account-service', jarUid: 'art-account' },
    { name: 'transaction-service', jarUid: 'art-mine' },
  ]);

  await expect(analysisServiceNames(client(), 'an_1', 'art-mine')).resolves.toEqual([
    'transaction-service::art-mine',
    'transaction-service',
  ]);
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
