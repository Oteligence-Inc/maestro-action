// Shared types mirroring the Maestro backend contract (see Maestro-v5-Frontend-API-Integration-Guide.html).
// Only the fields the Action reads/sends are modelled; responses carry more.

export interface Inputs {
  apiKey: string;
  project: string; // human name OR a proj_ uid
  service: string;
  environment: string;
  jarsGlob: string;
  apiUrl: string;
  timeoutSeconds: number;
  failOnWarnings: boolean;
}

export interface Session {
  /** JWT minted from the API key via POST /api/auth/cli/token. */
  token: string;
}

/** GET .../envs/{env}/locked → LockedSpecResponse (job-manager APIResponse.data). */
export interface LockedSpec {
  version: number;
  selectionKind?: string;
  goals: string[];
  selection: SelectionEntry[];
  apm?: string | null;
  javaVersion?: string | null;
  otelVersion?: string | null;
  extensionName?: string | null;
  registeredJars?: Record<string, { sha?: string; versionLabel?: string }>;
  expectedArtifactHashes?: Record<string, unknown> | null;
}

export interface SelectionEntry {
  /** Scoped FQN: "service::com.x.Class.method". */
  methodFqn: string;
  tier?: string; // deep | high | standard | low | skip
  provenance?: string;
  service?: string;
}

/** GET .../envs/{env}/versions → LockedVersionResponse[] (newest first). */
export interface LockedVersion {
  uid: string;
  versionNum: number;
}

export interface ResolvedConfig {
  projectUid: string;
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
