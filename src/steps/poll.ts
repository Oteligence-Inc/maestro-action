import * as core from '@actions/core';
import { MaestroApi, expectOk } from '../api';
import { JobFailed, JobTimeout } from '../util/errors';

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'NO_ASSET']);

export interface PollOpts {
  timeoutSeconds: number;
  initialWaitMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * [7] Poll GET /jobs/{id}/status until terminal. Logs only on status change.
 * COMPLETED → returns; FAILED/NO_ASSET → JobFailed; exhausted → JobTimeout.
 */
export async function pollJob(api: MaestroApi, jobId: string, opts: PollOpts): Promise<string> {
  const sleep = opts.sleep ?? defaultSleep;
  const initialWaitMs = opts.initialWaitMs ?? 2000;
  const intervalMs = opts.intervalMs ?? 3000;
  const maxAttempts = Math.max(1, Math.floor((opts.timeoutSeconds * 1000) / intervalMs));

  await sleep(initialWaitMs);
  let lastStatus = '';
  for (let i = 0; i < maxAttempts; i++) {
    const res = await api.get<{ data?: { status?: string }; status?: string }>(
      `/api/job-manager/jobs/${encodeURIComponent(jobId)}/status`,
    );
    expectOk(res, `/jobs/${jobId}/status`);
    const status = (res.body?.data?.status as string) || '';
    if (status && status !== lastStatus) {
      core.info(`Job ${jobId}: ${status}`);
      lastStatus = status;
    }
    if (TERMINAL.has(status)) {
      if (status === 'COMPLETED') return status;
      throw new JobFailed(jobId, status);
    }
    await sleep(intervalMs);
  }
  throw new JobTimeout(jobId, opts.timeoutSeconds);
}
