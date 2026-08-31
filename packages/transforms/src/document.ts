/**
 * The engine manifest as one document (Part 2 §39).
 *
 * The manifests are stored split — engine / provider / transform (21_TRANSFORM_SYSTEM.md §3) —
 * because the same engine serves several transforms and the same provider several engines.
 * `engineDocument()` is the joined, flat view of that split: everything an installer, the
 * `/system` → Engines tab or a plugin author needs about one engine, with nothing invented.
 *
 * Derived, never hand-maintained: a second copy of `inputs`/`outputs` on the engine would drift
 * away from the transforms that actually declare them.
 */

import type { TransformRegistry } from './registry.ts';
import { ADAPTER_SUPPORT, containerArgs, resolveRuntime } from './runtime.ts';
import type {
  CapabilityId,
  DeploymentKind,
  EngineManifest,
  EngineRequirements,
  EntityKind,
  ExecutionClass,
  EngineRuntime,
  ManifestStatus,
  Permission,
  TransformId,
} from './types.ts';

export interface EngineDocument {
  readonly name: string;
  readonly version: string;
  readonly runtime: EngineRuntime;
  readonly deployment: DeploymentKind;
  /** Entity kinds the transforms served by this engine accept. */
  readonly inputs: readonly EntityKind[];
  readonly outputs: readonly EntityKind[];
  /** The capability it implements, plus the transforms that route to it. */
  readonly capabilities: readonly CapabilityId[];
  readonly transforms: readonly TransformId[];
  readonly requirements: EngineRequirements;
  readonly permissions: readonly Permission[];
  readonly execution: EngineExecution;
  readonly provider: EngineProviderFacts;
  readonly status: ManifestStatus;
}

export interface EngineExecution {
  readonly cost: ExecutionClass;
  readonly dataFlow: EngineManifest['dataFlow'];
  /** A terminal engine ends a chain without executing (link out, manual entry). */
  readonly terminal: boolean;
  readonly adapter: 'implemented' | 'planned';
  readonly hostCompatible: boolean;
  /** Slowest expected runtime across the transforms that use it; 0 when none do. */
  readonly expectedRuntimeMs: number;
  readonly maxResults: number;
  /** Docker flags this engine must run with; empty unless containerized. */
  readonly containerArgs: readonly string[];
}

export interface EngineProviderFacts {
  readonly id: string;
  readonly credentials: 'none' | 'optional' | 'required';
  readonly pricing: 'free' | 'free-tier' | 'paid' | 'local';
  readonly licence: string;
  readonly dataLicence?: string;
  readonly attribution?: string;
}

const unique = <T>(values: readonly T[]): readonly T[] => [...new Set(values)].sort();

export const engineDocument = (
  registry: TransformRegistry,
  engine: EngineManifest,
): EngineDocument => {
  const spec = resolveRuntime(engine);
  const transforms = registry.transforms.filter((transform) =>
    transform.engines.includes(engine.id),
  );
  const provider = registry.provider(engine.provider);

  return {
    name: engine.id,
    version: engine.version,
    runtime: spec.runtime,
    deployment: spec.deployment,
    inputs: unique(transforms.flatMap((transform) => transform.inputs)),
    outputs: unique(transforms.flatMap((transform) => transform.outputs)),
    capabilities: unique([engine.capability, ...transforms.map((t) => t.capability)]),
    transforms: transforms.map((transform) => transform.id),
    requirements: spec.requirements,
    permissions: [...engine.permissions],
    execution: {
      cost: engine.cost,
      dataFlow: engine.dataFlow,
      terminal: engine.terminal,
      adapter: ADAPTER_SUPPORT[spec.runtime],
      hostCompatible: spec.hostCompatible && spec.deployment !== 'unsupported',
      expectedRuntimeMs: Math.max(0, ...transforms.map((t) => t.limits.expectedRuntimeMs)),
      maxResults: Math.max(0, ...transforms.map((t) => t.limits.maxResults)),
      containerArgs: containerArgs(engine),
    },
    provider: {
      id: engine.provider,
      credentials: provider?.credentials ?? 'required',
      pricing: provider?.pricing ?? 'paid',
      // An unknown provider is never treated as permissively licensed: the install gate (§40)
      // must refuse it rather than wave through an unstated licence.
      licence: provider?.licence ?? 'unknown',
      ...(provider?.dataLicence ? { dataLicence: provider.dataLicence } : {}),
      ...(provider?.attribution ? { attribution: provider.attribution } : {}),
    },
    status: engine.status,
  };
};

/** Every engine in the registry, as documents, sorted by id. */
export const engineDocuments = (registry: TransformRegistry): readonly EngineDocument[] =>
  [...registry.engines]
    .map((engine) => engineDocument(registry, engine))
    .sort((a, b) => a.name.localeCompare(b.name));
