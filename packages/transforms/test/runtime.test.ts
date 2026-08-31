import { describe, expect, it } from 'vitest';

import { makeEngine } from './fixtures.ts';
import { ENGINES } from '../src/catalog/engines.ts';
import {
  ADAPTER_SUPPORT,
  compatibilityMatrix,
  compatibilityRow,
  containerArgs,
  incompatible,
  resolveRuntime,
} from '../src/runtime.ts';
import type { EngineRuntimeSpec } from '../src/types.ts';

describe('resolveRuntime', () => {
  it('prefers a declared passport over anything derived', () => {
    const runtime: EngineRuntimeSpec = {
      runtime: 'rust',
      deployment: 'native',
      requirements: { memoryMb: 64, cpu: 1, persistent: false },
      hostCompatible: true,
    };
    const engine = makeEngine({ id: 'declared', capability: 'c', provider: 'p', runtime });
    expect(resolveRuntime(engine)).toEqual(runtime);
  });

  it('treats a subprocess engine as containerized', () => {
    const engine = makeEngine({
      id: 'cli-thing',
      capability: 'c',
      provider: 'p',
      permissions: ['network', 'subprocess'],
    });
    const spec = resolveRuntime(engine);
    expect(spec.runtime).toBe('cli');
    expect(spec.deployment).toBe('containerized');
  });

  it('sends a browser engine to an external worker with a stated strategy', () => {
    const engine = makeEngine({
      id: 'browsy',
      capability: 'c',
      provider: 'p',
      permissions: ['network', 'browser'],
    });
    const spec = resolveRuntime(engine);
    expect(spec.deployment).toBe('external');
    expect(spec.fallback?.strategy).toBe('external-worker');
  });

  it('runs a terminal engine natively and cheaply', () => {
    const engine = makeEngine({ id: 'link-out', capability: 'c', provider: 'p', terminal: true });
    const spec = resolveRuntime(engine);
    expect(spec.deployment).toBe('native');
    expect(spec.requirements.memoryMb).toBe(64);
  });

  it('classifies external-api engines as native HTTP callers', () => {
    const engine = makeEngine({
      id: 'api',
      capability: 'c',
      provider: 'p',
      dataFlow: 'external-api',
    });
    expect(resolveRuntime(engine).runtime).toBe('external-api');
  });

  it('marks a local filesystem engine as needing persistence', () => {
    const engine = makeEngine({
      id: 'local',
      capability: 'c',
      provider: 'p',
      dataFlow: 'local',
      permissions: ['filesystem'],
    });
    const spec = resolveRuntime(engine);
    expect(spec.runtime).toBe('node');
    expect(spec.requirements.persistent).toBe(true);
  });

  it('uses the explicit override for sherlock', () => {
    const sherlock = ENGINES.find((engine) => engine.id === 'sherlock');
    expect(sherlock).toBeDefined();
    const spec = resolveRuntime(sherlock!);
    expect(spec.runtime).toBe('python');
    expect(spec.requirements.image).toBeDefined();
  });
});

describe('compatibility matrix (§34)', () => {
  it('covers every catalogue engine exactly once', () => {
    const matrix = compatibilityMatrix(ENGINES);
    const total = Object.values(matrix).reduce((sum, rows) => sum + rows.length, 0);
    expect(total).toBe(ENGINES.length);
  });

  it('keeps the four deployment classes separate and sorted', () => {
    const matrix = compatibilityMatrix(ENGINES);
    expect(Object.keys(matrix).sort()).toEqual([
      'containerized',
      'external',
      'native',
      'unsupported',
    ]);
    const ids = matrix.native.map((row) => row.engine);
    expect([...ids].sort()).toEqual(ids);
  });

  it('reports docker only for containerized engines', () => {
    for (const row of Object.values(compatibilityMatrix(ENGINES)).flat()) {
      expect(row.docker).toBe(row.deployment === 'containerized');
    }
  });

  it('states an alternative for anything that is not plain native', () => {
    const external = makeEngine({
      id: 'browsy',
      capability: 'c',
      provider: 'p',
      permissions: ['network', 'browser'],
    });
    expect(compatibilityRow(external).alternative).toContain('External worker');
  });

  it('flags an unsupported engine as host-incompatible with a replacement', () => {
    const engine = makeEngine({
      id: 'gpu-thing',
      capability: 'c',
      provider: 'p',
      runtime: {
        runtime: 'rust',
        deployment: 'unsupported',
        requirements: { memoryMb: 8192, cpu: 8, persistent: true },
        hostCompatible: false,
        fallback: { strategy: 'replacement', target: 'hosted-api' },
      },
    });
    const row = compatibilityRow(engine);
    expect(row.hostCompatible).toBe(false);
    expect(row.alternative).toBe('Replacement: hosted-api');
    expect(incompatible([engine])).toHaveLength(1);
  });
});

describe('containerArgs', () => {
  it('always constrains memory, cpu, pids and capabilities', () => {
    const sherlock = ENGINES.find((engine) => engine.id === 'sherlock')!;
    const args = containerArgs(sherlock);
    expect(args).toContain('--memory=512m');
    expect(args).toContain('--pids-limit=128');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--read-only');
  });

  it('returns nothing for a native engine', () => {
    const engine = makeEngine({ id: 'api', capability: 'c', provider: 'p' });
    expect(containerArgs(engine)).toEqual([]);
  });
});

describe('ADAPTER_SUPPORT', () => {
  it('is honest about which runtimes are only planned', () => {
    expect(ADAPTER_SUPPORT.rust).toBe('planned');
    expect(ADAPTER_SUPPORT.http).toBe('implemented');
    expect(ADAPTER_SUPPORT.cli).toBe('implemented');
    expect(ADAPTER_SUPPORT.python).toBe('implemented');
  });
});
