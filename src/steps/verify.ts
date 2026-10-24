import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BuildRecord } from '../types';
import { UserError } from '../util/errors';
import { sha256File } from '../util/sha';

/** The signed statement of a build's covered files, and the raw Ed25519 signature over it. */
export const STATEMENT = 'build-statement.json';
export const SIGNATURE = 'build-statement.sig';
export const STATEMENT_SCHEMA = 'oteligence.build-statement/1';

/**
 * The bundle files a build record leaves out, because they name the build job, the project or the lock version, or
 * sign the covered files. Mirrors discrete-job-functions' `BundleFiles.UNCOVERED`; carried here rather than taken
 * from the server, so a server cannot switch a file's check off by listing it.
 */
export const LEFT_OUT = new Set([
  'build-annex.json',
  'lock-record.json',
  'summary.html',
  'SUMMARY.txt',
  STATEMENT,
  SIGNATURE,
]);

/** The build's files are not the files of its record, or the record cannot vouch for them. */
export class BuildVerificationError extends UserError {}

export interface Downloaded {
  /** `undefined`: the server's response has no `buildRecord` at all; `null`: it has none for this build. */
  record: BuildRecord | null | undefined;
  uploadSha: string;
  /** The analysis's key for the uploaded JAR, which the record's `bindings` are keyed by. */
  serviceKey: string | undefined;
  extensionDir: string;
  configPath: string;
  configFileName: string | null;
  collectorConfigPath: string;
  collectorConfigFileName: string | null;
  /** The workflow's `signing-public-key`; when set, the build must carry a statement this key signed. */
  signingKey?: crypto.KeyObject | null;
  /** The lock version this run built; a signed statement must name it. */
  lockedVersionUid?: string;
}

/** `verified`: signed by the workflow's key; `not-checked`: signed, but the workflow gave no key; `unsigned`. */
export type SignatureStatus = 'verified' | 'not-checked' | 'unsigned';

export interface Verified {
  record: 'recorded' | 'matched';
  signature: SignatureStatus;
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Checks every downloaded file against the record of its build's inputs, and the build's signature when the workflow
 * supplies a key, before anything registers or deploys it. Refuses, and deletes the downloaded files, on anything it
 * cannot vouch for.
 */
export async function verifyBuild(d: Downloaded): Promise<Verified> {
  try {
    return await check(d);
  } catch (err) {
    for (const p of [d.extensionDir, d.configPath, d.collectorConfigPath]) {
      if (p) fs.rmSync(p, { recursive: true, force: true });
    }
    throw err;
  }
}

async function check(d: Downloaded): Promise<Verified> {
  const record = d.record;
  if (record === undefined) {
    refuse('This Maestro server does not record its builds, so the download cannot be verified. Upgrade the server.');
  }
  if (record === null) {
    refuse("The build has no record to verify its files against. Run the job again; contact support if it persists.");
  }
  if (typeof record === 'object' && !Object.prototype.hasOwnProperty.call(record, 'bindings')) {
    refuse(
      'This Maestro server does not record which upload it built each service from, so the download cannot be verified. ' +
        'Upgrade the server.',
    );
  }
  if (!wellFormed(record)) {
    refuse("The build's record is malformed, so the download cannot be verified.");
  }
  if (record.status === 'differs') {
    refuse(
      'The platform could not reproduce this build: its files differ from the record of the same inputs, written by ' +
        `build ${record.firstJobId}. Run the job again; contact support if it keeps happening.`,
    );
  }
  if (record.status !== 'recorded' && record.status !== 'matched') {
    refuse(`The build's record has a status this action does not know ("${record.status}"). Update the action.`);
  }
  const signature = checkSignature(d, record);
  if (record.applicationJars.length === 0) {
    refuse("The build's record names no application JAR, so it cannot show the build read the uploaded one.");
  }
  if (!record.applicationJars.includes(d.uploadSha)) {
    refuse(`The build's record does not name the JAR this run uploaded (SHA-256 ${d.uploadSha}).`);
  }
  if (!d.serviceKey) {
    refuse('The Action could not name the service the analysis made of the uploaded JAR, so it cannot check the build built it.');
  }
  const bound = Object.prototype.hasOwnProperty.call(record.bindings, d.serviceKey) ? record.bindings[d.serviceKey] : undefined;
  if (bound === undefined) {
    refuse(`The build's record binds no JAR to ${d.serviceKey}, the service the analysis made of the uploaded JAR.`);
  }
  if (bound !== d.uploadSha) {
    refuse(`The build bound ${d.serviceKey} to another JAR (SHA-256 ${bound}), not the one this run uploaded (SHA-256 ${d.uploadSha}).`);
  }

  const seen = new Set<string>();
  for (const name of bundleFiles(d.extensionDir)) {
    if (LEFT_OUT.has(name)) continue;
    const expected = Object.prototype.hasOwnProperty.call(record.files, name) ? record.files[name] : undefined;
    if (expected === undefined) {
      refuse(`${name} is in the download but not in the record of its build.`);
    }
    await expectHash(path.join(d.extensionDir, ...name.split('/')), name, expected);
    seen.add(name);
  }
  for (const name of Object.keys(record.files)) {
    if (LEFT_OUT.has(name)) {
      refuse(`The build's record covers ${name}, which this action leaves out because it names or signs the build. Update the action.`);
    }
    if (!seen.has(name)) refuse(`${name} is in the record of the build but missing from the download.`);
  }
  await expectConfig(record, d.configPath, d.configFileName, 'javaagent config');
  await expectConfig(record, d.collectorConfigPath, d.collectorConfigFileName, 'collector config');
  return { record: record.status, signature };
}

/**
 * Every file the bundle extracted to, by its `/`-separated path. Folders are walked, since the bundle ships each
 * extension JAR's source under `sources/`; anything that is neither a file nor a folder, and a folder with nothing in
 * it, is refused.
 */
function bundleFiles(root: string, prefix = ''): string[] {
  const names: string[] = [];
  const entries = fs.readdirSync(path.join(root, ...prefix.split('/').filter(Boolean)), { withFileTypes: true });
  if (prefix && entries.length === 0) {
    refuse(`The download holds ${prefix}, a folder with nothing in it; a build bundle holds files only.`);
  }
  for (const entry of entries) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) {
      names.push(...bundleFiles(root, `${name}/`));
    } else if (entry.isFile()) {
      names.push(name);
    } else {
      refuse(`The download holds ${name}, which is not a file; a build bundle holds files only.`);
    }
  }
  return names;
}

/**
 * With a workflow key: the bundle must carry a statement that key signed, naming this run's lock and exactly the
 * record the remaining checks then hold the files to. Without one, the signature is reported, not checked.
 */
function checkSignature(d: Downloaded, record: BuildRecord): SignatureStatus {
  const statementPath = path.join(d.extensionDir, STATEMENT);
  const signaturePath = path.join(d.extensionDir, SIGNATURE);
  const hasStatement = isFile(statementPath);
  const hasSignature = isFile(signaturePath);
  if (!d.signingKey) {
    return hasStatement || hasSignature ? 'not-checked' : 'unsigned';
  }
  if (!hasStatement || !hasSignature) {
    refuse(
      'The build is not signed, but this workflow requires a signed build (signing-public-key is set). ' +
        'The Maestro platform that built it holds no signing key; ask its operator to set one.',
    );
  }
  const statementBytes = fs.readFileSync(statementPath);
  const signatureBytes = fs.readFileSync(signaturePath);
  let statement: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(statementBytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    statement = parsed as Record<string, unknown>;
  } catch {
    refuse(`The build's ${STATEMENT} is not a JSON object, so its signature cannot vouch for the download.`);
  }
  const expectedKey = keyFingerprint(d.signingKey);
  if (statement.signingKey !== expectedKey) {
    refuse(
      `The build is signed by another key (${String(statement.signingKey)}), not the key this workflow supplies ` +
        `in signing-public-key (${expectedKey}).`,
    );
  }
  if (!crypto.verify(null, statementBytes, d.signingKey, signatureBytes)) {
    refuse(`The build's signature does not verify with signing-public-key: ${STATEMENT} or ${SIGNATURE} was altered.`);
  }
  if (statement.schema !== STATEMENT_SCHEMA) {
    refuse(`The build's signed statement has a schema this action does not know ("${String(statement.schema)}"). Update the action.`);
  }
  if (d.lockedVersionUid !== undefined && statement.lockedVersionUid !== d.lockedVersionUid) {
    refuse(
      `The signed build was made from lock version ${String(statement.lockedVersionUid)}, not ${d.lockedVersionUid}, ` +
        'the lock this run built.',
    );
  }
  const signed = {
    inputsDigest: statement.inputsDigest,
    applicationJars: Array.isArray(statement.applicationJars) ? [...statement.applicationJars].sort() : statement.applicationJars,
    bindings: sortedObject(statement.bindings),
    files: sortedObject(statement.files),
  };
  const served = {
    inputsDigest: record.inputsDigest,
    applicationJars: [...record.applicationJars].sort(),
    bindings: sortedObject(record.bindings),
    files: sortedObject(record.files),
  };
  for (const field of ['inputsDigest', 'applicationJars', 'bindings', 'files'] as const) {
    if (JSON.stringify(signed[field]) !== JSON.stringify(served[field])) {
      refuse(`The build's record differs from its signed statement in ${field}, so the record cannot be trusted.`);
    }
  }
  return 'verified';
}

/** `sha256:` and the hex SHA-256 of the key's X.509 SubjectPublicKeyInfo, as the build names its key. */
export function keyFingerprint(key: crypto.KeyObject): string {
  const spki = key.export({ type: 'spki', format: 'der' });
  return `sha256:${crypto.createHash('sha256').update(spki).digest('hex')}`;
}

function sortedObject(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function isFile(p: string): boolean {
  try {
    return fs.lstatSync(p).isFile();
  } catch {
    return false;
  }
}

async function expectConfig(record: BuildRecord, file: string, name: string | null, what: string): Promise<void> {
  if (!file) return;
  if (!name || record.files[name] === undefined) {
    refuse(`The downloaded ${what} is not in the record of its build.`);
  }
  await expectHash(file, name, record.files[name]);
}

async function expectHash(file: string, name: string, expected: string): Promise<void> {
  const actual = await sha256File(file);
  if (actual !== expected) {
    refuse(`The download does not match the record of its build: ${name} has SHA-256 ${actual}, recorded ${expected}.`);
  }
}

/** A bundle path: `/`-separated, relative, and naming no parent, current or empty segment. */
function safeName(name: string): boolean {
  if (name.length === 0 || name.startsWith('/') || name.includes('\\') || name.includes('\0')) return false;
  return name.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function wellFormed(r: unknown): r is BuildRecord {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.status === 'string' &&
    typeof o.inputsDigest === 'string' &&
    Array.isArray(o.applicationJars) &&
    o.applicationJars.every((s) => typeof s === 'string' && SHA256.test(s)) &&
    !!o.files &&
    typeof o.files === 'object' &&
    !Array.isArray(o.files) &&
    Object.entries(o.files as Record<string, unknown>).every(
      ([name, hash]) => safeName(name) && typeof hash === 'string' && SHA256.test(hash),
    ) &&
    !!o.bindings &&
    typeof o.bindings === 'object' &&
    !Array.isArray(o.bindings) &&
    Object.entries(o.bindings as Record<string, unknown>).every(
      ([key, hash]) => key.length > 0 && typeof hash === 'string' && SHA256.test(hash),
    )
  );
}

function refuse(message: string): never {
  throw new BuildVerificationError(message);
}
