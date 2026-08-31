/**
 * Engine runtime passports, compatibility matrix and incompatibility strategies.
 * Part 2 §34 (matrix), §35 (never bend the architecture), §38 (multi-runtime), §39 (manifest).
 *
 * Host profile this is judged against: RAVEN-SPEC/29_RUNTIME_ENVIRONMENT.md §7 — a self-managed
 * Linux VPS with root, Docker Engine and a persistent disk. Nothing here assumes Kubernetes,
 * a GPU, or a managed platform primitive.
 */

import type {
  DeploymentKind,
  EngineManifest,
  EngineRuntime,
  EngineRuntimeSpec,
  FallbackStrategy,
} from './types.ts';

/**
 * Which runtimes have a working adapter today. The architecture accepts all of them (§38);
 * this table is the honest statement of what is actually wired, so the UI can say "planned"
 * instead of pretending.
 */
export const ADAPTER_SUPPORT: Readonly<Record<EngineRuntime, 'implemented' | 'planned'>> = {
  node: 'implemented',
  http: 'implemented',
  'external-api': 'implemented',
  cli: 'implemented',
  python: 'implemented',
  go: 'implemented',
  rust: 'implemented',
  'browser-worker': 'planned',
};

export const DEPLOYMENT_LABEL: Readonly<Record<DeploymentKind, string>> = {
  native: 'Native',
  containerized: 'Containerized',
  external: 'External',
  unsupported: 'Unsupported',
};

export const FALLBACK_LABEL: Readonly<Record<FallbackStrategy, string>> = {
  'native-adapter': 'Native adapter',
  'external-worker': 'External worker',
  'remote-execution': 'Remote execution',
  'optional-integration': 'Optional integration',
  replacement: 'Replacement',
};

/** Conservative default footprint for an engine that does not state its own. */
const DEFAULT_REQUIREMENTS = { memoryMb: 256, cpu: 1, persistent: false } as const;

/**
 * Explicit passports for engines whose shape cannot be inferred from permissions alone.
 * Everything else is derived; a wrong derived value is visible in the matrix and fixable here.
 */
const OVERRIDES: Readonly<Record<string, EngineRuntimeSpec>> = {
  sherlock: {
    runtime: 'python',
    deployment: 'containerized',
    requirements: {
      image: 'sherlock/sherlock:latest',
      memoryMb: 512,
      cpu: 1,
      persistent: false,
    },
    hostCompatible: true,
  },
  'git-clone-analysis': {
    runtime: 'cli',
    deployment: 'native',
    requirements: { memoryMb: 1024, cpu: 1, persistent: true },
    hostCompatible: true,
  },
};

const isNetworkless = (engine: EngineManifest): boolean => engine.dataFlow === 'local';

/**
 * Derive a passport from what the manifest already declares.
 *
 * The rules are deliberately dull: a terminal engine executes nothing, an external-api engine is
 * an HTTP call, a subprocess engine is a CLI, browser permission means a browser worker.
 */
const derive = (engine: EngineManifest): EngineRuntimeSpec => {
  const permissions = new Set(engine.permissions);

  if (engine.terminal) {
    return {
      runtime: 'node',
      deployment: 'native',
      requirements: { ...DEFAULT_REQUIREMENTS, memoryMb: 64 },
      hostCompatible: true,
    };
  }

  if (permissions.has('browser')) {
    return {
      runtime: 'browser-worker',
      deployment: 'external',
      requirements: { memoryMb: 1024, cpu: 1, persistent: false },
      hostCompatible: true,
      fallback: {
        strategy: 'external-worker',
        note: 'headless browser is heavy; keep it off the main box when a queue exists',
      },
    };
  }

  if (permissions.has('subprocess')) {
    return {
      runtime: 'cli',
      deployment: 'containerized',
      requirements: { memoryMb: 512, cpu: 1, persistent: false },
      hostCompatible: true,
    };
  }

  if (engine.dataFlow === 'external-api') {
    return {
      runtime: 'external-api',
      deployment: 'native',
      requirements: { ...DEFAULT_REQUIREMENTS, memoryMb: 128 },
      hostCompatible: true,
    };
  }

  return {
    runtime: isNetworkless(engine) ? 'node' : 'http',
    deployment: 'native',
    requirements: { ...DEFAULT_REQUIREMENTS, persistent: permissions.has('filesystem') },
    hostCompatible: true,
  };
};

/** The passport for an engine: declared, overridden, or derived — in that order. */
export const resolveRuntime = (engine: EngineManifest): EngineRuntimeSpec =>
  engine.runtime ?? OVERRIDES[engine.id] ?? derive(engine);

export interface CompatibilityRow {
  readonly engine: string;
  readonly runtime: EngineRuntime;
  readonly deployment: DeploymentKind;
  readonly docker: boolean;
  readonly memoryMb: number;
  readonly cpu: number;
  readonly persistent: boolean;
  readonly hostCompatible: boolean;
  readonly adapter: 'implemented' | 'planned';
  /** §35: what to do instead, when the engine does not fit as-is. */
  readonly alternative: string | null;
}

const alternativeFor = (spec: EngineRuntimeSpec): string | null => {
  if (spec.fallback) {
    const label = FALLBACK_LABEL[spec.fallback.strategy];
    return spec.fallback.target ? `${label}: ${spec.fallback.target}` : label;
  }
  if (spec.deployment === 'unsupported') return FALLBACK_LABEL.replacement;
  if (spec.deployment === 'external') return FALLBACK_LABEL['remote-execution'];
  return null;
};

/** One row per engine (Part 2 §34). */
export const compatibilityRow = (engine: EngineManifest): CompatibilityRow => {
  const spec = resolveRuntime(engine);
  return {
    engine: engine.id,
    runtime: spec.runtime,
    deployment: spec.deployment,
    docker: spec.deployment === 'containerized',
    memoryMb: spec.requirements.memoryMb,
    cpu: spec.requirements.cpu,
    persistent: spec.requirements.persistent,
    hostCompatible: spec.hostCompatible && spec.deployment !== 'unsupported',
    adapter: ADAPTER_SUPPORT[spec.runtime],
    alternative: alternativeFor(spec),
  };
};

export type CompatibilityMatrix = Readonly<Record<DeploymentKind, readonly CompatibilityRow[]>>;

/** The full matrix, grouped by deployment kind so the four classes stay visually separate (§34). */
export const compatibilityMatrix = (engines: readonly EngineManifest[]): CompatibilityMatrix => {
  const grouped: Record<DeploymentKind, CompatibilityRow[]> = {
    native: [],
    containerized: [],
    external: [],
    unsupported: [],
  };
  for (const engine of engines) {
    const row = compatibilityRow(engine);
    grouped[row.deployment].push(row);
  }
  for (const kind of Object.keys(grouped) as DeploymentKind[]) {
    grouped[kind].sort((a, b) => a.engine.localeCompare(b.engine));
  }
  return grouped;
};

/**
 * Docker flags an engine must be run with. Root on the box is not a licence to skip limits —
 * see RAVEN-SPEC/29 §7.3.
 */
export const containerArgs = (engine: EngineManifest): readonly string[] => {
  const spec = resolveRuntime(engine);
  if (spec.deployment !== 'containerized') return [];
  return [
    `--memory=${spec.requirements.memoryMb}m`,
    `--cpus=${spec.requirements.cpu}`,
    '--pids-limit=128',
    '--read-only',
    '--cap-drop=ALL',
    ...(spec.requirements.persistent ? [] : ['--network=bridge']),
  ];
};

/** Engines that cannot run as-is on this host, with the strategy that replaces them (§35). */
export const incompatible = (engines: readonly EngineManifest[]): readonly CompatibilityRow[] =>
  engines.map(compatibilityRow).filter((row) => !row.hostCompatible || row.adapter === 'planned');
