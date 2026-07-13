// Typed errors with user-facing messages (Build Spec §8). Server stack traces and
// response bodies are never echoed — only safe, actionable text.

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    /** A short, already-sanitised server message (never the raw body). */
    public readonly serverMessage?: string,
  ) {
    super(`HTTP ${status} on ${path}${serverMessage ? `: ${serverMessage}` : ''}`);
    this.name = 'HttpError';
  }
}

/** A fatal, user-fixable condition with a friendly message (no retry). */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

/**
 * The tenant's Maestro subscription is not active (HTTP 402 `subscription_inactive`). Fatal and
 * user-fixable — the trial ended or payment lapsed. Surfaces the tenant status and the billing URL so
 * the run log tells the user exactly how to restore access. A {@link UserError} so it exits non-zero
 * without retry.
 */
export class SubscriptionInactiveError extends UserError {
  constructor(body?: { status?: string; billing_url?: string }) {
    const status = typeof body?.status === 'string' ? body.status : undefined;
    const url =
      typeof body?.billing_url === 'string' && body.billing_url
        ? body.billing_url
        : 'https://app.oteligence.com/billing';
    const statusClause = status ? ` (status: ${status})` : '';
    super(
      `Maestro subscription is not active for this tenant${statusClause}. ` +
        `Generate/deploy is blocked until billing is restored — update your card at ${url}`,
    );
    this.name = 'SubscriptionInactiveError';
  }
}

/** A Maestro job ended in a non-COMPLETED terminal state. */
export class JobFailed extends Error {
  constructor(jobId: string, status: string) {
    super(`Maestro job ${jobId} ended with status ${status}. Check the run at the Maestro dashboard.`);
    this.name = 'JobFailed';
  }
}

export class JobTimeout extends Error {
  constructor(jobId: string, seconds: number) {
    super(`Job ${jobId} still running after ${seconds}s. Check status at the Maestro dashboard and re-run, or raise timeout-seconds.`);
    this.name = 'JobTimeout';
  }
}

/**
 * Maps a raw error to the safe, user-facing message that should reach the workflow log.
 * Build Spec §8 catalogue — never leak response bodies or stack traces.
 */
export function formatError(err: unknown): string {
  if (err instanceof UserError || err instanceof JobFailed || err instanceof JobTimeout) {
    return err.message;
  }
  if (err instanceof HttpError) {
    return err.serverMessage ? `${err.message}` : `Maestro API error (HTTP ${err.status}). Please retry; if it persists, contact support.`;
  }
  if (err instanceof Error) {
    // Generic — keep the message, drop the stack.
    return err.message;
  }
  return 'Unknown error';
}
