import * as fs from 'fs';
import * as path from 'path';
import { BuildRecord } from '../types';
import { UserError } from '../util/errors';
import { sha256File } from '../util/sha';

/**
 * The bundle files a build record leaves out, because they name the build job, the project or the lock version.
 * Mirrors discrete-job-functions' `BundleFiles.UNCOVERED`; carried here rather than taken from the server, so a
 * server cannot switch a file's check off by listing it.
 */
export const LEFT_OUT = new Set(['build-annex.json', 'lock-record.json', 'summary.html', 'SUMMARY.txt']);

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
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Checks every downloaded file against the record of its build's inputs, before anything registers or deploys it.
 * Returns the record's status; refuses, and deletes the downloaded files, on anything it cannot vouch for.
 */
export async function verifyBuild(d: Downloaded): Promise<'recorded' | 'matched'> {
  try {
    return await check(d);
  } catch (err) {
    for (const p of [d.extensionDir, d.configPath, d.collectorConfigPath]) {
      if (p) fs.rmSync(p, { recursive: true, force: true });
    }
    throw err;
  }
}

async function check(d: Downloaded): Promise<'recorded' | 'matched'> {
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
  for (const entry of fs.readdirSync(d.extensionDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      refuse(`The download holds ${entry.name}, which is not a file; a build bundle holds files only.`);
    }
    if (LEFT_OUT.has(entry.name)) continue;
    const expected = record.files[entry.name];
    if (expected === undefined) {
      refuse(`${entry.name} is in the download but not in the record of its build.`);
    }
    await expectHash(path.join(d.extensionDir, entry.name), entry.name, expected);
    seen.add(entry.name);
  }
  for (const name of Object.keys(record.files)) {
    if (LEFT_OUT.has(name)) {
      refuse(`The build's record covers ${name}, which this action leaves out because it names the build. Update the action.`);
    }
    if (!seen.has(name)) refuse(`${name} is in the record of the build but missing from the download.`);
  }
  await expectConfig(record, d.configPath, d.configFileName, 'javaagent config');
  await expectConfig(record, d.collectorConfigPath, d.collectorConfigFileName, 'collector config');
  return record.status;
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
      ([name, hash]) => name.length > 0 && !name.includes('/') && typeof hash === 'string' && SHA256.test(hash),
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
