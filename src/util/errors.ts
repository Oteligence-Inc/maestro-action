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
