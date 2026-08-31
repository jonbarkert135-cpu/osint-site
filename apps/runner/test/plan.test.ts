import { describe, expect, it } from 'vitest';

import { createCatalogRegistry, type HostFetch, type PlannerContext } from '@nexus/transforms';
import { planQuery } from '@nexus/query-engine';
import type { AdapterInput, CliExit } from '@nexus/transforms';

import { createHostAdapters, createHostEngines, runHostPlan } from '../src/plan.ts';
import { createCliAdapter, createPythonAdapter } from '@nexus/transforms';
import { AdapterRegistry } from '@nexus/transforms';

const registry = createCatalogRegistry();

const ctx = (): PlannerContext => ({
  mode: 'zero-credential',
  configuredProviders: new Set<string>(),
  grantedPermissions: new Set(['network', 'subprocess'] as const),
  budget: {
    maxNewNodes: 1_000,
    maxDepth: 1,
    maxRuntimeMs: 60_000,
    maxParallel: 4,
    maxTransforms: 12,
  },
});

/** Nothing is mocked on purpose: an engine may fail, the run may not (U5). */
const fetchStub: HostFetch = () => Promise.resolve({ status: 503, body: null });

const cliRun = (calls: AdapterInput[]) => {
  return (input: AdapterInput): Promise<CliExit> => {
    calls.push(input);
    return Promise.resolve({ code: 0, stdout: 'sub.example.com\n' });
  };
};

const adaptersWith = (calls: AdapterInput[]): AdapterRegistry => {
  const run = cliRun(calls);
  return new AdapterRegistry()
    .register(createCliAdapter({ run }))
    .register(createPythonAdapter({ run }));
};

describe('runner plan host', () => {
  it('registers the four host adapters this process can serve', () => {
    const adapters = createHostAdapters({
      manifestFor: () => undefined,
      executor: { execute: () => Promise.reject(new Error('unused')) } as never,
      readArtifact: () => Promise.resolve(''),
      runId: () => 'run-1',
    });

    expect(adapters.get('cli')).toBeDefined();
    expect(adapters.get('python')).toBeDefined();
    expect(adapters.get('go')).toBeDefined();
    expect(adapters.get('rust')).toBeDefined();
  });

  it('offers adapter-backed engines on top of the builtin ones', () => {
    const engines = createHostEngines(adaptersWith([]), registry);

    expect(engines.get('subfinder')).toBeDefined();
    expect(engines.get('sherlock')).toBeDefined();
    // Builtins stay available; the adapters add to the library, they do not replace it.
    expect(engines.get('doh-resolver')).toBeDefined();
  });

  it('leaves out engines whose runtime has no adapter here', () => {
    const engines = createHostEngines(new AdapterRegistry(), registry);

    expect(engines.get('subfinder')).toBeUndefined();
    expect(engines.get('doh-resolver')).toBeDefined();
  });

  it('dispatches only what governance enabled (Part 2 §61)', () => {
    const engines = createHostEngines(adaptersWith([]), registry, new Set(['sherlock']));

    expect(engines.get('sherlock')).toBeDefined();
    expect(engines.get('subfinder')).toBeUndefined();
    // Builtins are part of this build and shipped with their own tests; they are not gated here.
    expect(engines.get('doh-resolver')).toBeDefined();
  });

  it('runs a plan with the host library and returns the investigation', async () => {
    const calls: AdapterInput[] = [];
    const events: string[] = [];
    const result = await runHostPlan(planQuery(registry, 'example.com', ctx()), {
      adapters: adaptersWith(calls),
      registry,
      mode: 'zero-credential',
      fetch: fetchStub,
      onEvent: (event) => events.push(event.type),
    });

    expect(events[0]).toBe('plan.started');
    expect(events.at(-1)).toBe('plan.done');
    // The adapter, not the network, produced this one: the registry reached the executor.
    expect(calls.some((call) => call.engineId === 'subfinder')).toBe(true);
    expect(result.entities.map((entity) => entity.value)).toContain('sub.example.com');
  });
});
