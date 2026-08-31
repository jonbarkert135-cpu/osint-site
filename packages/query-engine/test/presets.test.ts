import { createCatalogRegistry, type PlannerContext } from '@nexus/transforms';
import { describe, expect, it } from 'vitest';

import {
  PRESET_IDS,
  QUERY_PRESETS,
  applyPreset,
  planWithPreset,
  queryPreset,
} from '../src/presets.ts';

const registry = createCatalogRegistry();

const ctx = (): Omit<PlannerContext, 'budget'> => ({
  mode: 'zero-credential',
  configuredProviders: new Set<string>(),
  grantedPermissions: new Set(['network', 'subprocess', 'filesystem'] as const),
});

describe('query presets', () => {
  it('ships every preset the brief asks for, and nothing unnamed', () => {
    expect(QUERY_PRESETS.map((preset) => preset.id)).toEqual([...PRESET_IDS]);
  });

  it('custom imposes nothing', () => {
    const custom = queryPreset('custom');
    expect(custom.budget).toBeUndefined();
    expect(custom.costCeiling).toBeUndefined();
    expect(custom.kind).toBeUndefined();
  });

  it('a quick scan is never broader than a deep scan', () => {
    const quick = planWithPreset(registry, 'octocat', ctx(), 'quick-scan');
    const deep = planWithPreset(registry, 'octocat', ctx(), 'deep-scan');
    expect(quick.plan?.steps.length ?? 0).toBeLessThanOrEqual(deep.plan?.steps.length ?? 0);
    expect(quick.plan?.estimate.runtimeMs ?? 0).toBeLessThanOrEqual(
      deep.plan?.estimate.runtimeMs ?? 0,
    );
  });

  it('a quick scan plans no deep engine', () => {
    const quick = planWithPreset(registry, 'example.com', ctx(), 'quick-scan');
    // The engine that actually runs is the first non-terminal link of the chain; the rest are
    // fallbacks the router keeps for a retry.
    const primaries = (quick.plan?.steps ?? []).flatMap((step) => {
      const engine = step.chain.map((id) => registry.engine(id)).find((e) => e && !e.terminal);
      return engine ? [engine.cost] : [];
    });
    expect(primaries.length).toBeGreaterThan(0);
    expect(primaries).not.toContain('deep');
  });

  it('an investigation preset locks the entity type', () => {
    // "octocat" types as a username first; the repository preset must still route as a repo.
    const plan = planWithPreset(registry, 'octocat/hello-world', ctx(), 'repository-analysis');
    expect(plan.chosen?.kind).toBe('repo');
  });

  it('explicit caller options beat the preset', () => {
    const plan = planWithPreset(registry, 'example.com', ctx(), 'repository-analysis', {
      kind: 'domain',
    });
    expect(plan.chosen?.kind).toBe('domain');
  });

  it('a caller budget beats the preset budget', () => {
    const budget = {
      maxNewNodes: 5,
      maxDepth: 1,
      maxRuntimeMs: 1_000,
      maxParallel: 1,
      maxTransforms: 1,
    };
    const merged = applyPreset(queryPreset('deep-scan'), { ...ctx(), budget });
    expect(merged.budget).toBe(budget);
  });

  it('document analysis is a node preset: it locks the file kind, which no text types to', () => {
    expect(queryPreset('document-analysis').kind).toBe('file');
    const merged = applyPreset(queryPreset('document-analysis'), ctx());
    expect(merged.costCeiling?.maxExecutionClass).toBe('standard');
  });

  it('every text preset produces a plan for its own entity type', () => {
    const inputs: Record<string, string> = {
      'repository-analysis': 'octocat/hello-world',
      'username-investigation': 'octocat',
      'domain-investigation': 'example.com',
    };
    for (const [id, input] of Object.entries(inputs)) {
      const plan = planWithPreset(registry, input, ctx(), id as Parameters<typeof queryPreset>[0]);
      expect(plan.plan?.steps.length ?? 0).toBeGreaterThan(0);
    }
  });
});
