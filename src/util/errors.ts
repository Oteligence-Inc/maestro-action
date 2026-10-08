// Typed errors with user-facing messages (Build Spec §8). Server stack traces and
// response bodies are never echoed — only safe, actionable text.

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    /** A short, already-sanitised server message (never the raw body). */
    public readonly serverMessage?: string,
    /** Correlation/trace id the gateway emitted, so the CI log can be matched to a server trace. */
    public readonly traceId?: string,
  ) {
    super(
      `HTTP ${status} on ${path}${serverMessage ? `: ${serverMessage}` : ''}` +
        `${traceId ? ` [trace: ${traceId}]` : ''}`,
    );
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
  constructor(body?: { status?: string; billing_url?: string }, traceId?: string) {
    const status = typeof body?.status === 'string' ? body.status : undefined;
    // Only cite a billing URL the server actually provided — never hardcode a host (a run against a
    // dev/self-hosted backend must not be pointed at prod billing). Fall back to a host-agnostic hint.
    const url =
      typeof body?.billing_url === 'string' && body.billing_url ? body.billing_url : undefined;
    const statusClause = status ? ` (status: ${status})` : '';
    const urlClause = url
      ? ` — update your card at ${url}`
      : ' — restore billing from the Maestro dashboard';
    // Surface the server's correlation/trace id so a blocked CI run can be matched to the server-side
    // trace in one step (Build Spec §8 diagnosability — guards the 27 Jul "bare status code" incident).
    const traceClause = traceId ? ` [trace: ${traceId}]` : '';
    super(
      // Thrown from expectOk on ANY gated call (token exchange, resolve-config, generate, deploy), so
      // keep the wording operation-agnostic.
      `Maestro subscription is not active for this tenant${statusClause}. ` +
        `This Maestro operation is blocked until billing is restored${urlClause}${traceClause}`,
    );
    this.name = 'SubscriptionInactiveError';
  }
}

/**
 * The requested service is not part of the target env's locked config — it was removed from the project
 * (or the {@code service:} input is wrong). A {@link UserError} (exits non-zero with a clear message) —
 * unless the workflow sets {@code skip-on-removed-service}, in which case index.ts turns it into a
 * graceful no-op (generated=false, exit 0). Detected EARLY (before upload/analyse/build) so a removed
 * service never re-runs the pipeline, re-registers, or re-bills; the register step's 404 is the live
 * backstop.
 */
export class RemovedServiceError extends UserError {
  constructor(service: string, environment: string, registered: string[] = []) {
    const known = registered.length ? ` Registered in "${environment}": ${[...registered].sort().join(', ')}.` : '';
    super(
      `Service "${service}" is not part of "${environment}"'s locked config. It looks like it was ` +
        'removed from the project. Re-add it via the Maestro wizard (Step 1) to instrument it, or set the ' +
        '"service" input to the name Maestro gives it.' + known,
    );
    this.name = 'RemovedServiceError';
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
    if (err.serverMessage) return `${err.message}`;
    const trace = err.traceId ? ` [trace: ${err.traceId}]` : '';
    return `Maestro API error (HTTP ${err.status})${trace}. Please retry; if it persists, contact support.`;
  }
  if (err instanceof Error) {
    // Generic — keep the message, drop the stack.
    return err.message;
  }
  return 'Unknown error';
}
