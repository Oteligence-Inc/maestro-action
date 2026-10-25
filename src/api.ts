import { HttpClient } from '@actions/http-client';
import { Readable } from 'stream';
import { HttpError, KeyScopeError, ReaderKeyError, SubscriptionInactiveError, UserError } from './util/errors';
import { withRetry } from './util/retry';

export interface ApiResponse<T = any> {
  statusCode: number;
  body: T;
}

/**
 * Thin HTTP client for the Maestro API. Sends only `Authorization: Bearer <jwt>` —
 * the gateway injects the signed X-Context-Envelope downstream; the Action never
 * builds it. Transient failures (5xx / 429 / 408) retry with backoff; 4xx returns
 * normally so callers can branch on 404 / 409. Response bodies are never logged.
 */
export class MaestroApi {
  private readonly client = new HttpClient('maestro-action/0.1', [], { allowRetries: false });
  // A followed redirect would send the upload's stream again after it was read; a presigned PUT never moves.
  private readonly uploadClient = new HttpClient('maestro-action/0.1', [], {
    allowRetries: false,
    allowRedirects: false,
  });
  private token: string | null = null;

  constructor(private readonly baseUrl: string) {}

  setToken(token: string): void {
    this.token = token;
  }

  get<T = any>(path: string): Promise<ApiResponse<T>> {
    return this.send<T>('GET', path);
  }
  post<T = any>(path: string, body: unknown): Promise<ApiResponse<T>> {
    return this.send<T>('POST', path, body);
  }
  put<T = any>(path: string, body: unknown): Promise<ApiResponse<T>> {
    return this.send<T>('PUT', path, body);
  }

  /** Upload raw bytes to a presigned S3 URL — NO auth header (the URL is the credential). */
  async putBytes(presignedUrl: string, bytes: Buffer): Promise<void> {
    requireHttps(presignedUrl);
    await withRetry(async () => {
      const res = await this.uploadClient.request('PUT', presignedUrl, Readable.from(bytes), {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(bytes.length),
      });
      const status = res.message.statusCode ?? 0;
      await res.readBody(); // drain
      if (status >= 300 && status < 400) {
        throw new UserError(
          `Maestro storage answered the upload with a redirect (HTTP ${status}); the Action does not follow one.`,
        );
      }
      if (status >= 400) {
        // 5xx/429/408 are retried by withRetry; other 4xx fail fast.
        throw new HttpError(status, '<presigned-s3-url>');
      }
    });
  }

  /** GET a signed URL and return the raw body as a Buffer (zip bundle download). */
  async getSignedBytes(signedUrl: string): Promise<Buffer> {
    requireHttps(signedUrl);
    return withRetry(async () => {
      const res = await this.client.get(signedUrl).catch(namedDowngrade);
      const status = res.message.statusCode ?? 0;
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        res.message.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
        res.message.on('end', () => resolve());
        res.message.on('error', reject);
      });
      if (status >= 400) throw new HttpError(status, '<signed-url>');
      return Buffer.concat(chunks);
    });
  }

  private send<T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
    return withRetry(async () => {
      const data = body != null ? JSON.stringify(body) : '';
      const res = await this.client.request(method, this.url(path), data, this.headers(body != null));
      const status = res.message.statusCode ?? 0;
      const text = await res.readBody();
      if (status >= 500 || status === 429 || status === 408) {
        // transient → withRetry retries
        throw new HttpError(status, path, safeMessage(text));
      }
      return { statusCode: status, body: parse<T>(text) };
    });
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private headers(hasBody: boolean): Record<string, string> {
    const h: Record<string, string> = { 'X-Maestro-Client': 'github-action' };
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    if (hasBody) h['Content-Type'] = 'application/json';
    return h;
  }
}

/** Throw a friendly HttpError carrying ONLY the server's short `message` (never the raw body). */
export function expectOk(res: ApiResponse, path: string): void {
  if (res.statusCode >= 400) {
    // Pull the gateway's correlation/trace id (if any) so it reaches the CI log on EVERY failure —
    // not just billing ones. Guards the 27 Jul incident (a bare status code with no trace).
    const traceId = traceOf(res.body);
    // v7: a 402 subscription_inactive is a distinct, user-fixable billing state — surface the tenant
    // status + billing URL rather than a generic "HTTP 402". Every gated call (auth token exchange,
    // resolve-config, generate, ...) routes through expectOk, so this covers them all. Two wire shapes:
    // auth returns { code, status, billing_url } FLAT; job-manager wraps it under an APIResponse `data`.
    if (res.statusCode === 402) {
      const nested = res.body?.data;
      const gate =
        nested && typeof nested === 'object' && nested.code ? nested : res.body;
      if (gate?.code === 'subscription_inactive') {
        throw new SubscriptionInactiveError(gate, traceId);
      }
    }
    // job-manager nests the code under data; file-service sends it at the top level.
    if (res.statusCode === 403) {
      const code = res.body?.data?.code ?? res.body?.code;
      if (code === 'reader_read_only') {
        throw new ReaderKeyError(traceId);
      }
      if (code === 'key_scope') {
        throw new KeyScopeError(messageOf(res.body), traceId);
      }
    }
    throw new HttpError(res.statusCode, path, messageOf(res.body), traceId);
  }
}

function parse<T>(text: string): T {
  if (!text) return undefined as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as unknown as T;
  }
}

function safeMessage(text: string): string | undefined {
  return messageOf(parse<any>(text));
}

/**
 * Extract a short, safe human message from a parsed body — never the whole body. Reads `message`
 * first, then falls back to `error`: the context-service gateway puts its reason under `error`
 * (job-manager/auth use `message`), and without this fallback a gateway failure reached CI as a bare
 * status code with no reason — the exact 27 Jul incident.
 */
export function messageOf(body: any): string | undefined {
  const m =
    body && typeof body.message === 'string' && body.message
      ? body.message
      : body && typeof body.error === 'string' && body.error
        ? body.error
        : undefined;
  return m ? m.slice(0, 200) : undefined;
}

/**
 * Extract the gateway's correlation/trace id from an error body so the CI log can be matched to a
 * server-side trace. The gateway emits `traceId` + `correlationId` at the top level; tolerate an
 * APIResponse `data` wrapper and snake_case variants.
 */
export function traceOf(body: any): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const t =
    body.traceId ??
    body.correlationId ??
    body.trace_id ??
    body.correlation_id ??
    body.data?.traceId ??
    body.data?.correlationId;
  return typeof t === 'string' && t ? t.slice(0, 120) : undefined;
}

/** Artifacts and bundles travel over https only. The URL is a credential, so the refusal never echoes it. */
export function requireHttps(signedUrl: string): void {
  let protocol: string;
  try {
    protocol = new URL(signedUrl).protocol;
  } catch {
    throw new UserError('Maestro returned a storage URL the Action cannot read.');
  }
  if (protocol !== 'https:') {
    throw new UserError(
      `Maestro returned a storage URL over ${protocol}//; the Action moves JARs and bundles over https only. ` +
        'Serve the install\'s presigned storage URLs over https (AWS_PRESIGN_ENDPOINT_URL on a private-cloud install).',
    );
  }
}

/** http-client refuses a redirect from https to http with advice the Action cannot follow; say what happened. */
function namedDowngrade(err: unknown): never {
  if (err instanceof Error && /Redirect from HTTPS to HTTP/.test(err.message)) {
    throw new UserError('Maestro storage redirected the Action from https to http; it follows https only.');
  }
  throw err;
}
