import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BuildVerificationError, Downloaded, LEFT_OUT, verifyBuild } from '../../src/steps/verify';
import { BuildRecord } from '../../src/types';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const UPLOAD = sha('the uploaded jar');
const PEER = sha('a peer jar');

/** A download as the action leaves it: the extracted bundle, the two configs beside it, and the build's record. */
function download(overrides: Partial<Downloaded> = {}, recordOverrides: Partial<BuildRecord> = {}): Downloaded {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-verify-'));
  const ext = path.join(base, 'extension');
  fs.mkdirSync(ext);
  const bundle: Record<string, string> = {
    'orders-prod-extension.jar': 'EXT',
    'javaagent-orders.config': 'AGENT',
    'collector-config.yaml': 'COLLECTOR',
    'selection-ledger.json': '{}',
  };
  for (const [name, body] of Object.entries(bundle)) fs.writeFileSync(path.join(ext, name), body);
  // Left-out files: in the bundle, not in the record.
  fs.writeFileSync(path.join(ext, 'summary.html'), '<html>job 1</html>');
  fs.writeFileSync(path.join(ext, 'build-annex.json'), '{"jobId":"1"}');
  fs.writeFileSync(path.join(base, 'javaagent.config'), 'AGENT');
  fs.writeFileSync(path.join(base, 'collector-config.yaml'), 'COLLECTOR');
  const files = Object.fromEntries(Object.entries(bundle).map(([n, b]) => [n, sha(b)]));
  return {
    record: {
      status: 'recorded',
      inputsDigest: sha('inputs'),
      applicationJars: [PEER, UPLOAD],
      files,
      firstJobId: 'build_0',
      bindings: { orders: UPLOAD, payments: PEER },
      ...recordOverrides,
    },
    uploadSha: UPLOAD,
    serviceKey: 'orders',
    extensionDir: ext,
    configPath: path.join(base, 'javaagent.config'),
    configFileName: 'javaagent-orders.config',
    collectorConfigPath: path.join(base, 'collector-config.yaml'),
    collectorConfigFileName: 'collector-config.yaml',
    ...overrides,
  };
}

async function refusal(d: Downloaded): Promise<string> {
  try {
    await verifyBuild(d);
  } catch (err) {
    expect(err).toBeInstanceOf(BuildVerificationError);
    // A refused download is removed, so no later step of the workflow can deploy it.
    expect(fs.existsSync(d.extensionDir)).toBe(false);
    if (d.configPath) expect(fs.existsSync(d.configPath)).toBe(false);
    if (d.collectorConfigPath) expect(fs.existsSync(d.collectorConfigPath)).toBe(false);
    return (err as Error).message;
  }
  throw new Error('verifyBuild accepted a download it should refuse');
}

it('accepts the recorded files and reports the status', async () => {
  await expect(verifyBuild(download())).resolves.toBe('recorded');
  await expect(verifyBuild(download({}, { status: 'matched' }))).resolves.toBe('matched');
});

it('refuses a server that does not record builds, in its own words', async () => {
  expect(await refusal(download({ record: undefined }))).toMatch(/does not record its builds.*Upgrade the server/);
});

it('refuses a build with no record', async () => {
  expect(await refusal(download({ record: null }))).toMatch(/has no record/);
});

it('refuses a malformed record', async () => {
  const bad: unknown[] = [
    { status: 'recorded', inputsDigest: 'x', applicationJars: 'not-a-list', files: {}, firstJobId: 'b', bindings: { orders: UPLOAD } },
    { status: 'recorded', inputsDigest: 'x', applicationJars: ['NOT-HEX'], files: {}, firstJobId: 'b', bindings: { orders: UPLOAD } },
    { status: 'recorded', inputsDigest: 'x', applicationJars: [UPLOAD], files: ['a'], firstJobId: 'b', bindings: { orders: UPLOAD } },
    { status: 'recorded', inputsDigest: 'x', applicationJars: [UPLOAD], files: { 'a/b.jar': sha('x') }, firstJobId: 'b', bindings: { orders: UPLOAD } },
    { status: 7, inputsDigest: 'x', applicationJars: [UPLOAD], files: {}, firstJobId: 'b', bindings: { orders: UPLOAD } },
    { status: 'recorded', inputsDigest: 7, applicationJars: [UPLOAD], files: {}, firstJobId: 'b', bindings: { orders: UPLOAD } },
    { status: 'recorded', inputsDigest: 'x', applicationJars: [UPLOAD], files: { 'a.jar': 'NOT-HEX' }, firstJobId: 'b', bindings: { orders: UPLOAD } },
    { status: 'recorded', inputsDigest: 'x', applicationJars: [UPLOAD], files: { '': sha('x') }, firstJobId: 'b', bindings: { orders: UPLOAD } },
    { status: 'recorded', inputsDigest: 'x', applicationJars: [UPLOAD], files: null, firstJobId: 'b', bindings: { orders: UPLOAD } },
    { status: 'recorded', inputsDigest: 'x', applicationJars: [UPLOAD], files: {}, firstJobId: 'b', bindings: [UPLOAD] },
    { status: 'recorded', inputsDigest: 'x', applicationJars: [UPLOAD], files: {}, firstJobId: 'b', bindings: null },
    { status: 'recorded', inputsDigest: 'x', applicationJars: [UPLOAD], files: {}, firstJobId: 'b', bindings: { orders: 'NOT-HEX' } },
    { status: 'recorded', inputsDigest: 'x', applicationJars: [UPLOAD], files: {}, firstJobId: 'b', bindings: { '': UPLOAD } },
  ];
  for (const record of bad) {
    expect(await refusal(download({ record: record as BuildRecord }))).toMatch(/malformed/);
  }
});

it('refuses a server whose record carries no bindings as a server to upgrade, not as a malformed record', async () => {
  const d = download();
  const { bindings: _dropped, ...older } = d.record as BuildRecord;
  const message = await refusal({ ...d, record: older as BuildRecord });
  expect(message).toMatch(/does not record which upload it built each service from.*Upgrade the server/);
  expect(message).not.toMatch(/malformed/);
});

it('reads only the record\'s own bindings, never an inherited member', async () => {
  for (const key of ['constructor', 'toString', '__proto__']) {
    expect(await refusal(download({ serviceKey: key }))).toMatch(new RegExp(`binds no JAR to ${key},`));
  }
});

it('refuses a build that differs from the record of its inputs, as a platform fault, not as tampering', async () => {
  const message = await refusal(download({}, { status: 'differs' }));
  expect(message).toMatch(/platform could not reproduce this build.*build_0/);
  expect(message).not.toMatch(/does not match the record/);
});

it('refuses a status it does not know', async () => {
  expect(await refusal(download({}, { status: 'pending' }))).toMatch(/status this action does not know \("pending"\)/);
});

it('refuses a record naming no JAR, and one not naming the uploaded JAR', async () => {
  expect(await refusal(download({}, { applicationJars: [] }))).toMatch(/names no application JAR/);
  expect(await refusal(download({}, { applicationJars: [PEER] }))).toMatch(
    new RegExp(`does not name the JAR this run uploaded \\(SHA-256 ${UPLOAD}\\)`),
  );
});

it('refuses a build that bound another JAR to this service, though the upload is in its group', async () => {
  const message = await refusal(download({}, { bindings: { orders: PEER, payments: UPLOAD } }));
  expect(message).toMatch(new RegExp(`bound orders to another JAR \\(SHA-256 ${PEER}\\), not the one this run uploaded`));
});

it('refuses a record that binds nothing to the analysis key of the upload', async () => {
  expect(await refusal(download({}, { bindings: { payments: UPLOAD } }))).toMatch(
    /binds no JAR to orders, the service the analysis made of the uploaded JAR/,
  );
});

it('refuses when the analysis gave the upload no service key, rather than checking a service it cannot name', async () => {
  expect(await refusal(download({ serviceKey: undefined }))).toMatch(/could not name the service the analysis made/);
  expect(await refusal(download({ serviceKey: '' }))).toMatch(/could not name the service the analysis made/);
});

it('checks the binding by the analysis key, not the display name', async () => {
  const keyed = download({ serviceKey: 'orders@0a1b2c3d' }, { bindings: { 'orders@0a1b2c3d': UPLOAD, orders: PEER } });
  await expect(verifyBuild(keyed)).resolves.toBe('recorded');
});

it('refuses an extracted file whose bytes differ from the record', async () => {
  const d = download();
  fs.writeFileSync(path.join(d.extensionDir, 'orders-prod-extension.jar'), 'SWAPPED');
  expect(await refusal(d)).toMatch(/does not match the record of its build: orders-prod-extension\.jar/);
});

it('refuses a file the record does not hold, and a recorded file the download lacks', async () => {
  const extra = download();
  fs.writeFileSync(path.join(extra.extensionDir, 'evil-extension.jar'), 'X');
  expect(await refusal(extra)).toMatch(/evil-extension\.jar is in the download but not in the record/);

  const missing = download();
  fs.rmSync(path.join(missing.extensionDir, 'selection-ledger.json'));
  expect(await refusal(missing)).toMatch(/selection-ledger\.json is in the record of the build but missing/);
});

it('refuses a folder inside the bundle', async () => {
  const d = download();
  fs.mkdirSync(path.join(d.extensionDir, 'nested'));
  expect(await refusal(d)).toMatch(/nested, which is not a file/);
});

it('ignores the left-out files whether the bundle carries them or not', async () => {
  const without = download();
  fs.rmSync(path.join(without.extensionDir, 'summary.html'));
  await expect(verifyBuild(without)).resolves.toBe('recorded');

  const withAll = download();
  fs.writeFileSync(path.join(withAll.extensionDir, 'lock-record.json'), '{}');
  fs.writeFileSync(path.join(withAll.extensionDir, 'SUMMARY.txt'), 'x');
  await expect(verifyBuild(withAll)).resolves.toBe('recorded');
  expect([...LEFT_OUT].sort()).toEqual(['SUMMARY.txt', 'build-annex.json', 'lock-record.json', 'summary.html']);
});

it('refuses a downloaded config whose bytes differ from its record entry, each config on its own', async () => {
  const agent = download();
  fs.writeFileSync(agent.configPath, 'TAMPERED');
  expect(await refusal(agent)).toMatch(/does not match the record of its build: javaagent-orders\.config/);

  const collector = download();
  fs.writeFileSync(collector.collectorConfigPath, 'TAMPERED');
  expect(await refusal(collector)).toMatch(/does not match the record of its build: collector-config\.yaml/);
});

it('refuses a downloaded config the record has no entry for', async () => {
  expect(await refusal(download({ configFileName: null }))).toMatch(/downloaded javaagent config is not in the record/);
  expect(await refusal(download({ collectorConfigFileName: 'other.yaml' }))).toMatch(
    /downloaded collector config is not in the record/,
  );
});

it('checks no config the run did not download', async () => {
  await expect(verifyBuild(download({ configPath: '', configFileName: null }))).resolves.toBe('recorded');
});

it('refuses a record that covers a file this action leaves out, naming it, rather than calling it missing', async () => {
  const d = download();
  const files = { ...(d.record as BuildRecord).files, 'summary.html': sha('<html>job 1</html>') };
  const message = await refusal({ ...d, record: { ...(d.record as BuildRecord), files } });
  expect(message).toMatch(/covers summary\.html, which this action leaves out because it names the build/);
  expect(message).not.toMatch(/missing from the download/);
});
