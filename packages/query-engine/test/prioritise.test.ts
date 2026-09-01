import {
  createCatalogRegistry,
  type PlanStep,
  type TransformPlan,
  type TransformRegistry,
} from '@nexus/transforms';
import { describe, expect, it } from 'vitest';

import { planQuery } from '../src/plan.ts';
import { prioritise, projectRuntimeMs, selectSteps } from '../src/prioritise.ts';

const step = (transform: string, overrides: Partial<PlanStep> = {}): PlanStep =>
  ({
    transform,
    inputKind: 'domain',
    dependsOn: [],
    depth: 1,
    chain: [],
    estimatedRuntimeMs: 1_000,
    maxResults: 20,
    ...overrides,
  }) as unknown as PlanStep;

const plan = (steps: readonly PlanStep[]): TransformPlan =>
  ({
    steps,
    estimate: { runtimeMs: 0, minEntities: 1, maxEntities: 100 },
    requiresNetwork: true,
    providersUsed: [],
    credentialsNeeded: ['shodan'],
    excluded: [{ transform: 'already.out', reason: 'blocked-by-mode' }],
  }) as unknown as TransformPlan;

/** A registry that knows nothing: every step falls back to the neutral priority weight. */
const bareRegistry = {
  transform: () => undefined,
  engine: () => undefined,
  provider: () => undefined,
} as unknown as TransformRegistry;

describe('projectRuntimeMs', () => {
  it('runs a depth together and depths after each other', () => {
    const steps = [
      step('a', { estimatedRuntimeMs: 1_000 }),
      step('b', { estimatedRuntimeMs: 3_000 }),
      step('c', { depth: 2, estimatedRuntimeMs: 2_000 }),
    ];
    expect(projectRuntimeMs(steps, 4)).toBe(5_000);
  });

  it('adds a batch when a depth is wider than the executor', () => {
    const steps = [step('a'), step('b'), step('c')];
    expect(projectRuntimeMs(steps, 2)).toBe(2_000);
  });

  it('is zero for an empty plan', () => {
    expect(projectRuntimeMs([], 4)).toBe(0);
  });
});

describe('selectSteps', () => {
  it('keeps the whole plan when everything fits', () => {
    const result = selectSteps(bareRegistry, plan([step('a'), step('b')]));
    expect(result.plan.steps.map((item) => item.transform)).toEqual(['a', 'b']);
    expect(result.dropped).toEqual([]);
    expect(result.projectedRuntimeMs).toBe(1_000);
  });

  it('drops a step that promises almost nothing for a long run', () => {
    const result = selectSteps(
      bareRegistry,
      plan([step('rich'), step('poor', { maxResults: 1, estimatedRuntimeMs: 120_000 })]),
    );
    expect(result.plan.steps.map((item) => item.transform)).toEqual(['rich']);
    expect(result.dropped[0]?.reason).toBe('cost-not-justified');
    expect(result.dropped[0]?.note).toMatch(/below/u);
  });

  it('enforces the step ceiling, best-scoring first', () => {
    const steps = [
      step('slow', { estimatedRuntimeMs: 8_000 }),
      step('quick', { estimatedRuntimeMs: 500 }),
    ];
    const result = selectSteps(bareRegistry, plan(steps), { maxSteps: 1 });
    expect(result.plan.steps.map((item) => item.transform)).toEqual(['quick']);
    expect(result.dropped[0]).toMatchObject({
      transform: 'slow',
      reason: 'over-resource-budget',
    });
  });

  it('refuses a step that would push the run past its wall-clock ceiling', () => {
    const steps = [step('a'), step('b', { depth: 2, estimatedRuntimeMs: 30_000 })];
    const result = selectSteps(bareRegistry, plan(steps), { maxRuntimeMs: 10_000 });
    expect(result.plan.steps.map((item) => item.transform)).toEqual(['a']);
    expect(result.dropped[0]?.note).toMatch(/ceiling/u);
  });

  it('admits a step together with the ancestors it consumes', () => {
    const steps = [
      step('root', { maxResults: 2, estimatedRuntimeMs: 4_000 }),
      step('leaf', { dependsOn: ['root'], depth: 2, maxResults: 50 }),
    ];
    const result = selectSteps(bareRegistry, plan(steps), { maxSteps: 2 });
    expect(result.plan.steps.map((item) => item.transform)).toEqual(['root', 'leaf']);
  });

  it('never keeps a step whose ancestor did not fit', () => {
    const steps = [
      step('root', { maxResults: 1, estimatedRuntimeMs: 200_000 }),
      step('leaf', { dependsOn: ['root'], depth: 2, maxResults: 50 }),
    ];
    const result = selectSteps(bareRegistry, plan(steps));
    expect(result.plan.steps).toEqual([]);
    expect(result.dropped.map((item) => item.transform).sort()).toEqual(['leaf', 'root']);
  });

  it('ignores a dependency on a step that is not in the plan', () => {
    const result = selectSteps(bareRegistry, plan([step('leaf', { dependsOn: ['absent'] })]));
    expect(result.plan.steps.map((item) => item.transform)).toEqual(['leaf']);
  });

  it('keeps the exclusions the planner already made and appends its own', () => {
    const result = selectSteps(
      bareRegistry,
      plan([step('poor', { maxResults: 1, estimatedRuntimeMs: 120_000 })]),
    );
    expect(result.plan.excluded.map((item) => item.transform)).toEqual(['already.out', 'poor']);
  });

  it('scores every step and says which ones survived', () => {
    const result = selectSteps(bareRegistry, plan([step('a'), step('b')]), { maxSteps: 1 });
    expect(result.scores).toHaveLength(2);
    expect(result.scores.filter((item) => item.kept)).toHaveLength(1);
    expect(result.scores[0]?.score).toBeGreaterThanOrEqual(result.scores[1]?.score ?? 0);
  });

  it('recomputes providers and credentials from the steps that survived', () => {
    const registry = createCatalogRegistry();
    const planned = planQuery(registry, 'example.com', {
      mode: 'maximum-coverage',
      configuredProviders: new Set<string>(),
      grantedPermissions: new Set(['network'] as const),
    });
    const source = planned.plan;
    if (source === undefined) throw new Error('the catalogue planned nothing for a domain');

    const result = selectSteps(registry, source, { maxSteps: 1 });
    expect(result.plan.steps).toHaveLength(1);
    expect(result.plan.providersUsed.length).toBeLessThanOrEqual(source.providersUsed.length);
    for (const provider of result.plan.credentialsNeeded) {
      expect(result.plan.providersUsed).toContain(provider);
    }
  });

  it('prices a real catalogue plan without dropping everything', () => {
    const registry = createCatalogRegistry();
    const planned = planQuery(registry, 'example.com', {
      mode: 'zero-credential',
      configuredProviders: new Set<string>(),
      grantedPermissions: new Set(['network'] as const),
    });
    const source = planned.plan;
    if (source === undefined) throw new Error('the catalogue planned nothing for a domain');

    const result = selectSteps(registry, source);
    expect(result.plan.steps.length).toBeGreaterThan(0);
    expect(result.plan.steps.length).toBeLessThanOrEqual(source.steps.length);
  });
});

describe('prioritise', () => {
  it('narrows a planned query and regroups what is now hidden', () => {
    const registry = createCatalogRegistry();
    const planned = planQuery(registry, 'example.com', {
      mode: 'maximum-coverage',
      configuredProviders: new Set<string>(),
      grantedPermissions: new Set(['network'] as const),
    });

    const trimmed = prioritise(registry, planned, { maxSteps: 2 });
    expect(trimmed.plan?.steps.length).toBeLessThanOrEqual(2);
    const hidden = trimmed.hidden.reduce((sum, group) => sum + group.count, 0);
    expect(hidden).toBe(trimmed.plan?.excluded.length);
  });

  it('leaves a query with nothing to plan alone', () => {
    const registry = createCatalogRegistry();
    const planned = planQuery(registry, '   ', {
      mode: 'zero-credential',
      configuredProviders: new Set<string>(),
      grantedPermissions: new Set(['network'] as const),
    });
    expect(prioritise(registry, planned)).toBe(planned);
  });
});
