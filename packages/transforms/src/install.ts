/**
 * Plugin installation (Part 2 §40): "Install Integration" as an ordered gate list.
 *
 * The pipeline is pure and injectable — it takes a bundle of manifests plus the checks it is not
 * allowed to invent (health probe, licence policy, granted permissions) and returns a report plus,
 * only when every gate passed, a *new* registry. Nothing is mutated, nothing is downloaded here:
 * fetching and unpacking belong to the caller, judging belongs here.
 *
 * Every gate reports its own verdict. A gate that could not be evaluated is `failed` with the
 * reason, never silently skipped — an unverifiable install is a refused install (N4/U5).
 */

import { engineDocument } from './document.ts';
import { parseEngineManifest, parseProviderManifest, parseTransformManifest } from './manifest.ts';
import { createTransformRegistry, type TransformRegistry } from './registry.ts';
import type { EngineManifest, ManifestIssue, Permission, ProviderManifest } from './types.ts';

/** What the caller hands over: the manifests of one integration, already fetched and parsed as JSON. */
export interface EnginePackage {
  readonly engine: unknown;
  readonly provider?: unknown;
  readonly transforms?: readonly unknown[];
}

export const INSTALL_STEPS = [
  'manifest',
  'compatibility',
  'licence',
  'dependencies',
  'security',
  'adapter',
  'health-check',
  'register',
] as const;
export type InstallStepName = (typeof INSTALL_STEPS)[number];

export interface InstallStep {
  readonly step: InstallStepName;
  readonly status: 'ok' | 'failed' | 'not-run';
  readonly detail: string;
}

export interface InstallResult {
  readonly engine?: string;
  readonly installed: boolean;
  readonly steps: readonly InstallStep[];
  /** The registry with the package added — present only on a fully successful install. */
  readonly registry?: TransformRegistry;
}

export interface HealthProbe {
  (engine: EngineManifest, provider: ProviderManifest): Promise<boolean | string>;
}

export interface InstallContext {
  /** Permissions the workspace grants. An engine asking for more is refused, not downgraded. */
  readonly grantedPermissions: ReadonlySet<Permission>;
  /** Licences the workspace accepts, as written in the provider manifest (exact match). */
  readonly allowedLicences: ReadonlySet<string>;
  /**
   * Liveness check against the real engine. Returns true, or a string explaining the failure.
   * Required: an install nobody probed is an install nobody can trust.
   */
  readonly healthCheck: HealthProbe;
  /** Runtimes an adapter is wired for here; defaults to the repo's ADAPTER_SUPPORT table. */
  readonly implementedRuntimes?: ReadonlySet<string>;
}

const ok = (step: InstallStepName, detail: string): InstallStep => ({ step, status: 'ok', detail });
const failed = (step: InstallStepName, detail: string): InstallStep => ({
  step,
  status: 'failed',
  detail,
});

/** Steps after the failing one are reported as `not-run`, so the report shows where it stopped. */
const stopAt = (done: readonly InstallStep[], last: InstallStep): readonly InstallStep[] => {
  const reached = new Set([...done, last].map((entry) => entry.step));
  return [
    ...done,
    last,
    ...INSTALL_STEPS.filter((step) => !reached.has(step)).map((step) => ({
      step,
      status: 'not-run' as const,
      detail: 'not reached',
    })),
  ];
};

const issueList = (issues: readonly ManifestIssue[]): string =>
  issues.map((issue) => `${issue.kind} ${issue.id}: ${issue.message}`).join('; ');

const PINNED_IMAGE = /@sha256:[0-9a-f]{64}$/;

export const installEngine = async (
  registry: TransformRegistry,
  pkg: EnginePackage,
  ctx: InstallContext,
): Promise<InstallResult> => {
  const steps: InstallStep[] = [];
  const stop = (step: InstallStep, engine?: string): InstallResult => ({
    ...(engine ? { engine } : {}),
    installed: false,
    steps: stopAt(steps, step),
  });

  // 1. Manifest — the §39 schema is the contract; anything that fails it never reaches a gate.
  let engine: EngineManifest;
  let provider: ProviderManifest | undefined;
  let transforms: readonly unknown[];
  try {
    engine = parseEngineManifest(pkg.engine);
    provider = pkg.provider === undefined ? undefined : parseProviderManifest(pkg.provider);
    transforms = (pkg.transforms ?? []).map(parseTransformManifest);
  } catch (error) {
    return stop(failed('manifest', `invalid manifest: ${String(error)}`));
  }
  if (registry.engine(engine.id)) {
    return stop(failed('manifest', `engine "${engine.id}" is already installed`), engine.id);
  }
  steps.push(ok('manifest', `${engine.id}@${engine.version} validated`));

  // The candidate registry: needed to document and validate the package in context.
  const candidateInput = {
    transforms: [...registry.transforms, ...transforms],
    engines: [...registry.engines, engine],
    providers: [...registry.providers, ...(provider ? [provider] : [])],
  };
  let candidate: TransformRegistry;
  try {
    candidate = createTransformRegistry(candidateInput);
  } catch (error) {
    return stop(failed('manifest', `package does not compose: ${String(error)}`), engine.id);
  }
  const doc = engineDocument(candidate, engine);

  // 2. Compatibility — does this host profile (RAVEN-SPEC/29 §7) actually run it?
  if (!doc.execution.hostCompatible) {
    return stop(
      failed('compatibility', `${doc.runtime}/${doc.deployment} does not run on this host`),
      engine.id,
    );
  }
  steps.push(
    ok('compatibility', `${doc.runtime} · ${doc.deployment} · ${doc.requirements.memoryMb} MB`),
  );

  // 3. Licence — the provider states one and the workspace accepts it, or we stop.
  // An engine whose provider is missing has no stated licence at all, which is the same refusal.
  const resolvedProvider = candidate.provider(engine.provider);
  if (!resolvedProvider) {
    return stop(
      failed(
        'licence',
        `provider "${engine.provider}" is neither installed nor bundled, so no licence is stated`,
      ),
      engine.id,
    );
  }
  if (!ctx.allowedLicences.has(doc.provider.licence)) {
    return stop(failed('licence', `licence "${doc.provider.licence}" is not allowed`), engine.id);
  }
  steps.push(ok('licence', doc.provider.licence));

  // 4. Dependencies — provider present, image pinned, references resolve.
  const image = doc.requirements.image;
  if (doc.deployment === 'containerized' && (!image || !PINNED_IMAGE.test(image))) {
    return stop(
      failed('dependencies', `container image must be pinned by digest, got "${image ?? 'none'}"`),
      engine.id,
    );
  }
  const issues = candidate.validate();
  if (issues.length > 0) {
    return stop(failed('dependencies', issueList(issues)), engine.id);
  }
  steps.push(
    ok('dependencies', `provider ${resolvedProvider.id}${image ? `, image ${image}` : ''}`),
  );

  // 5. Security — permissions are granted, not requested-and-assumed.
  const missing = engine.permissions.filter(
    (permission) => !ctx.grantedPermissions.has(permission),
  );
  if (missing.length > 0) {
    return stop(failed('security', `permissions not granted: ${missing.join(', ')}`), engine.id);
  }
  steps.push(ok('security', `permissions: ${engine.permissions.join(', ') || 'none'}`));

  // 6. Adapter — a runtime with no adapter cannot execute, however well it validates (§37/§38).
  const supported = ctx.implementedRuntimes
    ? ctx.implementedRuntimes.has(doc.runtime)
    : doc.execution.adapter === 'implemented';
  if (!supported) {
    return stop(
      failed('adapter', `no adapter implemented for runtime "${doc.runtime}"`),
      engine.id,
    );
  }
  steps.push(ok('adapter', `${doc.runtime} adapter`));

  // 7. Health check — the only gate that touches the outside world.
  let health: boolean | string;
  try {
    health = await ctx.healthCheck(engine, resolvedProvider);
  } catch (error) {
    health = String(error);
  }
  if (health !== true) {
    return stop(
      failed('health-check', typeof health === 'string' ? health : 'health check failed'),
      engine.id,
    );
  }
  steps.push(ok('health-check', 'engine answered'));

  // 8. Register — the registry is replaced, never patched in place.
  steps.push(
    ok(
      'register',
      `registered ${engine.id} (${doc.transforms.length} transform(s), ${doc.capabilities.join(', ')})`,
    ),
  );
  return { engine: engine.id, installed: true, steps, registry: candidate };
};
