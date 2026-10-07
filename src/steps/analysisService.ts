import * as core from '@actions/core';
import { MaestroApi } from '../api';

interface PreviewBody {
  data?: { previewJsonUrl?: string };
}

/**
 * The analysis's names for the uploaded JAR, which key its javaagent.config and can differ from its registered
 * name. Empty when the upload has no artifact uid or the preview cannot be read.
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
    // A second JAR declaring the same application name is keyed name::artifactUid.
    return mine?.name ? [`${mine.name}::${artifactUid}`, mine.name] : [];
  } catch (err) {
    core.debug(`Could not read the analysis preview: ${err}`);
    return [];
  }
}
