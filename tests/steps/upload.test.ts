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
      'payment-service': { sha: 'oldpaymentsha', artifactUid: 'art_pay_old' }, // the service we're uploading
      'order-service': { sha: 'ordersha', artifactUid: 'art_order' }, // peer named by the uid the lock froze
      'inventory-service': { sha: 'invsha' }, // a lock entry with no uid: referenced by SHA in this project
      'shipping-service': { artifactUid: 'art_ship' }, // uid with no SHA: still referenced
      'legacy-service': {}, // neither: nothing to reference
      'payment-old-name': { sha: 'oldpaymentsha', artifactUid: 'art_pay_old' }, // this service under a leftover name
    },
  },
};
const inputs = { service: 'payment-service', jarsGlob } as Inputs;

it('uploads the changed JAR, names each peer by its locked artifactUid (else its SHA), and confirms UPLOADED', async () => {
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
  // batch request shape: our jar uploads; each peer is referenced, by uid where the lock froze one
  expect(batchBody.projectId).toBe('proj_1');
  expect(batchBody.files[0]).toMatchObject({ sha256: JAR_SHA, referenceExistingOnly: false });
  const peers = batchBody.files.filter((f: any) => f.referenceExistingOnly === true);
  expect(peers).toEqual([
    { fileName: 'order-service.jar', fileSizeInBytes: 1, sha256: 'ordersha', referenceExistingOnly: true, artifactUid: 'art_order' },
    { fileName: 'inventory-service.jar', fileSizeInBytes: 1, sha256: 'invsha', referenceExistingOnly: true },
    { fileName: 'shipping-service.jar', fileSizeInBytes: 1, referenceExistingOnly: true, artifactUid: 'art_ship' },
  ]);
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

it('fails with file-service\'s reason when a peer the lock named is no longer stored', async () => {
  nock(BASE)
    .post('/api/file/artifact/upload/batch', (b) =>
      b.files.some((f: any) => f.artifactUid === 'art_order' && f.referenceExistingOnly === true),
    )
    .reply(404, { message: 'No uploaded artifact art_order to reference for order-service.jar' });

  await expect(uploadJar(client(), inputs, cfg)).rejects.toThrow(
    /HTTP 404.*No uploaded artifact art_order to reference for order-service\.jar/,
  );
});
