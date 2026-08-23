import { createCatalogRegistry, type PlannerContext } from '@nexus/transforms';
import { describe, expect, it } from 'vitest';

import { planQuery } from '../src/plan.ts';

const ctx = (
  overrides: Partial<Omit<PlannerContext, 'budget'>> = {},
): Omit<PlannerContext, 'budget'> => ({
  mode: 'zero-credential',
  configuredProviders: new Set<string>(),
  grantedPermissions: new Set(['network'] as const),
  ...overrides,
});

describe('planQuery', () => {
  const registry = createCatalogRegistry();

  it('plans something for a domain without asking which engine to use', () => {
    const result = planQuery(registry, 'example.com', ctx());
    expect(result.chosen?.kind).toBe('domain');
    expect(result.plan?.steps.length).toBeGreaterThan(0);
  });

  it('honours an explicit type override', () => {
    const result = planQuery(registry, 'example.com', ctx(), { kind: 'company' });
    expect(result.chosen?.kind).toBe('company');
  });

  it('reports nothing to plan when the override matches no candidate', () => {
    const result = planQuery(registry, 'example.com', ctx(), { kind: 'asn' });
    expect(result.chosen).toBeUndefined();
    expect(result.plan).toBeUndefined();
    expect(result.hidden).toEqual([]);
  });

  it('groups the reasons capabilities were dropped, biggest group first', () => {
    const result = planQuery(registry, 'example.com', ctx({ mode: 'strict-local' }), {
      depth: 'deep',
    });
    const counts = result.hidden.map((group) => group.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    expect(result.hidden.length).toBeGreaterThan(0);
  });

  it('a stricter mode never plans more than a permissive one', () => {
    const strict = planQuery(registry, 'example.com', ctx({ mode: 'strict-local' }));
    const open = planQuery(registry, 'example.com', ctx({ mode: 'maximum-coverage' }));
    expect(strict.plan?.steps.length ?? 0).toBeLessThanOrEqual(open.plan?.steps.length ?? 0);
  });

  it('returns candidates but no plan for an empty query', () => {
    const result = planQuery(registry, '  ', ctx());
    expect(result.candidates).toEqual([]);
    expect(result.plan).toBeUndefined();
    expect(result.ambiguous).toBe(false);
  });
});
