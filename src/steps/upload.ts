import * as core from '@actions/core';
import * as fs from 'fs';
import { glob } from 'glob';
import { MaestroApi, expectOk } from '../api';
import { BatchUploadResponse, Inputs, ResolvedConfig, UploadResult } from '../types';
import { sha256File } from '../util/sha';
import { UserError } from '../util/errors';

/**
 * [3-5] Resolve the jars glob, then init a batch upload that uploads THIS service's
 * (changed) JAR bytes and references the env's other registered services (referenceExistingOnly)
 * so the server can build the env-wide cross-service graph from one upload. Then PUT the bytes
 * (if mustUpload) and confirm.
 *
 * A peer is named by the artifactUid the lock froze, which file-service resolves in any of the
 * org's projects and refuses with a 404 when it is gone. A lock entry with no uid is matched by
 * its SHA in this project and skipped on a miss.
 * One JAR per invocation: see pickJar for a glob that matches several.
 */
export async function uploadJar(api: MaestroApi, inputs: Inputs, cfg: ResolvedConfig): Promise<UploadResult> {
  const matches = (await glob(inputs.jarsGlob, { nodir: true, windowsPathsNoEscape: true })).sort();
  if (matches.length === 0) throw new UserError(`No JAR matched "${inputs.jarsGlob}". Did "mvn package" run first?`);
  const { jar: jarPath, setAside } = pickJar(matches, inputs.jarsGlob);
  if (setAside.length > 0) {
    core.info(`Uploading ${jarPath}; set aside ${setAside.join(', ')}, which a build leaves beside the runnable JAR.`);
  }
  const fileName = jarPath.split(/[\\/]/).pop() as string;
  const sizeBytes = fs.statSync(jarPath).size;
  const sha = await sha256File(jarPath);
  core.info(`JAR ${fileName} sha256=${sha}`);

  // changed jar (upload) + peers from the locked config (reference by SHA)
  const files: Array<{
    fileName: string;
    fileSizeInBytes: number;
    sha256?: string;
    referenceExistingOnly: boolean;
    artifactUid?: string;
  }> = [{ fileName, fileSizeInBytes: sizeBytes, sha256: sha, referenceExistingOnly: false }];
  const registered = cfg.locked.registeredJars ?? {};
  const own = registered[inputs.service];
  for (const [peerService, info] of Object.entries(registered)) {
    if (peerService === inputs.service || (!info?.sha && !info?.artifactUid)) continue;
    // A leftover registration of this service under another name is its previous JAR, not a peer.
    if (own?.artifactUid && info.artifactUid === own.artifactUid) continue;
    files.push({
      fileName: `${peerService}.jar`,
      fileSizeInBytes: 1,
      ...(info.sha ? { sha256: info.sha } : {}),
      referenceExistingOnly: true,
      ...(info.artifactUid ? { artifactUid: info.artifactUid } : {}),
    });
  }

  const batchRes = await api.post<BatchUploadResponse>('/api/file/artifact/upload/batch', {
    files,
    projectId: cfg.projectUid,
  });
  expectOk(batchRes, '/api/file/artifact/upload/batch');
  const batch = batchRes.body;
  if (!batch?.artifactGroupUid || !Array.isArray(batch.uploads)) {
    throw new UserError('Batch upload init returned no artifact group.');
  }

  // uploads[i] aligns by index with files[i]; index 0 is our changed jar.
  const mine = batch.uploads[0];
  let mustUpload = false;
  if (mine?.preSignedUrl) {
    mustUpload = true;
    const bytes = fs.readFileSync(jarPath);
    await api.putBytes(mine.preSignedUrl, bytes);
    const statusRes = await api.put('/api/file/artifact/status', {
      artifactId: mine.artifactUid,
      operation: 'UPLOAD',
      status: 'UPLOADED',
      checksum: sha,
    });
    expectOk(statusRes, '/api/file/artifact/status');
    core.info('Uploaded JAR bytes and marked UPLOADED.');
  } else {
    core.info('JAR already in storage (SHA cache hit) — skipped byte upload.');
  }

  return {
    artifactGroupUid: batch.artifactGroupUid,
    sha,
    artifactUid: mine?.artifactUid ?? null,
    fileName,
    sizeBytes,
    mustUpload,
  };
}

/** File names a build leaves beside the runnable JAR or WAR: Maven shade's original, Gradle Boot's plain archive, and
 * the sources, javadoc and test JARs. */
const BESIDE_THE_JAR_NAMES = 'original-*, *-plain, *-sources, *-javadoc and *-tests files';
const BESIDE_THE_JAR = [/^original-.+\.(jar|war)$/, /-plain\.(jar|war)$/, /-sources\.jar$/, /-javadoc\.jar$/, /-tests\.jar$/];

/**
 * The one file to upload from the glob's matches. A single match is uploaded whatever its name; of several, the files a
 * build leaves beside the runnable JAR are set aside, and exactly one must remain.
 */
export function pickJar(matches: string[], jarsGlob = 'jars'): { jar: string; setAside: string[] } {
  if (matches.length === 1) return { jar: matches[0], setAside: [] };
  const name = (p: string) => p.split(/[\\/]/).pop() as string;
  const setAside = matches.filter((m) => BESIDE_THE_JAR.some((re) => re.test(name(m))));
  const left = matches.filter((m) => !setAside.includes(m));
  if (left.length !== 1) {
    throw new UserError(
      `"${jarsGlob}" matched ${matches.length} files and ${left.length === 0 ? 'none is a runnable JAR' : `${left.length} are runnable JARs`} ` +
        `once ${BESIDE_THE_JAR_NAMES} are set aside: ${matches.join(', ')}. Narrow the glob to one file.`,
    );
  }
  return { jar: left[0], setAside };
}

