import { z } from 'zod';

import { APP_MODES, CAPABILITY_ENV, readAppModeConfig, type AppModeConfig } from './appMode.ts';

/**
 * Server configuration. Reproduced from RAVEN-SPEC/19_DEPLOYMENT.md §1.1.
 * The process refuses to start on an invalid or missing required variable.
 */
export const serverEnv = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    NEXUS_ENV: z.enum(['local', 'preview', 'staging', 'production']),
    DATABASE_URL: z.string().url(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(2).max(200).default(20),
    REDIS_URL: z.string().url(),
    S3_ENDPOINT: z.string().url(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false), // true for MinIO
    AUTH_SECRET: z.string().min(32),
    AUTH_TRUSTED_ORIGINS: z.string().transform((s) => s.split(',')),
    PUBLIC_APP_URL: z.string().url(),
    SYNC_URL: z.string().url(),
    SYNC_SHARED_SECRET: z.string().min(32), // API signs board tokens, sync verifies
    SYNC_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
    RUNNER_URL: z.string().url(),
    RUNNER_SHARED_SECRET: z.string().min(32),
    EGRESS_PROXY_URL: z.string().url(),
    EGRESS_ALLOWLIST: z.string().default(''), // comma-separated host patterns
    AI_PROVIDER: z.enum(['openai-compatible', 'mock']).default('mock'),
    AI_BASE_URL: z.string().url().optional(),
    AI_API_KEY: z.string().optional(),
    // 14_AI_AGENT.md §3: the configurable default embedding model (dimension 1536).
    AI_EMBED_MODEL: z.string().default('text-embedding-3-small'),
    AI_MONTHLY_BUDGET_USD: z.coerce.number().default(50),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
    OTEL_SERVICE_NAME: z.string().default('raven-api'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
    NEXUS_TEST_ENDPOINTS: z.coerce.boolean().default(false),
    NEXUS_INTEGRATIONS_MODE: z.enum(['real', 'stub']).default('real'),
    FEATURE_FLAGS: z.string().default(''), // csv of enabled flags, see §9
    // Mode registry (docs/adr/ADR-001-local-first.md). The API process only exists in a deployment
    // that has a backend, so its default is `server`; the flags below are the same names the browser
    // bundle reads, so one deployment describes itself once.
    APP_MODE: z.enum(APP_MODES).default('server'),
    BACKEND_ENABLED: z.string().optional(),
    AUTH_ENABLED: z.string().optional(),
    GOOGLE_AUTH_ENABLED: z.string().optional(),
    CLOUD_SYNC_ENABLED: z.string().optional(),
    REMOTE_DATABASE_ENABLED: z.string().optional(),
    COLLABORATION_ENABLED: z.string().optional(),
    INTEGRATIONS_ENABLED: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.NODE_ENV === 'production' && v.NEXUS_TEST_ENDPOINTS)
      ctx.addIssue({ code: 'custom', message: 'NEXUS_TEST_ENDPOINTS must be false in production' });
    if (v.AI_PROVIDER !== 'mock' && !v.AI_API_KEY)
      ctx.addIssue({ code: 'custom', message: 'AI_API_KEY required for a non-mock provider' });
  });

export type ServerEnv = z.infer<typeof serverEnv>;

/** Client configuration: VITE_ prefixed, never a secret — this ends up in the bundle. */
/** The client fields themselves. Exported so tooling can enumerate them (see env.test.ts). */
export const clientEnvShape = z.object({
  // Optional because a local-mode bundle talks to nothing: there is no app origin to call and no
  // sync server to reach. The refinement below makes them required again as soon as the bundle is
  // built for a deployment with a backend.
  VITE_APP_URL: z.string().url().optional(),
  VITE_SYNC_URL: z.string().url().optional(),
  VITE_SENTRY_DSN: z.string().url().optional(),
  VITE_NEXUS_ENV: z.enum(['local', 'preview', 'staging', 'production']),
  VITE_FEATURE_FLAGS: z.string().default(''),
  VITE_APP_MODE: z.enum(APP_MODES).default('local'),
  VITE_BACKEND_ENABLED: z.string().optional(),
  VITE_AUTH_ENABLED: z.string().optional(),
  VITE_GOOGLE_AUTH_ENABLED: z.string().optional(),
  VITE_CLOUD_SYNC_ENABLED: z.string().optional(),
  VITE_REMOTE_DATABASE_ENABLED: z.string().optional(),
  VITE_COLLABORATION_ENABLED: z.string().optional(),
  VITE_INTEGRATIONS_ENABLED: z.string().optional(),
});

export const clientEnv = clientEnvShape.superRefine((v, ctx) => {
  if (v.VITE_APP_MODE === 'local') return;
  if (v.VITE_APP_URL === undefined)
    ctx.addIssue({ code: 'custom', message: 'VITE_APP_URL is required when VITE_APP_MODE=server' });
});

export type ClientEnv = z.infer<typeof clientEnv>;

/** Secret variable names — used by the logger redaction list and by the bundle grep test. */
export const SECRET_ENV_KEYS = [
  'DATABASE_URL',
  'REDIS_URL',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'AUTH_SECRET',
  'SYNC_SHARED_SECRET',
  'RUNNER_SHARED_SECRET',
  'AI_API_KEY',
] as const;

export type SecretEnvKey = (typeof SECRET_ENV_KEYS)[number];

export class EnvValidationError extends Error {
  // Plain field + assignment: parameter properties are not erasable and therefore unsupported by
  // `node --experimental-strip-types` (see infra/docker/api.Dockerfile).
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      ['Invalid environment configuration:', ...issues.map((i) => `  - ${i}`)].join('\n') +
        '\nFix the variables above (see .env.example) and restart.',
    );
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

const formatIssues = (error: z.ZodError): string[] =>
  error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });

/**
 * Parse and validate the server environment. Throws EnvValidationError with one readable
 * line per offending variable — never a zod dump, never a partially valid config.
 */
export function loadServerEnv(
  raw: NodeJS.ProcessEnv | Record<string, unknown> = process.env,
): ServerEnv {
  const parsed = serverEnv.safeParse(raw);
  if (!parsed.success) throw new EnvValidationError(formatIssues(parsed.error));
  return parsed.data;
}

/** Same contract for the client schema, so a broken build fails loudly instead of at runtime. */
export function loadClientEnv(raw: Record<string, unknown>): ClientEnv {
  const parsed = clientEnv.safeParse(raw);
  if (!parsed.success) throw new EnvValidationError(formatIssues(parsed.error));
  return parsed.data;
}

/**
 * The mode registry as the API process sees it. Kept next to the env loader so a process that
 * refuses to boot on a bad variable also refuses to boot on a contradictory capability set.
 */
export function serverAppModeConfig(env: ServerEnv): AppModeConfig {
  const raw: Record<string, string | undefined> = { APP_MODE: env.APP_MODE };
  for (const name of Object.values(CAPABILITY_ENV)) {
    raw[name] = (env as unknown as Record<string, string | undefined>)[name];
  }
  return readAppModeConfig(raw);
}
