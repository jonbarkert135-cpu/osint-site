import { describe, expect, it, vi } from 'vitest';

import { makeEngine } from './fixtures.ts';
import {
  AdapterRegistry,
  canDispatch,
  type AdapterResult,
  type EngineAdapter,
} from '../src/adapters.ts';
import type { EngineRuntime } from '../src/types.ts';

const stubAdapter = (runtime: EngineRuntime, result?: AdapterResult): EngineAdapter => ({
  runtime,
  available: () => true,
  execute: vi.fn(async (): Promise<AdapterResult> => result ?? { ok: true, output: { items: [] } }),
});

describe('AdapterRegistry (§37)', () => {
  it('resolves an adapter for an engine without the caller naming a runtime', () => {
    const registry = new AdapterRegistry().register(stubAdapter('external-api'));
    const engine = makeEngine({
      id: 'api',
      capability: 'c',
      provider: 'p',
      dataFlow: 'external-api',
    });
    expect(registry.for(engine)?.runtime).toBe('external-api');
  });

  it('lists registered runtimes sorted', () => {
    const registry = new AdapterRegistry()
      .register(stubAdapter('node'))
      .register(stubAdapter('http'));
    expect(registry.runtimes()).toEqual(['http', 'node']);
  });

  it('returns undefined rather than throwing for an unknown runtime', () => {
    expect(new AdapterRegistry().get('rust')).toBeUndefined();
  });

  it('passes progress and output through the adapter contract', async () => {
    const onProgress = vi.fn();
    const adapter = stubAdapter('node', { ok: true, output: { items: [{ a: 1 }] } });
    const result = await adapter.execute(
      { engineId: 'e', capability: 'c', payload: {}, timeoutMs: 1000 },
      onProgress,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.items).toHaveLength(1);
  });
});

describe('canDispatch', () => {
  it('allows an engine whose adapter is registered', () => {
    const registry = new AdapterRegistry().register(stubAdapter('external-api'));
    const engine = makeEngine({
      id: 'api',
      capability: 'c',
      provider: 'p',
      dataFlow: 'external-api',
    });
    expect(canDispatch(registry, engine)).toBeNull();
  });

  it('distinguishes a planned adapter from a missing one', () => {
    const engine = makeEngine({
      id: 'browser-thing',
      capability: 'c',
      provider: 'p',
      permissions: ['browser'],
    });
    expect(canDispatch(new AdapterRegistry(), engine)).toEqual({
      reason: 'adapter-planned',
      runtime: 'browser-worker',
    });
  });

  it('reports a missing adapter for a runtime that is supposed to work', () => {
    const engine = makeEngine({ id: 'api', capability: 'c', provider: 'p' });
    expect(canDispatch(new AdapterRegistry(), engine)).toEqual({
      reason: 'no-adapter',
      runtime: 'http',
    });
  });

  it('refuses a host-incompatible engine before looking for an adapter', () => {
    const engine = makeEngine({
      id: 'nope',
      capability: 'c',
      provider: 'p',
      runtime: {
        runtime: 'node',
        deployment: 'unsupported',
        requirements: { memoryMb: 64, cpu: 1, persistent: false },
        hostCompatible: false,
        fallback: { strategy: 'replacement' },
      },
    });
    const registry = new AdapterRegistry().register(stubAdapter('node'));
    expect(canDispatch(registry, engine)).toEqual({
      reason: 'host-incompatible',
      runtime: 'node',
    });
  });
});
