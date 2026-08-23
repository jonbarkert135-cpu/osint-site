/**
 * The Integration Manifest (10_INTEGRATIONS.md §4.1) — the only declaration of a tool.
 *
 * The schema below is the spec's schema, transcribed rather than reinterpreted. It is checked
 * twice: at build time by `test/manifest.schema.test.ts` over every shipped manifest, and again at
 * load time by `parseManifest()`, which fails loudly with the zod issue path so a broken manifest
 * is a named, actionable error instead of a blank form (R2, §4.3).
 */

import { z } from 'zod';

import { IntegrationError } from './errors.ts';

export const CURRENT_MANIFEST_VERSION = 1;

export const zSemver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/);

export const ENTITY_KINDS = [
  'domain',
  'url',
  'email',
  'username',
  'ip',
  'hash',
  'phone',
  'handle',
  'repo',
  'person',
  'organization',
  'file',
  'note',
  'unknown',
] as const;

export const zEntityKind = z.enum(ENTITY_KINDS);
export type EntityKind = z.infer<typeof zEntityKind>;

export const zIntegrationId = z.string().regex(/^[a-z][a-z0-9-]{2,31}$/);

/* ---------- inputs ---------- */

export const INPUT_FIELD_TYPES = [
  'string',
  'number',
  'boolean',
  'enum',
  'entity',
  'entityList',
  'duration',
  'secretRef',
] as const;

export const zInputField = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  label: z.string().min(1).max(80),
  help: z.string().max(240).optional(),
  type: z.enum(INPUT_FIELD_TYPES),
  entityKinds: z.array(zEntityKind).optional(),
  enumValues: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  required: z.boolean().default(true),
  default: z.unknown().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  maxItems: z.number().int().positive().max(1000).optional(),
  pattern: z.string().optional(),
  from: z
    .discriminatedUnion('source', [
      z.object({ source: z.literal('selection'), kinds: z.array(zEntityKind).min(1) }),
      z.object({ source: z.literal('form') }),
      z.object({ source: z.literal('derived'), expr: z.string() }),
    ])
    .default({ source: 'form' }),
  advanced: z.boolean().default(false),
});

export type InputField = z.infer<typeof zInputField>;

/* ---------- outputs ---------- */

export const zOutputSpec = z.object({
  name: z.string(),
  kind: z.enum(['json', 'ndjson', 'csv', 'text', 'html', 'binary']),
  path: z.string().optional(),
  fromStdout: z.boolean().default(false),
  primary: z.boolean().default(false),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(512 * 1024 * 1024)
    .default(64 * 1024 * 1024),
});

export type OutputSpec = z.infer<typeof zOutputSpec>;

/* ---------- permissions ---------- */

export const zPermission = z.enum([
  'net:allowlist',
  'net:broad',
  'graph:read',
  'graph:propose',
  'secrets:read',
  'files:read',
  'files:write',
]);

export type IntegrationPermission = z.infer<typeof zPermission>;

/* ---------- execution ---------- */

export const zNetworkPolicy = z.object({
  mode: z.enum(['none', 'allowlist', 'broad']),
  allow: z.array(z.string()).default([]),
  /** Never configurable; N7. */
  denyPrivateRanges: z.literal(true),
  maxRequestsPerMinute: z.number().int().positive().max(6000).default(120),
  maxConcurrentConnections: z.number().int().positive().max(64).default(16),
});

export type NetworkPolicy = z.infer<typeof zNetworkPolicy>;

export const zResourceLimits = z.object({
  wallClockMs: z
    .number()
    .int()
    .min(1000)
    .max(3 * 60 * 60 * 1000)
    .default(300_000),
  cpuMillicores: z.number().int().min(100).max(4000).default(1000),
  memoryMiB: z.number().int().min(64).max(8192).default(512),
  pids: z.number().int().min(16).max(2048).default(256),
  tmpfsMiB: z.number().int().min(16).max(4096).default(256),
  maxOutputBytes: z
    .number()
    .int()
    .min(1024)
    .max(512 * 1024 * 1024)
    .default(64 * 1024 * 1024),
  maxArtifacts: z.number().int().min(1).max(64).default(8),
});

export type ResourceLimits = z.infer<typeof zResourceLimits>;

export const zExecution = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('container'),
    image: z.string().min(3),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    entrypoint: z.array(z.string()).optional(),
    command: z.array(z.string()).min(1),
    env: z.record(z.string(), z.string()).default({}),
    /** envVar → secret name (§6.6); never a secret value. */
    secretEnv: z.record(z.string(), z.string()).default({}),
    workdir: z.string().default('/work'),
    network: zNetworkPolicy,
    limits: zResourceLimits,
    runtimeClass: z.enum(['runc', 'gvisor']).default('gvisor'),
    user: z.string().default('65534:65534'),
    readOnlyRootFs: z.literal(true),
    /**
     * Optional version/capability probe run once per digest before the first run (13 §3.6).
     * Declarative so the runner stays tool-agnostic.
     */
    capabilityProbe: z
      .object({
        versionArgs: z.array(z.string()).default(['--version']),
        helpArgs: z.array(z.string()).default(['--help']),
        requiredFlags: z.array(z.string()).default([]),
        minVersion: z.string().optional(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal('http'),
    baseUrl: z.string().url(),
    requests: z
      .array(
        z.object({
          name: z.string(),
          method: z.enum(['GET', 'POST']),
          path: z.string(),
          query: z.record(z.string(), z.string()).default({}),
          headers: z.record(z.string(), z.string()).default({}),
          secretHeaders: z.record(z.string(), z.string()).default({}),
          body: z.unknown().optional(),
          paginate: z
            .object({
              style: z.enum(['link-header', 'cursor', 'page']),
              cursorPath: z.string().optional(),
              maxPages: z.number().int().min(1).max(200).default(10),
            })
            .optional(),
          collectAs: z.string(),
        }),
      )
      .min(1),
    network: zNetworkPolicy,
    limits: zResourceLimits,
  }),
  z.object({
    kind: z.literal('builtin'),
    /** Key in `apps/runner/src/executors/builtin-registry.ts`; not third-party contributable. */
    module: z.string(),
    limits: zResourceLimits,
  }),
]);

export type Execution = z.infer<typeof zExecution>;

/* ---------- entity mappings ---------- */

export const FIELD_TRANSFORMS = [
  'none',
  'lower',
  'trim',
  'url-normalize',
  'domain-of',
  'strip-at',
  'sha256',
] as const;

export const zFieldMap = z.object({
  from: z.string(),
  to: z.string(),
  transform: z.enum(FIELD_TRANSFORMS).default('none'),
  required: z.boolean().default(false),
});

export type FieldMap = z.infer<typeof zFieldMap>;

export const zEntityMapping = z.object({
  when: z.object({ recordType: z.string() }),
  entity: z.object({
    kind: zEntityKind,
    valueFrom: z.string(),
    nodeType: z.string(),
    titleFrom: z.string().optional(),
    fields: z.array(zFieldMap).default([]),
    tags: z.array(z.string()).default([]),
    baseConfidence: z.number().min(0).max(1).default(0.7),
  }),
  relate: z
    .array(
      z.object({
        to: z.enum(['anchor', 'entity']),
        toEntityRef: z.string().optional(),
        edgeType: z.string(),
        label: z.string().optional(),
        direction: z.enum(['out', 'in']).default('out'),
      }),
    )
    .default([]),
  id: z.string().optional(),
});

export type EntityMapping = z.infer<typeof zEntityMapping>;

/* ---------- rate & cost ---------- */

export const zRateLimits = z.object({
  perUserPerHour: z.number().int().min(1).max(1000).default(20),
  perOrgPerHour: z.number().int().min(1).max(10000).default(200),
  perTargetPerDay: z.number().int().min(1).max(1000).default(5),
  concurrentRunsPerOrg: z.number().int().min(1).max(50).default(3),
  minIntervalMsSameInput: z.number().int().min(0).max(86_400_000).default(60_000),
});

export type RateLimits = z.infer<typeof zRateLimits>;

export const zCostHints = z.object({
  typicalDurationMs: z.number().int().positive(),
  typicalOutboundRequests: z.number().int().nonnegative(),
  typicalNewNodes: z.number().int().nonnegative(),
  billable: z.boolean().default(false),
  billingNote: z.string().max(200).optional(),
});

export const TARGET_SCOPES = ['public-index', 'owned-asset', 'third-party-host'] as const;
export const zTargetScope = z.enum(TARGET_SCOPES);
export type TargetScope = z.infer<typeof zTargetScope>;

/* ---------- top level ---------- */

export const zIntegrationManifest = z
  .object({
    manifestVersion: z.literal(CURRENT_MANIFEST_VERSION),
    id: zIntegrationId,
    name: z.string().min(2).max(60),
    /** OUR adapter version, not the tool's. */
    version: zSemver,
    toolVersion: z.string().max(40),
    publisher: z.object({
      name: z.string(),
      url: z.string().url().optional(),
      verified: z.boolean().default(false),
    }),
    icon: z.string(),
    repository: z.string().url(),
    license: z.string(),
    description: z.string().min(20).max(400),
    documentationUrl: z.string().url().optional(),
    capabilities: z
      .array(
        z.enum([
          'enumerate-usernames',
          'scan-domain',
          'fetch-repo',
          'resolve-dns',
          'whois',
          'search-web',
          'extract-metadata',
          'analyze-file',
          'enrich-entity',
        ]),
      )
      .min(1),
    inputs: z.array(zInputField).max(24),
    outputs: z.array(zOutputSpec).min(1).max(16),
    permissions: z.array(zPermission).min(1),
    execution: zExecution,
    parser: z.object({
      module: z.string(),
      export: z.string().default('parser'),
      supportedOutputVersions: z.array(z.string()).min(1),
    }),
    entityMappings: z.array(zEntityMapping).default([]),
    rateLimits: zRateLimits,
    costHints: zCostHints,
    maturity: z.enum(['experimental', 'beta', 'stable', 'deprecated']),
    risk: z.object({
      label: z.enum(['low', 'medium', 'high']),
      reasons: z.array(z.string()).default([]),
      upstreamMaintenance: z.enum(['active', 'low', 'unmaintained', 'unknown']),
      fallback: z.string().max(300).optional(),
    }),
    consent: z.object({
      required: z.boolean().default(true),
      scopeText: z.string().min(20).max(600),
      allowedTargetScopes: z.array(zTargetScope).min(1),
    }),
  })
  .superRefine((m, ctx) => {
    if (
      m.execution.kind !== 'builtin' &&
      m.execution.network.mode === 'broad' &&
      !m.permissions.includes('net:broad')
    ) {
      ctx.addIssue({ code: 'custom', message: 'network.mode=broad requires permission net:broad' });
    }
    if (m.outputs.filter((o) => o.primary).length !== 1) {
      ctx.addIssue({ code: 'custom', message: 'exactly one output must be primary' });
    }
    for (const field of m.inputs) {
      if (field.type === 'enum' && (field.enumValues ?? []).length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['inputs'],
          message: `input "${field.name}" is an enum but declares no enumValues — the form cannot render it`,
        });
      }
      if (
        (field.type === 'entity' || field.type === 'entityList') &&
        (field.entityKinds ?? []).length === 0
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['inputs'],
          message: `input "${field.name}" is an entity picker but declares no entityKinds — the form cannot render it`,
        });
      }
      if (field.pattern !== undefined && !isRe2Safe(field.pattern)) {
        ctx.addIssue({
          code: 'custom',
          path: ['inputs'],
          message: `input "${field.name}" has a pattern with backreferences or lookaround, which is not RE2-safe`,
        });
      }
    }
  });

export type IntegrationManifest = z.infer<typeof zIntegrationManifest>;
export type IntegrationId = string;

/**
 * A conservative RE2 check: the subset we accept excludes backreferences and lookaround, the two
 * constructs that make a pattern catastrophically backtrack on hostile input.
 */
export function isRe2Safe(pattern: string): boolean {
  if (/\\[1-9]/.test(pattern)) return false;
  if (/\(\?[=!<]/.test(pattern)) return false;
  try {
    new RegExp(pattern, 'u');
    return true;
  } catch {
    return false;
  }
}

/* ---------- versioning (§14.2) ---------- */

/**
 * `manifestVersion` bumps require a migration shipped in the same PR. The mechanism exists from
 * day one so the first bump is a table entry, not an archaeology exercise; today the table is
 * empty because only version 1 has ever existed.
 */
export type ManifestMigration = (raw: Record<string, unknown>) => Record<string, unknown>;

export const MANIFEST_MIGRATIONS: Readonly<Record<number, ManifestMigration>> = {};

/**
 * Lifts an older manifest to `CURRENT_MANIFEST_VERSION` by applying every registered step in
 * order. A version with no registered migration is a hard error: silently parsing it against the
 * current schema is how a field quietly changes meaning.
 */
export function migrateManifest(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) {
    throw new IntegrationError('MANIFEST_INVALID', {
      why: 'A manifest must be an object.',
      detail: { received: typeof raw },
    });
  }
  let current = { ...(raw as Record<string, unknown>) };
  const declared = current.manifestVersion;
  let version = typeof declared === 'number' ? declared : 0;
  if (version < 1) {
    throw new IntegrationError('MANIFEST_INVALID', {
      why: 'The manifest does not declare a supported manifestVersion.',
      detail: { manifestVersion: declared },
    });
  }
  while (version < CURRENT_MANIFEST_VERSION) {
    const migrate = MANIFEST_MIGRATIONS[version];
    if (!migrate) {
      throw new IntegrationError('MANIFEST_INVALID', {
        why: `No migration from manifestVersion ${String(version)} to ${String(version + 1)} is registered.`,
        detail: { manifestVersion: version },
      });
    }
    current = migrate(current);
    version += 1;
    current.manifestVersion = version;
  }
  if (version > CURRENT_MANIFEST_VERSION) {
    throw new IntegrationError('MANIFEST_INVALID', {
      why: `This build understands manifestVersion ${String(CURRENT_MANIFEST_VERSION)}, the manifest declares ${String(version)}.`,
      detail: { manifestVersion: version },
    });
  }
  return current;
}

export interface ManifestIssue {
  readonly path: string;
  readonly message: string;
}

export interface ManifestParseFailure {
  readonly ok: false;
  readonly issues: readonly ManifestIssue[];
}

export type ManifestParseResult =
  | { readonly ok: true; readonly manifest: IntegrationManifest }
  | ManifestParseFailure;

/** Non-throwing form used by the registry loader: one bad manifest never crashes boot (§4.3). */
export function safeParseManifest(raw: unknown): ManifestParseResult {
  let migrated: Record<string, unknown>;
  try {
    migrated = migrateManifest(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, issues: [{ path: 'manifestVersion', message }] };
  }
  // §6.3: `noexec` on the workdir means a tool may not exec what it downloaded. A manifest that
  // asks for the exception is refused here — the schema itself strips unknown keys, so this has to
  // be checked on the raw object rather than in a superRefine.
  const execution = migrated.execution;
  if (
    typeof execution === 'object' &&
    execution !== null &&
    (execution as { workdirExec?: unknown }).workdirExec === true
  ) {
    return {
      ok: false,
      issues: [
        {
          path: 'execution.workdirExec',
          message: 'executing from the workdir is not supported in v1 (10_INTEGRATIONS.md §6.3)',
        },
      ],
    };
  }

  const parsed = zIntegrationManifest.safeParse(migrated);
  if (parsed.success) return { ok: true, manifest: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  };
}

/** Throwing form used by shipped manifests, which must be correct at build time. */
export function parseManifest(raw: unknown): IntegrationManifest {
  const result = safeParseManifest(raw);
  if (result.ok) return result.manifest;
  throw new IntegrationError('MANIFEST_INVALID', {
    why: describeIssues(result.issues),
    detail: { issues: result.issues },
  });
}

export function describeIssues(issues: readonly ManifestIssue[]): string {
  return issues
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join('; ')
    .slice(0, 140);
}

/** Resource limits of any execution kind, without the caller switching on `kind`. */
export function limitsOf(manifest: IntegrationManifest): ResourceLimits {
  return manifest.execution.limits;
}

/** The network policy, or the implicit "no network at all" one for builtins (§3.3). */
export function networkPolicyOf(manifest: IntegrationManifest): NetworkPolicy {
  if (manifest.execution.kind === 'builtin') {
    return {
      mode: 'none',
      allow: [],
      denyPrivateRanges: true,
      maxRequestsPerMinute: 120,
      maxConcurrentConnections: 16,
    };
  }
  return manifest.execution.network;
}
