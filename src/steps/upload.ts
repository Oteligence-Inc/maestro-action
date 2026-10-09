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
 * v0: exactly one JAR per invocation (monorepo multi-JAR deferred — Build Spec §12).
 */
export async function uploadJar(api: MaestroApi, inputs: Inputs, cfg: ResolvedConfig): Promise<UploadResult> {
  const matches = await glob(inputs.jarsGlob, { nodir: true, windowsPathsNoEscape: true });
  if (matches.length === 0) throw new UserError(`No JAR matched "${inputs.jarsGlob}". Did "mvn package" run first?`);
  if (matches.length > 1) {
    throw new UserError(
      `"${inputs.jarsGlob}" matched ${matches.length} files. v0 expects exactly one JAR per invocation: ${matches.join(', ')}`,
    );
  }
  const jarPath = matches[0];
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
