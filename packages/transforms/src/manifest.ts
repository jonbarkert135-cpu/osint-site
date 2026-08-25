/** Zod schemas for the three manifest kinds (21_TRANSFORM_SYSTEM.md §3). */

import { z } from 'zod';

import {
  CREDENTIAL_CLASSES,
  DATA_FLOWS,
  DEPLOYMENT_KINDS,
  ENGINE_RUNTIMES,
  ENTITY_KINDS,
  EXECUTION_CLASSES,
  FALLBACK_STRATEGIES,
  MANIFEST_STATUSES,
  PERMISSIONS,
  PROVIDER_STATUSES,
  TRANSFORM_CATEGORIES,
  TRANSFORM_PRIORITIES,
  type EngineManifest,
  type ProviderManifest,
  type TransformManifest,
} from './types.ts';

const id = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be kebab-case');
const semver = z.string().regex(/^\d+\.\d+\.\d+$/, 'must be semver');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const unit = z.number().min(0).max(1);
const positive = z.number().int().positive();

export const TransformManifestSchema = z
  .object({
    id,
    version: semver,
    name: z.string().min(1),
    description: z.string().min(1),
    category: z.enum(TRANSFORM_CATEGORIES),
    capability: id,
    inputs: z.array(z.enum(ENTITY_KINDS)).nonempty(),
    outputs: z.array(z.enum(ENTITY_KINDS)).nonempty(),
    engines: z.array(id).nonempty(),
    priority: z.enum(TRANSFORM_PRIORITIES),
    cost: z.enum(EXECUTION_CLASSES),
    limits: z.object({
      expectedRuntimeMs: positive,
      maxResults: positive,
      maxInputBatch: positive,
    }),
    cacheable: z.boolean(),
    cacheTtlSeconds: positive.optional(),
    documentation: z.string().min(1),
    status: z.enum(MANIFEST_STATUSES),
  })
  .strict()
  // A cacheable transform without a TTL caches forever, which is how an investigation tool
  // starts reporting last month's DNS as today's.
  .refine((t) => !t.cacheable || t.cacheTtlSeconds !== undefined, {
    message: 'cacheable transforms must declare cacheTtlSeconds',
    path: ['cacheTtlSeconds'],
  });

/** Runtime passport (Part 2 §39). Optional: `resolveRuntime()` derives one when absent. */
export const EngineRuntimeSchema = z
  .object({
    runtime: z.enum(ENGINE_RUNTIMES),
    deployment: z.enum(DEPLOYMENT_KINDS),
    requirements: z
      .object({
        image: z.string().min(1).optional(),
        memoryMb: positive,
        cpu: z.number().positive(),
        persistent: z.boolean(),
      })
      .strict(),
    hostCompatible: z.boolean(),
    fallback: z
      .object({
        strategy: z.enum(FALLBACK_STRATEGIES),
        target: z.string().min(1).optional(),
        note: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  // A container without an image is a wish, not a deployment.
  .refine((r) => r.deployment !== 'containerized' || r.requirements.image !== undefined, {
    message: 'containerized engines must declare requirements.image',
    path: ['requirements', 'image'],
  })
  // §35: something that cannot run here must say what replaces it.
  .refine((r) => r.deployment !== 'unsupported' || r.fallback !== undefined, {
    message: 'unsupported engines must declare a fallback strategy',
    path: ['fallback'],
  });

export const EngineManifestSchema = z
  .object({
    id,
    version: semver,
    capability: id,
    provider: id,
    integration: z.string().min(1).optional(),
    dataFlow: z.enum(DATA_FLOWS),
    permissions: z.array(z.enum(PERMISSIONS)),
    quality: z.object({
      resultQuality: unit,
      reliability: unit,
      maintenance: unit,
    }),
    cost: z.enum(EXECUTION_CLASSES),
    terminal: z.boolean(),
    status: z.enum(MANIFEST_STATUSES),
    runtime: EngineRuntimeSchema.optional(),
  })
  .strict()
  .refine((e) => e.dataFlow === 'local' || e.permissions.includes('network'), {
    message: 'a non-local engine must declare the network permission',
    path: ['permissions'],
  });

export const ProviderManifestSchema = z
  .object({
    id,
    name: z.string().min(1),
    credentialClass: z.enum(CREDENTIAL_CLASSES),
    credentials: z.enum(['none', 'optional', 'required']),
    pricing: z.enum(['free', 'free-tier', 'paid', 'local']),
    endpoint: z.string().url().optional(),
    licence: z.string().min(1),
    dataLicence: z.string().min(1).optional(),
    limits: z
      .object({
        requestsPerMinute: positive.optional(),
        requestsPerDay: positive.optional(),
        note: z.string().min(1).optional(),
      })
      .strict(),
    attribution: z.string().min(1).optional(),
    storeResults: z.boolean().optional(),
    lastVerified: isoDate,
    status: z.enum(PROVIDER_STATUSES),
    alternatives: z.array(id),
  })
  .strict();

/** Parse helpers — used at every trust boundary: seeded catalogue, plugin install, API input. */
export const parseTransformManifest = (input: unknown): TransformManifest =>
  TransformManifestSchema.parse(input) as TransformManifest;

export const parseEngineManifest = (input: unknown): EngineManifest =>
  EngineManifestSchema.parse(input) as EngineManifest;

export const parseProviderManifest = (input: unknown): ProviderManifest =>
  ProviderManifestSchema.parse(input) as ProviderManifest;
