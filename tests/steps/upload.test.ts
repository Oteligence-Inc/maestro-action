import nock from 'nock';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
jest.mock('@actions/core');
import { MaestroApi } from '../../src/api';
import { uploadJar } from '../../src/steps/upload';
import { sha256Buffer } from '../../src/util/sha';
import { Inputs, ResolvedConfig } from '../../src/types';

const BASE = 'https://api.oteligence.com';
function client(): MaestroApi {
  const a = new MaestroApi(BASE);
  a.setToken('jwt');
  return a;
}

const JAR_BYTES = Buffer.from('fake-jar-bytes-payment-v2');
const JAR_SHA = sha256Buffer(JAR_BYTES);
const jarFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-up-')), 'payment-service.jar');
fs.writeFileSync(jarFile, JAR_BYTES);
const jarsGlob = jarFile.replace(/\\/g, '/'); // glob wants forward slashes

afterEach(() => nock.cleanAll());

const cfg: ResolvedConfig = {
  projectUid: 'proj_1',
  lockedVersionUid: 'lv_9',
  locked: {
    version: 22,
    goals: [],
    selection: [],
    registeredJars: {
      'payment-service': { sha: 'oldpaymentsha' }, // the service we're uploading — excluded from refs
      'order-service': { sha: 'ordersha' }, // peer — referenced by SHA
    },
  },
};
const inputs = { service: 'payment-service', jarsGlob } as Inputs;

it('uploads the changed JAR, references peers by SHA, and confirms UPLOADED (mustUpload=true)', async () => {
  let batchBody: any;
  nock(BASE)
    .post('/api/file/artifact/upload/batch', (b) => {
      batchBody = b;
      return true;
    })
    .reply(200, {
      artifactGroupUid: 'grp_1',
      uploads: [
        { artifactUid: 'art_0', preSignedUrl: 'https://s3.example.com/put' },
        { artifactUid: 'art_peer', preSignedUrl: null },
      ],
    });
  const s3 = nock('https://s3.example.com').put('/put').reply(200);
  let statusBody: any;
  nock(BASE)
    .put('/api/file/artifact/status', (b) => {
      statusBody = b;
      return true;
    })
    .reply(200, { status: 'UPLOADED' });

  const result = await uploadJar(client(), inputs, cfg);

  expect(result.artifactGroupUid).toBe('grp_1');
  expect(result.sha).toBe(JAR_SHA);
  expect(result.mustUpload).toBe(true);
  expect(s3.isDone()).toBe(true);
  // batch request shape: our jar uploads; the order-service peer is referenced by SHA
  expect(batchBody.projectId).toBe('proj_1');
  expect(batchBody.files[0]).toMatchObject({ sha256: JAR_SHA, referenceExistingOnly: false });
  const peer = batchBody.files.find((f: any) => f.referenceExistingOnly === true);
  expect(peer).toMatchObject({ sha256: 'ordersha', referenceExistingOnly: true });
  // status confirm uses the changed jar's artifact + checksum
  expect(statusBody).toMatchObject({ artifactId: 'art_0', operation: 'UPLOAD', status: 'UPLOADED', checksum: JAR_SHA });
});

it('skips the byte upload on a SHA cache hit (mustUpload=false)', async () => {
  nock(BASE)
    .post('/api/file/artifact/upload/batch')
    .reply(200, { artifactGroupUid: 'grp_2', uploads: [{ artifactUid: 'art_existing', preSignedUrl: null }] });
  // no S3 PUT, no status PUT nocked → if the code tried them, nock would throw

  const result = await uploadJar(client(), inputs, cfg);
  expect(result.mustUpload).toBe(false);
  expect(result.artifactGroupUid).toBe('grp_2');
  expect(result.sha).toBe(JAR_SHA);
});
