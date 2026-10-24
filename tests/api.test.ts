import nock from 'nock';
jest.mock('@actions/core');
import { MaestroApi, requireHttps } from '../src/api';
import { UserError } from '../src/util/errors';

const SIGNED = 'X-Amz-Signature=s3cr3tsig';

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());
afterEach(() => nock.cleanAll());

async function rejection(call: () => Promise<unknown>): Promise<unknown> {
  return call().then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe('signed storage URLs travel over https only', () => {
  it('refuses any other scheme by name, without echoing the URL, and makes no request', async () => {
    const api = new MaestroApi('https://api.oteligence.com');
    for (const scheme of ['http', 'ftp']) {
      const url = `${scheme}://minio.local:9000/b/k?${SIGNED}`;
      for (const call of [() => api.putBytes(url, Buffer.from('jar')), () => api.getSignedBytes(url)]) {
        const err = await rejection(call);
        expect(err).toBeInstanceOf(UserError);
        expect((err as Error).message).toContain(`storage URL over ${scheme}://; `);
        expect((err as Error).message).not.toMatch(/s3cr3tsig|minio\.local/);
      }
    }
  });

  it('reads an https signed URL', async () => {
    nock('https://bucket.s3.amazonaws.com').get('/b/k').query(true).reply(200, 'bundle');
    const api = new MaestroApi('https://api.oteligence.com');
    const body = await api.getSignedBytes(`https://bucket.s3.amazonaws.com/b/k?${SIGNED}`);
    expect(body.toString()).toBe('bundle');
  });

  it('names a redirect from https to http, and never follows it', async () => {
    nock('https://bucket.s3.amazonaws.com')
      .get('/b/k')
      .query(true)
      .reply(307, '', { Location: 'http://evil.local/k' });
    const api = new MaestroApi('https://api.oteligence.com');
    const err = await rejection(() => api.getSignedBytes(`https://bucket.s3.amazonaws.com/b/k?${SIGNED}`));
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message).toMatch(/redirected the Action from https to http/);
  });

  it('refuses an upload answered with a redirect, to any scheme, and never sends it again', async () => {
    for (const location of ['http://evil.local/k', 'https://bucket.s3.eu-west-1.amazonaws.com/b/k']) {
      const scope = nock('https://bucket.s3.amazonaws.com')
        .put('/b/k')
        .query(true)
        .reply(307, '', { Location: location });
      const api = new MaestroApi('https://api.oteligence.com');
      const url = `https://bucket.s3.amazonaws.com/b/k?${SIGNED}`;
      const err = await rejection(() => api.putBytes(url, Buffer.from('jar')));
      expect(err).toBeInstanceOf(UserError);
      expect((err as Error).message).toMatch(/answered the upload with a redirect \(HTTP 307\)/);
      expect(scope.isDone()).toBe(true);
    }
  });

  it('uploads to an https signed URL', async () => {
    const scope = nock('https://bucket.s3.amazonaws.com').put('/b/k', 'jar').query(true).reply(200);
    const api = new MaestroApi('https://api.oteligence.com');
    await api.putBytes(`https://bucket.s3.amazonaws.com/b/k?${SIGNED}`, Buffer.from('jar'));
    expect(scope.isDone()).toBe(true);
  });

  it('refuses a URL that does not parse', () => {
    expect(() => requireHttps('not a url')).toThrow(/cannot read/);
  });
});
