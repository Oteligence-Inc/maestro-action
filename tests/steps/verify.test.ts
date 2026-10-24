import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BuildVerificationError,
  Downloaded,
  LEFT_OUT,
  SIGNATURE,
  STATEMENT,
  keyFingerprint,
  verifyBuild,
} from '../../src/steps/verify';
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
  await expect(verifyBuild(download())).resolves.toEqual({ record: 'recorded', signature: 'unsigned' });
  await expect(verifyBuild(download({}, { status: 'matched' }))).resolves.toEqual({ record: 'matched', signature: 'unsigned' });
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
    { status: 'recorded', inputsDigest: 'x', applicationJars: [UPLOAD], files: { '../b.jar': sha('x') }, firstJobId: 'b', bindings: { orders: UPLOAD } },
    { status: 'recorded', inputsDigest: 'x', applicationJars: [UPLOAD], files: { '/etc/b.jar': sha('x') }, firstJobId: 'b', bindings: { orders: UPLOAD } },
    { status: 'recorded', inputsDigest: 'x', applicationJars: [UPLOAD], files: { 'sources//b.java': sha('x') }, firstJobId: 'b', bindings: { orders: UPLOAD } },
    { status: 'recorded', inputsDigest: 'x', applicationJars: [UPLOAD], files: { 'sources/./b.java': sha('x') }, firstJobId: 'b', bindings: { orders: UPLOAD } },
    { status: 'recorded', inputsDigest: 'x', applicationJars: [UPLOAD], files: { 'sources\\b.java': sha('x') }, firstJobId: 'b', bindings: { orders: UPLOAD } },
    { status: 'recorded', inputsDigest: 'x', applicationJars: [UPLOAD], files: { 'sources/': sha('x') }, firstJobId: 'b', bindings: { orders: UPLOAD } },
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
  await expect(verifyBuild(keyed)).resolves.toMatchObject({ record: 'recorded' });
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

it('refuses an empty folder inside the bundle, and a file in a folder the record does not hold', async () => {
  const empty = download();
  fs.mkdirSync(path.join(empty.extensionDir, 'nested'));
  expect(await refusal(empty)).toMatch(/holds nested\/, a folder with nothing in it/);

  const unrecorded = download();
  fs.mkdirSync(path.join(unrecorded.extensionDir, 'nested'));
  fs.writeFileSync(path.join(unrecorded.extensionDir, 'nested', 'evil.jar'), 'X');
  expect(await refusal(unrecorded)).toMatch(/nested\/evil\.jar is in the download but not in the record/);
});

it('refuses a link in the bundle, which is not a file', async () => {
  const d = download();
  fs.symlinkSync(path.join(d.extensionDir, 'selection-ledger.json'), path.join(d.extensionDir, 'link.json'));
  expect(await refusal(d)).toMatch(/holds link\.json, which is not a file/);
});

it('ignores the left-out files whether the bundle carries them or not', async () => {
  const without = download();
  fs.rmSync(path.join(without.extensionDir, 'summary.html'));
  await expect(verifyBuild(without)).resolves.toMatchObject({ record: 'recorded' });

  const withAll = download();
  fs.writeFileSync(path.join(withAll.extensionDir, 'lock-record.json'), '{}');
  fs.writeFileSync(path.join(withAll.extensionDir, 'SUMMARY.txt'), 'x');
  await expect(verifyBuild(withAll)).resolves.toMatchObject({ record: 'recorded' });
  expect([...LEFT_OUT].sort()).toEqual([
    'SUMMARY.txt',
    'build-annex.json',
    'build-statement.json',
    'build-statement.sig',
    'lock-record.json',
    'summary.html',
  ]);
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
  await expect(verifyBuild(download({ configPath: '', configFileName: null }))).resolves.toMatchObject({ record: 'recorded' });
});

it('refuses a record that covers a file this action leaves out, naming it, rather than calling it missing', async () => {
  const d = download();
  const files = { ...(d.record as BuildRecord).files, 'summary.html': sha('<html>job 1</html>') };
  const message = await refusal({ ...d, record: { ...(d.record as BuildRecord), files } });
  expect(message).toMatch(/covers summary\.html, which this action leaves out because it names or signs the build/);
  expect(message).not.toMatch(/missing from the download/);
});

// ---- the advice sources the bundle ships under sources/ ----

const SOURCE = 'sources/orders-prod-extension/com/oteligence/instrumentation/orders/About.java';

/** A download whose bundle carries an extension JAR's source, recorded like any other file. */
function withSources(overrides: Partial<Downloaded> = {}): Downloaded {
  const d = download(overrides);
  const file = path.join(d.extensionDir, ...SOURCE.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'class About {}');
  const record = d.record as BuildRecord;
  return { ...d, record: { ...record, files: { ...record.files, [SOURCE]: sha('class About {}') } } };
}

it('checks the shipped sources like every other recorded file', async () => {
  await expect(verifyBuild(withSources())).resolves.toEqual({ record: 'recorded', signature: 'unsigned' });

  const altered = withSources();
  fs.writeFileSync(path.join(altered.extensionDir, ...SOURCE.split('/')), 'class About { /* changed */ }');
  expect(await refusal(altered)).toMatch(
    new RegExp(`does not match the record of its build: ${SOURCE.replace(/[.]/g, '\\.')} has SHA-256`),
  );

  const missing = withSources();
  fs.rmSync(path.join(missing.extensionDir, 'sources'), { recursive: true });
  expect(await refusal(missing)).toMatch(/About\.java is in the record of the build but missing from the download/);

  const extra = withSources();
  fs.writeFileSync(path.join(extra.extensionDir, 'sources', 'Evil.java'), 'class Evil {}');
  expect(await refusal(extra)).toMatch(/sources\/Evil\.java is in the download but not in the record/);
});

it('leaves out only the top-level names, so a left-out name inside a folder is still checked', async () => {
  const d = withSources();
  fs.writeFileSync(path.join(d.extensionDir, 'sources', 'summary.html'), '<html/>');
  expect(await refusal(d)).toMatch(/sources\/summary\.html is in the download but not in the record/);
});

// ---- the build's signature ----

const KEY = crypto.generateKeyPairSync('ed25519');
const OTHER = crypto.generateKeyPairSync('ed25519');
const LOCK = 'lv_7';

/** The statement the platform signs for a record, as discrete-job-functions' BuildStatement renders it. */
function statementFor(record: BuildRecord, signer: crypto.KeyObject, extra: Record<string, unknown> = {}): Buffer {
  const statement = {
    applicationJars: [...record.applicationJars].sort(),
    bindings: record.bindings,
    files: record.files,
    inputsDigest: record.inputsDigest,
    lockedVersionUid: LOCK,
    schema: 'oteligence.build-statement/1',
    signingKey: keyFingerprint(crypto.createPublicKey(signer)),
    ...extra,
  };
  return Buffer.from(`${JSON.stringify(statement, null, 2)}\n`, 'utf8');
}

/** Writes the statement and its signature into the bundle, as a signing platform ships them. */
function sign(d: Downloaded, signer: crypto.KeyObject = KEY.privateKey, statement?: Buffer): Downloaded {
  const bytes = statement ?? statementFor(d.record as BuildRecord, signer);
  fs.writeFileSync(path.join(d.extensionDir, STATEMENT), bytes);
  fs.writeFileSync(path.join(d.extensionDir, SIGNATURE), crypto.sign(null, bytes, signer));
  return d;
}

const keyed = (o: Partial<Downloaded> = {}) => ({ signingKey: KEY.publicKey, lockedVersionUid: LOCK, ...o });

it('verifies a build signed by the workflow key, sources included', async () => {
  await expect(verifyBuild(sign(withSources(keyed())))).resolves.toEqual({ record: 'recorded', signature: 'verified' });
  await expect(verifyBuild(sign(download(keyed(), { status: 'matched' })))).resolves.toEqual({
    record: 'matched',
    signature: 'verified',
  });
});

it('reports a signed build as not checked when the workflow supplies no key, and an unsigned one as unsigned', async () => {
  await expect(verifyBuild(sign(download()))).resolves.toEqual({ record: 'recorded', signature: 'not-checked' });
  await expect(verifyBuild(download())).resolves.toEqual({ record: 'recorded', signature: 'unsigned' });
  // Not checked means not checked: a broken signature without a key is reported, not refused.
  const broken = sign(download());
  fs.writeFileSync(path.join(broken.extensionDir, SIGNATURE), Buffer.alloc(64));
  await expect(verifyBuild(broken)).resolves.toEqual({ record: 'recorded', signature: 'not-checked' });
});

it('refuses an unsigned build when the workflow supplies a key', async () => {
  expect(await refusal(download(keyed()))).toMatch(/not signed, but this workflow requires a signed build/);
  const statementOnly = sign(download(keyed()));
  fs.rmSync(path.join(statementOnly.extensionDir, SIGNATURE));
  expect(await refusal(statementOnly)).toMatch(/not signed, but this workflow requires a signed build/);
  const signatureOnly = sign(download(keyed()));
  fs.rmSync(path.join(signatureOnly.extensionDir, STATEMENT));
  expect(await refusal(signatureOnly)).toMatch(/not signed, but this workflow requires a signed build/);
});

it('refuses a tampered signature and a tampered statement', async () => {
  const badSignature = sign(download(keyed()));
  const sig = fs.readFileSync(path.join(badSignature.extensionDir, SIGNATURE));
  sig[0] ^= 1;
  fs.writeFileSync(path.join(badSignature.extensionDir, SIGNATURE), sig);
  expect(await refusal(badSignature)).toMatch(/signature does not verify with signing-public-key/);

  const badStatement = sign(download(keyed()));
  const text = fs.readFileSync(path.join(badStatement.extensionDir, STATEMENT), 'utf8');
  fs.writeFileSync(path.join(badStatement.extensionDir, STATEMENT), text.replace(sha('EXT'), sha('SWAPPED')));
  expect(await refusal(badStatement)).toMatch(/signature does not verify with signing-public-key/);
});

it('refuses a build signed by another key, and a statement that only claims the workflow key', async () => {
  const other = sign(download(keyed()), OTHER.privateKey);
  expect(await refusal(other)).toMatch(/signed by another key \(sha256:[0-9a-f]{64}\), not the key this workflow supplies/);

  const d = download(keyed());
  const claimed = statementFor(d.record as BuildRecord, OTHER.privateKey, {
    signingKey: keyFingerprint(KEY.publicKey),
  });
  expect(await refusal(sign(d, OTHER.privateKey, claimed))).toMatch(/signature does not verify/);
});

it('refuses a file swapped together with its record entry, which the record check alone accepts', async () => {
  const d = sign(download(keyed()));
  const swapped = { ...(d.record as BuildRecord), files: { ...(d.record as BuildRecord).files, 'orders-prod-extension.jar': sha('SWAPPED') } };
  fs.writeFileSync(path.join(d.extensionDir, 'orders-prod-extension.jar'), 'SWAPPED');
  // Control: without the key the swap passes, since the server served a record that matches it.
  const unkeyed = sign(download());
  fs.writeFileSync(path.join(unkeyed.extensionDir, 'orders-prod-extension.jar'), 'SWAPPED');
  await expect(verifyBuild({ ...unkeyed, record: { ...(unkeyed.record as BuildRecord), files: swapped.files } })).resolves
    .toEqual({ record: 'recorded', signature: 'not-checked' });
  expect(await refusal({ ...d, record: swapped })).toMatch(/record differs from its signed statement in files/);
});

it('refuses a record whose bindings, JARs or inputs differ from the signed statement', async () => {
  const record = (o: Partial<BuildRecord>) => {
    const d = sign(download(keyed()));
    return { ...d, record: { ...(d.record as BuildRecord), ...o } };
  };
  expect(await refusal(record({ bindings: { orders: UPLOAD } }))).toMatch(/differs from its signed statement in bindings/);
  expect(await refusal(record({ applicationJars: [UPLOAD] }))).toMatch(/differs from its signed statement in applicationJars/);
  expect(await refusal(record({ inputsDigest: sha('other') }))).toMatch(/differs from its signed statement in inputsDigest/);
  // The JARs' order is not part of what is signed.
  await expect(verifyBuild(record({ applicationJars: [UPLOAD, PEER] }))).resolves.toMatchObject({ signature: 'verified' });
});

it('refuses a signed build of another lock', async () => {
  expect(await refusal(sign(download(keyed({ lockedVersionUid: 'lv_6' }))))).toMatch(
    /made from lock version lv_7, not lv_6, the lock this run built/,
  );
});

it('refuses a signed statement that is not JSON, or has a schema it does not know', async () => {
  expect(await refusal(sign(download(keyed()), KEY.privateKey, Buffer.from('not json')))).toMatch(/is not a JSON object/);
  const d = download(keyed());
  expect(await refusal(sign(d, KEY.privateKey, statementFor(d.record as BuildRecord, KEY.privateKey, { schema: 'x/2' }))))
    .toMatch(/schema this action does not know \("x\/2"\)/);
});

it("refuses a build whose record reads differs before reading its signature, as a platform fault", async () => {
  expect(await refusal(sign(download(keyed(), { status: 'differs' })))).toMatch(/platform could not reproduce this build/);
});

it('names the key as the platform does: the SHA-256 of its SubjectPublicKeyInfo', () => {
  const spki = KEY.publicKey.export({ type: 'spki', format: 'der' });
  expect(keyFingerprint(KEY.publicKey)).toBe(`sha256:${crypto.createHash('sha256').update(spki).digest('hex')}`);
});
