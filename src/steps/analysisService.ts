import * as core from '@actions/core';
import { MaestroApi } from '../api';

interface PreviewBody {
  data?: { previewJsonUrl?: string };
}

/**
 * The analysis's names for the uploaded JAR: its key, then its display name when that differs (the key adds
 * `@<8 hex>` when uploads share a name). Either can key its javaagent.config. Empty when the upload has no
 * artifact uid or the preview cannot be read.
 */
export async function analysisServiceNames(
  api: MaestroApi,
  analysisJobId: string,
  artifactUid: string | null,
): Promise<string[]> {
  if (!artifactUid) return [];
  try {
    const res = await api.get<PreviewBody>(`/api/job-manager/jobs/${encodeURIComponent(analysisJobId)}/preview`);
    const url = res.statusCode < 400 ? res.body?.data?.previewJsonUrl : undefined;
    if (!url) return [];
    const preview = JSON.parse((await api.getSignedBytes(url)).toString('utf8'));
    const mine = (preview.services ?? []).find((s: { jarUid?: string }) => s?.jarUid === artifactUid);
    // Uploads sharing a name are keyed name@<8 hex>; a preview from an older engine carries no key.
    const names = [mine?.serviceKey, mine?.name].filter((n): n is string => typeof n === 'string' && n !== '');
    return [...new Set(names)];
  } catch (err) {
    core.debug(`Could not read the analysis preview: ${err}`);
    return [];
  }
}
