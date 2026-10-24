import type { KeyObject } from 'crypto';

// Shared types mirroring the Maestro backend contract (see Maestro-v5-Frontend-API-Integration-Guide.html).
// Only the fields the Action reads/sends are modelled; responses carry more.

export interface Inputs {
  apiKey: string;
  project: string; // human project name (may be "" when projectId is supplied instead)
  projectId: string; // project UID; wins over `project` when set. Resolves without a name lookup.
  orgId: string; // the organization a key with no project scope acts for; "" lets the key decide
  service: string;
  environment: string;
  jarsGlob: string;
  apiUrl: string;
  timeoutSeconds: number;
  failOnWarnings: boolean;
  /**
   * When the tenant's subscription is inactive (HTTP 402 subscription_inactive), skip extension-JAR
   * generation and let the pipeline continue (deploy proceeds WITHOUT a newly generated extension)
   * instead of failing the step. Default false — a lapsed subscription hard-fails, as before.
   */
  skipGenerateOnInactive: boolean;
  /**
   * When the target service is not part of the env's locked config (removed from the project), skip
   * gracefully (generated=false, exit 0) instead of failing the step. Default false — a removed/unknown
   * service hard-fails with a clear message, so a typo'd `service` input is caught rather than silently
   * producing no instrumentation.
   */
  skipOnRemovedService: boolean;
  /**
   * The Ed25519 public key the build's signature must verify with (`signing-public-key`); null when unset, in which
   * case a signed build is reported and not checked, and an unsigned one is accepted.
   */
  signingKey: KeyObject | null;
}

export interface Session {
  /** JWT minted from the API key via POST /api/auth/cli/token. */
  token: string;
}

/** GET .../envs/{env}/locked → LockedSpecResponse (job-manager APIResponse.data). */
export interface LockedSpec {
  /** The locked version's uid; absent from a job-manager older than the build check. */
  uid?: string;
  version: number;
  selectionKind?: string;
  goals: string[];
  selection: SelectionEntry[];
  apm?: string | null;
  javaVersion?: string | null;
  otelVersion?: string | null;
  extensionName?: string | null;
  /** The lock's snapshot per registration; `serviceKey` is the analysis key its selection entries use. */
  registeredJars?: Record<
    string,
    { sha?: string; versionLabel?: string; artifactUid?: string | null; serviceKey?: string; analysisService?: string }
  >;
}

/** GET .../jobs/{id}/download -> data.buildRecord: the record the build's files are verified against. */
export interface BuildRecord {
  /** recorded (the first build of these inputs), matched, or differs. */
  status: string;
  inputsDigest: string;
  /** Lower-case hex SHA-256 of every application JAR the build read. */
  applicationJars: string[];
  /** Bundle file name to the lower-case hex SHA-256 of its bytes. */
  files: Record<string, string>;
  /** The build that wrote the record. */
  firstJobId: string;
  /** Service key (the analysis's) to the lower-case hex SHA-256 of the upload the build bound to it. */
  bindings: Record<string, string>;
  /** Whether the build was signed, and by which key; the Action checks the bundle's statement, not this field. */
  signature?: { status: string; key?: string; value?: string };
}

export interface SelectionEntry {
  /** BARE fqn "com.x.Class.method" (scope the build key via `service` — see buildProfileFromLocked). */
  methodFqn: string;
  tier?: string; // deep | high | standard | low | skip
  /** "auto" for a recommended entry; any other value, or none, is the user's own pick. */
  provenance?: string;
  service?: string;
  /** One entry per flow a method is selected in. */
  flow?: string;
}

/** GET .../envs/{env}/versions → LockedVersionResponse[] (newest first). */
export interface LockedVersion {
  uid: string;
  versionNum: number;
}

export interface ResolvedConfig {
  projectUid: string;
  /** The Maestro environment the lock belongs to; the build names it so job-manager holds it to that lock. */
  envName: string;
  lockedVersionUid: string;
  locked: LockedSpec;
}

/** POST /api/file/artifact/upload/batch → BatchUploadInitResponse (file-service raw). */
export interface BatchUploadResponse {
  artifactGroupUid: string;
  uploads: Array<{ artifactUid: string | null; preSignedUrl: string | null }>;
  extensionName?: string;
}

export interface UploadResult {
  artifactGroupUid: string;
  /** sha + uid of THIS service's (changed) jar — used for register-jar. */
  sha: string;
  artifactUid: string | null;
  fileName: string;
  sizeBytes: number;
  mustUpload: boolean;
}

/** The MULTI_JAR_EXPLORER_BUILD profile (mirrors MultiJarProfilePayload). */
export interface BuildProfile {
  version: number;
  perService: Record<string, { selectedCount: number }>;
  methodConfigurations: Record<string, { enabled: boolean; depth: string }>;
  goals: string[];
  apm: string | null;
}

export interface DownloadPaths {
  extensionDir: string;
  configPath: string;
  collectorConfigPath: string;
  /** `undefined` when the response carries no `buildRecord` field (a server that predates build records). */
  record: BuildRecord | null | undefined;
  /** The bundle file names the two separately downloaded configs carry in the record. */
  configFileName: string | null;
  collectorConfigFileName: string | null;
}

/** GET .../envs/{env}/staleness → StalenessResponse.services[]. */
export interface ServiceStaleness {
  service: string;
  status: 'fresh' | 'stale' | 'unknown';
  severity?: string;
  triggeredBy?: { service?: string; jobId?: string; at?: string };
}

export const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'NO_ASSET'] as const;
export type JobStatus = 'SUBMITTED' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'NO_ASSET' | string;
