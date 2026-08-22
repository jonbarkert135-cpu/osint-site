/**
 * The integration registry (10_INTEGRATIONS.md §4.3).
 *
 * Built-in manifests are statically imported so the bundle is tree-shakeable and nothing is loaded
 * by a computed `require`. A manifest that fails validation is *skipped and reported*, never
 * thrown: one bad third-party plugin may not stop the server from booting, and the operator needs
 * the zod issue path, not a stack trace.
 */

import { manifest as expandUrlManifest } from '../builtin/manifest.ts';
import { parser as expandUrlParser } from '../builtin/parser.ts';
import { manifest as githubManifest } from '../github/manifest.ts';
import { parser as githubParser } from '../github/parser.ts';
import { manifest as spiderFootManifest } from '../spiderfoot/manifest.ts';
import { parser as spiderFootParser } from '../spiderfoot/parser.ts';
import {
  defaultNodeMapper,
  defaultRelationshipMapper,
  manifestEntityExtractor,
  manifestInputAdapter,
  type EntityExtractor,
  type InputAdapter,
  type NodeMapper,
  type OutputParser,
  type RelationshipMapper,
} from './pipeline.ts';
import {
  safeParseManifest,
  type IntegrationId,
  type IntegrationManifest,
  type ManifestIssue,
} from './manifest.ts';

export interface RegistryEntry {
  readonly manifest: IntegrationManifest;
  readonly parser: OutputParser;
  readonly inputAdapter: InputAdapter;
  readonly extractor: EntityExtractor;
  readonly nodeMapper: NodeMapper;
  readonly relationshipMapper: RelationshipMapper;
  enabledForOrg(orgId: string): Promise<boolean>;
}

export interface RegistryRejection {
  readonly id: string;
  readonly issues: readonly ManifestIssue[];
}

export interface Registry {
  readonly entries: ReadonlyMap<IntegrationId, RegistryEntry>;
  /** Surfaced in Admin → Integrations; never silently dropped (§4.3). */
  readonly rejected: readonly RegistryRejection[];
}

/** Raw declarations before validation. Third-party plugins arrive in exactly this shape. */
export interface IntegrationSource {
  readonly raw: unknown;
  readonly parser: OutputParser;
  readonly inputAdapter?: (manifest: IntegrationManifest) => InputAdapter;
  readonly extractor?: (manifest: IntegrationManifest) => EntityExtractor;
  readonly nodeMapper?: (manifest: IntegrationManifest) => NodeMapper;
  readonly relationshipMapper?: (manifest: IntegrationManifest) => RelationshipMapper;
  readonly enabledForOrg?: (orgId: string) => Promise<boolean>;
}

/** The first-party set. P10–P12 add one line each here and nothing else in this package (R2). */
export const BUILTIN_SOURCES: readonly IntegrationSource[] = [
  { raw: expandUrlManifest, parser: expandUrlParser },
  { raw: githubManifest, parser: githubParser },
  { raw: spiderFootManifest, parser: spiderFootParser },
];

export interface LoadRegistryOptions {
  readonly includeThirdParty?: boolean;
  readonly thirdParty?: readonly IntegrationSource[];
}

export function buildRegistry(sources: readonly IntegrationSource[]): Registry {
  const entries = new Map<IntegrationId, RegistryEntry>();
  const rejected: RegistryRejection[] = [];

  for (const source of sources) {
    const parsed = safeParseManifest(source.raw);
    if (!parsed.ok) {
      const declaredId =
        typeof source.raw === 'object' &&
        source.raw !== null &&
        typeof (source.raw as { id?: unknown }).id === 'string'
          ? (source.raw as { id: string }).id
          : '(unnamed)';
      rejected.push({ id: declaredId, issues: parsed.issues });
      continue;
    }
    const manifest = parsed.manifest;
    entries.set(manifest.id, {
      manifest,
      parser: source.parser,
      inputAdapter: (source.inputAdapter ?? manifestInputAdapter)(manifest),
      extractor: (source.extractor ?? manifestEntityExtractor)(manifest),
      nodeMapper:
        source.nodeMapper === undefined ? defaultNodeMapper() : source.nodeMapper(manifest),
      relationshipMapper:
        source.relationshipMapper === undefined
          ? defaultRelationshipMapper()
          : source.relationshipMapper(manifest),
      enabledForOrg: source.enabledForOrg ?? (() => Promise.resolve(true)),
    });
  }

  return { entries, rejected };
}

/** Async because third-party plugin discovery will be, and callers should not change later. */
export function loadRegistry(options: LoadRegistryOptions = {}): Promise<Registry> {
  const sources = [
    ...BUILTIN_SOURCES,
    ...(options.includeThirdParty === true ? (options.thirdParty ?? []) : []),
  ];
  return Promise.resolve(buildRegistry(sources));
}

let cached: Registry | undefined;

/** The process-wide registry of first-party integrations. */
export function builtinRegistry(): Registry {
  cached ??= buildRegistry(BUILTIN_SOURCES);
  return cached;
}
