import * as core from '@actions/core';
import { MaestroApi } from '../api';

interface PreviewBody {
  data?: { previewJsonUrl?: string };
}

/** What the analysis says about the uploaded JAR. */
export interface AnalysisOfUpload {
  /** Its key, then its display name when that differs (the key adds `@<8 hex>` when uploads share a name). */
  names: string[];
  /** One line per kind of class or library the analysis left out of the JAR. */
  notices: string[];
}

const NOTHING: AnalysisOfUpload = { names: [], notices: [] };

/**
 * The analysis's names for the uploaded JAR, either of which can key its javaagent.config, and what it left out
 * of it. Empty when the upload has no artifact uid or the preview cannot be read.
 */
export async function readAnalysisOfUpload(
  api: MaestroApi,
  analysisJobId: string,
  artifactUid: string | null,
): Promise<AnalysisOfUpload> {
  if (!artifactUid) return NOTHING;
  try {
    const res = await api.get<PreviewBody>(`/api/job-manager/jobs/${encodeURIComponent(analysisJobId)}/preview`);
    const url = res.statusCode < 400 ? res.body?.data?.previewJsonUrl : undefined;
    if (!url) return NOTHING;
    const preview = JSON.parse((await api.getSignedBytes(url)).toString('utf8'));
    const mine = (preview.services ?? []).find((s: { jarUid?: string }) => s?.jarUid === artifactUid);
    // Uploads sharing a name are keyed name@<8 hex>; a preview from an older engine carries no key.
    const names = [mine?.serviceKey, mine?.name].filter((n): n is string => typeof n === 'string' && n !== '');
    const notices = Array.isArray(mine?.notices)
      ? mine.notices.filter((n: unknown): n is string => typeof n === 'string' && n !== '')
      : [];
    return { names: [...new Set(names)], notices };
  } catch (err) {
    core.debug(`Could not read the analysis preview: ${err}`);
    return NOTHING;
  }
}
