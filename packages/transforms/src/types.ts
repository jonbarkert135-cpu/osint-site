/**
 * Frozen vocabulary of the transform layer (21_TRANSFORM_SYSTEM.md §1, §3).
 *
 * The entity kinds live here for now. They move to `packages/integrations` when that package
 * lands (10_INTEGRATIONS.md §3.1) — this package is the only consumer until then.
 */

/** Entity kinds a transform can consume or produce. */
export const ENTITY_KINDS = [
  'domain',
  'hostname',
  'url',
  'email',
  'username',
  'profile',
  'ip',
  'asn',
  'dns_record',
  'certificate',
  'service',
  'snapshot',
  'scan',
  'hash',
  'verdict',
  'reputation',
  'file',
  'metadata',
  'device',
  'phone',
  'repo',
  'language',
  'dependency',
  'release',
  'person',
  'organization',
  'company',
  'sanction',
  'breach',
  'crypto_address',
  'transaction',
  'place',
  'coordinates',
  'fact',
  'note',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const TRANSFORM_CATEGORIES = [
  'identity',
  'infrastructure',
  'web',
  'files',
  'repositories',
  'records',
  'analysis',
] as const;
export type TransformCategory = (typeof TRANSFORM_CATEGORIES)[number];

export const TRANSFORM_PRIORITIES = [
  'core',
  'recommended',
  'optional',
  'experimental',
  'external',
  'deprecated',
] as const;
export type TransformPriority = (typeof TRANSFORM_PRIORITIES)[number];

/** Execution classes from the brief §12: how expensive one run is. */
export const EXECUTION_CLASSES = ['fast', 'standard', 'deep', 'optional'] as const;
export type ExecutionClass = (typeof EXECUTION_CLASSES)[number];

/** Where the data goes. Drives privacy scoring and mode filtering. */
export const DATA_FLOWS = ['local', 'network', 'external-api'] as const;
export type DataFlow = (typeof DATA_FLOWS)[number];

export const PERMISSIONS = [
  'network',
  'filesystem',
  'subprocess',
  'credentials',
  'browser',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Execution runtimes an adapter can host (Part 2 §38). The core never branches on these — only
 * the adapter layer does (§37). Listing a runtime here is an architectural commitment, not a
 * promise that an adapter for it is implemented today; see `ADAPTER_SUPPORT` in runtime.ts.
 */
export const ENGINE_RUNTIMES = [
  'node',
  'python',
  'go',
  'rust',
  'cli',
  'http',
  'external-api',
  'browser-worker',
] as const;
export type EngineRuntime = (typeof ENGINE_RUNTIMES)[number];

/**
 * How an engine reaches the host (Part 2 §34).
 * - `native`        runs in-process or as a plain child process on the VPS
 * - `containerized` requires a container image with explicit limits
 * - `external`      runs off-box, reached through the remote execution queue (§36)
 * - `unsupported`   impossible or not worth it on this host; needs a strategy (§35)
 */
export const DEPLOYMENT_KINDS = ['native', 'containerized', 'external', 'unsupported'] as const;
export type DeploymentKind = (typeof DEPLOYMENT_KINDS)[number];

/** What to do instead of bending the architecture around an ill-fitting project (Part 2 §35). */
export const FALLBACK_STRATEGIES = [
  'native-adapter',
  'external-worker',
  'remote-execution',
  'optional-integration',
  'replacement',
] as const;
export type FallbackStrategy = (typeof FALLBACK_STRATEGIES)[number];

export interface EngineRequirements {
  /** Container image, only meaningful for `containerized`. */
  readonly image?: string;
  readonly memoryMb: number;
  readonly cpu: number;
  /** True when the engine needs a writable path that outlives one run. */
  readonly persistent: boolean;
}

export interface EngineFallback {
  readonly strategy: FallbackStrategy;
  /** Engine id, worker name or integration to use instead. */
  readonly target?: string;
  readonly note?: string;
}

/** The runtime passport of an engine (Part 2 §34, §39). */
export interface EngineRuntimeSpec {
  readonly runtime: EngineRuntime;
  readonly deployment: DeploymentKind;
  readonly requirements: EngineRequirements;
  /** Whether it can run on the host profile in RAVEN-SPEC/29 §7. */
  readonly hostCompatible: boolean;
  readonly fallback?: EngineFallback;
}

/** A–F, see docs/ecosystem/PROVIDER_CATALOG.md. */
export const CREDENTIAL_CLASSES = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
export type CredentialClass = (typeof CREDENTIAL_CLASSES)[number];

export const PROVIDER_STATUSES = [
  'configured',
  'not-configured',
  'invalid',
  'rate-limited',
  'disabled',
  'unavailable',
  'deprecated',
] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

export const MANIFEST_STATUSES = ['stable', 'beta', 'unavailable', 'deprecated'] as const;
export type ManifestStatus = (typeof MANIFEST_STATUSES)[number];

/** Execution modes (21_TRANSFORM_SYSTEM.md §7), ordered from most to least restrictive. */
export const EXECUTION_MODES = [
  'strict-local',
  'zero-credential',
  'free-tier',
  'configured',
  'maximum-coverage',
] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export type CapabilityId = string;
export type EngineId = string;
export type ProviderId = string;
export type TransformId = string;

export interface QualitySignals {
  /** How good the returned data is, 0..1. */
  readonly resultQuality: number;
  /** How often the engine answers successfully, 0..1. */
  readonly reliability: number;
  /** Upstream maintenance health, 0..1. */
  readonly maintenance: number;
}

export interface TransformLimits {
  readonly expectedRuntimeMs: number;
  readonly maxResults: number;
  readonly maxInputBatch: number;
}

export interface TransformManifest {
  readonly id: TransformId;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly category: TransformCategory;
  readonly capability: CapabilityId;
  readonly inputs: readonly EntityKind[];
  readonly outputs: readonly EntityKind[];
  readonly engines: readonly EngineId[];
  readonly priority: TransformPriority;
  readonly cost: ExecutionClass;
  readonly limits: TransformLimits;
  readonly cacheable: boolean;
  readonly cacheTtlSeconds?: number;
  readonly documentation: string;
  readonly status: ManifestStatus;
}

export interface EngineManifest {
  readonly id: EngineId;
  readonly version: string;
  readonly capability: CapabilityId;
  readonly provider: ProviderId;
  readonly integration?: string;
  readonly dataFlow: DataFlow;
  readonly permissions: readonly Permission[];
  readonly quality: QualitySignals;
  readonly cost: ExecutionClass;
  /** A terminal engine ends a fallback chain without executing anything: a link out, or manual entry. */
  readonly terminal: boolean;
  /** Runtime passport (Part 2 §34/§39). Derived by `resolveRuntime()` when a manifest omits it. */
  readonly runtime?: EngineRuntimeSpec;
  readonly status: ManifestStatus;
}

export interface ProviderLimits {
  readonly requestsPerMinute?: number;
  readonly requestsPerDay?: number;
  readonly note?: string;
}

export interface ProviderManifest {
  readonly id: ProviderId;
  readonly name: string;
  readonly credentialClass: CredentialClass;
  readonly credentials: 'none' | 'optional' | 'required';
  readonly pricing: 'free' | 'free-tier' | 'paid' | 'local';
  readonly endpoint?: string;
  readonly licence: string;
  readonly dataLicence?: string;
  readonly limits: ProviderLimits;
  readonly attribution?: string;
  /** False when the provider's terms forbid storing results; gates the result cache (§10). */
  readonly storeResults?: boolean;
  /** ISO date (YYYY-MM-DD) the credential/pricing facts were last checked against official docs. */
  readonly lastVerified: string;
  readonly status: ProviderStatus;
  readonly alternatives: readonly ProviderId[];
}

/** Why an engine or transform is not usable right now. */
export type ExclusionReason =
  | 'blocked-by-mode'
  | 'requires-configuration'
  | 'paid-only'
  | 'provider-unavailable'
  | 'provider-rate-limited'
  | 'provider-deprecated'
  | 'engine-unavailable'
  | 'not-executable'
  | 'permission-denied'
  | 'budget-exhausted'
  /** The step would cost more CPU, RAM, time, requests or quota than this scan allows (§42). */
  | 'over-resource-budget'
  /** Affordable, but an expensive engine on an input that does not promise much (§42). */
  | 'cost-not-justified'
  | 'over-capacity'
  | 'already-covered'
  | 'no-engine';

export interface EngineAvailability {
  readonly engine: EngineManifest;
  readonly provider: ProviderManifest;
  readonly usable: boolean;
  readonly reason?: ExclusionReason;
  readonly score: number;
}

export interface Budget {
  readonly maxNewNodes: number;
  readonly maxDepth: number;
  readonly maxRuntimeMs: number;
  readonly maxParallel: number;
  readonly maxTransforms: number;
}

export interface PlanStep {
  readonly transform: TransformId;
  readonly inputKind: EntityKind;
  /** Steps this one consumes output from; empty for the first layer. */
  readonly dependsOn: readonly TransformId[];
  readonly depth: number;
  readonly chain: readonly EngineId[];
  readonly estimatedRuntimeMs: number;
  readonly maxResults: number;
}

export interface PlanEstimate {
  readonly runtimeMs: number;
  readonly minEntities: number;
  readonly maxEntities: number;
}

export interface PlanExclusion {
  readonly transform: TransformId;
  readonly reason: ExclusionReason;
  /** Free text when the reason alone is not enough to act on it (cost gate, §42). */
  readonly note?: string;
}

export interface TransformPlan {
  readonly steps: readonly PlanStep[];
  readonly estimate: PlanEstimate;
  readonly requiresNetwork: boolean;
  readonly providersUsed: readonly ProviderId[];
  readonly credentialsNeeded: readonly ProviderId[];
  readonly excluded: readonly PlanExclusion[];
}

export interface ManifestIssue {
  readonly kind: 'transform' | 'engine' | 'provider';
  readonly id: string;
  readonly message: string;
}
