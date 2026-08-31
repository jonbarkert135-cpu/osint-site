import { describe, expect, it } from 'vitest';

import { engineDocument } from '../src/document.ts';
import { installEngine, type InstallContext } from '../src/install.ts';
import type { EngineManifest, ProviderManifest } from '../src/types.ts';
import {
  ALL_PERMISSIONS,
  buildRegistry,
  makeEngine,
  makeProvider,
  makeTransform,
} from './fixtures.ts';

const registry = buildRegistry();

const newEngine = (over: Partial<EngineManifest> = {}): EngineManifest =>
  makeEngine({ id: 'engine-b', capability: 'dns', provider: 'provider-b', ...over });

const newProvider = (over: Partial<ProviderManifest> = {}): ProviderManifest =>
  makeProvider({ id: 'provider-b', ...over });

const ctx = (over: Partial<InstallContext> = {}): InstallContext => ({
  grantedPermissions: new Set(ALL_PERMISSIONS),
  allowedLicences: new Set(['MIT', 'Apache-2.0']),
  healthCheck: async () => true,
  ...over,
});

const step = (result: Awaited<ReturnType<typeof installEngine>>, name: string) =>
  result.steps.find((entry) => entry.step === name);

describe('installEngine (Part 2 §40)', () => {
  it('runs every gate in order and registers the engine', async () => {
    const result = await installEngine(
      registry,
      { engine: newEngine(), provider: newProvider() },
      ctx(),
    );

    expect(result.installed).toBe(true);
    expect(result.steps.map((entry) => entry.step)).toEqual([
      'manifest',
      'compatibility',
      'licence',
      'dependencies',
      'security',
      'adapter',
      'health-check',
      'register',
    ]);
    expect(result.steps.every((entry) => entry.status === 'ok')).toBe(true);
    expect(result.registry?.engine('engine-b')).toBeDefined();
    // The source registry is untouched: install returns a new one.
    expect(registry.engine('engine-b')).toBeUndefined();
  });

  it('refuses a malformed manifest before any other gate runs', async () => {
    const result = await installEngine(registry, { engine: { id: 'nope' } }, ctx());
    expect(result.installed).toBe(false);
    expect(step(result, 'manifest')?.status).toBe('failed');
    expect(step(result, 'health-check')?.status).toBe('not-run');
  });

  it('refuses a licence the workspace does not allow', async () => {
    const result = await installEngine(
      registry,
      { engine: newEngine(), provider: newProvider({ licence: 'SSPL-1.0' }) },
      ctx(),
    );
    expect(result.installed).toBe(false);
    expect(step(result, 'licence')?.detail).toContain('SSPL-1.0');
  });

  it('refuses a container image that is not pinned by digest', async () => {
    const engine = newEngine({
      runtime: {
        runtime: 'python',
        deployment: 'containerized',
        requirements: { image: 'vendor/engine:latest', memoryMb: 256, cpu: 1, persistent: false },
        hostCompatible: true,
      },
    });
    const result = await installEngine(registry, { engine, provider: newProvider() }, ctx());
    expect(step(result, 'dependencies')?.detail).toContain('pinned by digest');
  });

  it('refuses an engine asking for a permission the workspace withheld', async () => {
    const result = await installEngine(
      registry,
      { engine: newEngine({ permissions: ['network', 'credentials'] }), provider: newProvider() },
      ctx({ grantedPermissions: new Set(['network'] as const) }),
    );
    expect(step(result, 'security')?.detail).toContain('credentials');
  });

  it('refuses a runtime with no adapter', async () => {
    const result = await installEngine(
      registry,
      { engine: newEngine(), provider: newProvider() },
      ctx({ implementedRuntimes: new Set(['python']) }),
    );
    expect(step(result, 'adapter')?.status).toBe('failed');
  });

  it('does not register an engine that fails its health check', async () => {
    const result = await installEngine(
      registry,
      { engine: newEngine(), provider: newProvider() },
      ctx({ healthCheck: async () => 'connection refused' }),
    );
    expect(result.installed).toBe(false);
    expect(step(result, 'health-check')?.detail).toBe('connection refused');
    expect(step(result, 'register')?.status).toBe('not-run');
  });

  it('treats a throwing probe as a failure, never as a pass', async () => {
    const result = await installEngine(
      registry,
      { engine: newEngine(), provider: newProvider() },
      ctx({
        healthCheck: async () => {
          throw new Error('boom');
        },
      }),
    );
    expect(result.installed).toBe(false);
    expect(step(result, 'health-check')?.detail).toContain('boom');
  });

  it('refuses a package whose provider is neither installed nor bundled', async () => {
    const result = await installEngine(registry, { engine: newEngine() }, ctx());
    expect(step(result, 'licence')?.status).toBe('failed');
    expect(step(result, 'licence')?.detail).toContain('neither installed nor bundled');
  });

  it('refuses to install the same engine twice', async () => {
    const result = await installEngine(
      registry,
      { engine: newEngine({ id: 'engine-a', provider: 'provider-a' }) },
      ctx(),
    );
    expect(step(result, 'manifest')?.detail).toContain('already installed');
  });
});

describe('engineDocument (Part 2 §39)', () => {
  it('joins engine, provider and transforms into one flat document', () => {
    const registryWithTransform = buildRegistry({
      transforms: [
        makeTransform({ id: 'domain-to-ip', capability: 'dns' }),
        makeTransform({
          id: 'domain-to-certs',
          capability: 'dns',
          inputs: ['domain', 'hostname'],
          outputs: ['certificate'],
          limits: { expectedRuntimeMs: 9_000, maxResults: 50, maxInputBatch: 5 },
        }),
      ],
    });
    const engine = registryWithTransform.engine('engine-a');
    const doc = engineDocument(registryWithTransform, engine!);

    expect(doc.name).toBe('engine-a');
    expect(doc.inputs).toEqual(['domain', 'hostname']);
    expect(doc.outputs).toEqual(['certificate', 'ip']);
    expect(doc.capabilities).toEqual(['dns']);
    expect(doc.transforms).toEqual(['domain-to-ip', 'domain-to-certs']);
    expect(doc.execution.expectedRuntimeMs).toBe(9_000);
    expect(doc.execution.adapter).toBe('implemented');
    expect(doc.provider.licence).toBe('MIT');
  });

  it('never reports an unknown provider as permissively licensed', () => {
    const orphan = makeEngine({ id: 'orphan', capability: 'dns', provider: 'ghost' });
    const doc = engineDocument(registry, orphan);
    expect(doc.provider.licence).toBe('unknown');
    expect(doc.provider.credentials).toBe('required');
  });
});

describe('installEngine safe defaults and reviews (Part 2 §59–§61)', () => {
  const project = {
    id: 'engine-b',
    version: '1.0.0',
    licence: 'MIT',
    dependencies: [{ name: 'lib', licence: 'MIT' }],
    advisories: [],
    executionModel: 'remote-api' as const,
    permissions: ['network' as const],
    redistribution: 'permitted' as const,
  };

  it('never enables what it installs, and says what is still pending (§61)', async () => {
    const result = await installEngine(
      registry,
      { engine: newEngine(), provider: newProvider() },
      ctx({ project, licencePolicy: { allowed: new Set(['MIT']), commercial: true } }),
    );

    expect(result.installed).toBe(true);
    expect(result.enabled).toBe(false);
    expect(result.pending).toContain(
      'governance: record an owner, the §62 test kinds and a deprecation policy (§58)',
    );
  });

  it('admits when nothing but the manifest was checked', async () => {
    const result = await installEngine(
      registry,
      { engine: newEngine(), provider: newProvider() },
      ctx(),
    );

    expect(result.pending).toEqual([
      'licence: only the provider manifest was checked; no dependency licence scan ran',
      'security: no execution-model, dependency or vulnerability review was supplied',
      'governance: record an owner, the §62 test kinds and a deprecation policy (§58)',
    ]);
  });

  it('fails the licence gate on a dependency with no stated licence (§60)', async () => {
    const result = await installEngine(
      registry,
      { engine: newEngine(), provider: newProvider() },
      ctx({
        project: { ...project, dependencies: [{ name: 'vendored', licence: 'unknown' }] },
        licencePolicy: { allowed: new Set(['MIT']), commercial: true },
      }),
    );

    expect(result.installed).toBe(false);
    expect(step(result, 'licence')?.status).toBe('failed');
    expect(step(result, 'licence')?.detail).toContain('states no licence');
  });

  it('fails the security gate on a project that runs third-party code (§59)', async () => {
    const result = await installEngine(
      registry,
      { engine: newEngine(), provider: newProvider() },
      ctx({
        project: { ...project, runsUntrustedCode: true },
        licencePolicy: { allowed: new Set(['MIT']), commercial: true },
      }),
    );

    expect(result.installed).toBe(false);
    expect(step(result, 'security')?.status).toBe('failed');
    expect(step(result, 'security')?.detail).toContain('executes third-party code');
  });

  it('installs a project whose review only warns, and carries the warning into pending', async () => {
    const result = await installEngine(
      registry,
      { engine: newEngine(), provider: newProvider() },
      ctx({
        project: {
          ...project,
          advisories: [{ id: 'GHSA-9', severity: 'high' as const, fixedIn: '1.1.0' }],
        },
        licencePolicy: { allowed: new Set(['MIT']), commercial: true },
      }),
    );

    expect(result.installed).toBe(true);
    expect(result.pending.some((entry) => entry.includes('GHSA-9'))).toBe(true);
  });
});
