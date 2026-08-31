import { describe, expect, it } from 'vitest';

import { createCatalogRegistry } from '../src/catalog/index.ts';
import { DEFAULT_COST_CEILING, costProfile, costVerdict } from '../src/cost.ts';
import { expand, DEFAULT_BUDGET, type PlannerContext } from '../src/planner.ts';

const registry = createCatalogRegistry();

const ctx = (overrides: Partial<PlannerContext> = {}): PlannerContext => ({
  mode: 'zero-credential',
  configuredProviders: new Set<string>(),
  grantedPermissions: new Set(['network'] as const),
  budget: DEFAULT_BUDGET,
  ...overrides,
});

const profileFor = (transformId: string) => {
  const transform = registry.transform(transformId);
  if (!transform) throw new Error(`fixture drift: ${transformId} is gone`);
  const engine = registry.enginesFor(transform).find((candidate) => !candidate.terminal);
  if (!engine) throw new Error(`fixture drift: ${transformId} has no executable engine`);
  const provider = registry.provider(engine.provider);
  if (!provider) throw new Error(`fixture drift: ${engine.provider} is gone`);
  return costProfile(transform, engine, provider);
};

describe('costProfile', () => {
  it('prices a containerized engine from its runtime passport', () => {
    const profile = profileFor('username-to-profiles');
    expect(profile.engine).toBe('sherlock');
    expect(profile.cpu).toBeGreaterThan(0);
    expect(profile.memoryMb).toBeGreaterThan(0);
    expect(profile.runtimeMs).toBe(25_000);
    expect(profile.executionClass).toBe('deep');
  });

  it('charges a local engine nothing for the network', () => {
    const transform = registry.transform('file-to-hashes');
    const local = registry.engines.find((engine) => engine.dataFlow === 'local');
    if (!transform || !local) throw new Error('fixture drift: no local engine in the catalog');
    const provider = registry.provider(local.provider);
    if (!provider) throw new Error('fixture drift: provider is gone');
    expect(costProfile(transform, local, provider).networkRequests).toBe(0);
  });

  it('assumes pagination instead of one request per run', () => {
    // 60 results, 10 inputs per call → six pages, not one request.
    expect(profileFor('username-to-profiles').networkRequests).toBe(6);
  });
});

describe('costVerdict', () => {
  const profile = profileFor('username-to-profiles');

  it('accepts an expensive engine when the input looks worth it', () => {
    expect(costVerdict(profile, 0.8).ok).toBe(true);
  });

  it('refuses an expensive engine on a low-value input, with a readable reason', () => {
    const verdict = costVerdict(profile, 0.1);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('cost-not-justified');
    expect(verdict.note).toContain('expensive');
  });

  it('refuses a class the scan does not allow', () => {
    const verdict = costVerdict(profile, 1, {
      ...DEFAULT_COST_CEILING,
      maxExecutionClass: 'standard',
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('over-resource-budget');
  });

  it('refuses a run that would not fit in RAM', () => {
    const verdict = costVerdict(profile, 1, { ...DEFAULT_COST_CEILING, memoryMb: 16 });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.note).toContain('MB of RAM');
  });

  it('reports a rate limit as pacing, and still allows the step', () => {
    // github states one request per minute unauthenticated: four pages take four minutes. That is
    // a scheduling fact, not a reason to refuse the answer.
    const github = profileFor('username-to-repositories');
    expect(github.quotaShare).toBeGreaterThan(1);
    expect(github.paceMs).toBe(240_000);
    expect(costVerdict(github, 1).ok).toBe(true);
  });

  it('refuses a run that cannot fit inside a daily quota', () => {
    const transform = registry.transform('hash-to-reputation');
    const engine = transform && registry.enginesFor(transform)[0];
    const provider = engine && registry.provider(engine.provider);
    if (!transform || !engine || !provider) throw new Error('fixture drift');
    const capped = { ...provider, limits: { ...provider.limits, requestsPerDay: 1 } };
    const verdict = costVerdict(costProfile(transform, engine, capped), 1);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.note).toContain('a day');
  });

  it('prices no quota share for a provider that states no limit', () => {
    expect(profile.quotaShare).toBeUndefined();
  });
});

describe('expand with a cost ceiling', () => {
  it('never plans more than the same context without a ceiling', () => {
    const open = expand(registry, 'username', ctx(), 'deep');
    const tight = expand(
      registry,
      'username',
      ctx({ costCeiling: { ...DEFAULT_COST_CEILING, maxExecutionClass: 'fast' } }),
      'deep',
    );
    expect(tight.steps.length).toBeLessThanOrEqual(open.steps.length);
  });

  it('reports what the ceiling dropped instead of shortening the plan silently', () => {
    const tight = expand(
      registry,
      'username',
      ctx({ costCeiling: { ...DEFAULT_COST_CEILING, maxExecutionClass: 'fast' } }),
      'deep',
    );
    const priced = tight.excluded.filter(
      (exclusion) =>
        exclusion.reason === 'over-resource-budget' || exclusion.reason === 'cost-not-justified',
    );
    expect(priced.length).toBeGreaterThan(0);
    expect(priced.every((exclusion) => (exclusion.note ?? '').length > 0)).toBe(true);
  });

  it('leaves the plan untouched when no ceiling is given', () => {
    const before = expand(registry, 'domain', ctx(), 2);
    const after = expand(registry, 'domain', ctx(), 2);
    expect(after.steps.map((step) => step.transform)).toEqual(
      before.steps.map((step) => step.transform),
    );
  });
});
