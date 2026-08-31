import { createCatalogRegistry, DEFAULT_BUDGET, type PlannerContext } from '@nexus/transforms';
import { describe, expect, it } from 'vitest';

import { recommendServices } from '../src/recommend.ts';

const ctx = (overrides: Partial<PlannerContext> = {}): PlannerContext => ({
  mode: 'configured',
  configuredProviders: new Set<string>(),
  grantedPermissions: new Set(['network', 'subprocess'] as const),
  budget: DEFAULT_BUDGET,
  ...overrides,
});

describe('recommendServices (Part 2 §41)', () => {
  const registry = createCatalogRegistry();

  it('tiers a username query instead of firing everything', () => {
    const result = recommendServices(registry, 'example_user', ctx());

    expect(result.kind).toBe('username');
    const tiered = [
      ...result.tiers.required,
      ...result.tiers.recommended,
      ...result.tiers.optional,
    ];
    expect(tiered.length).toBeGreaterThan(1);
    expect(result.tiers.required.map((offer) => offer.transform.id)).toContain(
      'username-to-profiles',
    );
    // Profile discovery is Sherlock's capability; the offer names the engine that would run.
    const profiles = result.tiers.required.find(
      (offer) => offer.transform.id === 'username-to-profiles',
    );
    expect(profiles?.engine).toBe('sherlock');
  });

  it('offers each capability once, never the same capability twice', () => {
    const result = recommendServices(registry, 'example.com', ctx());
    const capabilities = [
      ...result.tiers.required,
      ...result.tiers.recommended,
      ...result.tiers.optional,
    ].map((offer) => offer.transform.capability);
    expect(new Set(capabilities).size).toBe(capabilities.length);
  });

  it('demotes what cannot run to Optional and says why', () => {
    const result = recommendServices(registry, 'example.com', ctx({ mode: 'strict-local' }));
    const blocked = result.tiers.optional.filter((offer) => !offer.usable);
    expect(blocked.length).toBeGreaterThan(0);
    for (const offer of blocked) {
      expect(offer.reason).toBeDefined();
      expect(offer.why.length).toBeGreaterThan(0);
    }
    // Run all never includes something that is known not to run.
    expect(result.runAll).not.toContain(blocked[0]?.transform.id);
  });

  it('Run all covers every usable offer; Customize starts at required + recommended', () => {
    const result = recommendServices(registry, 'example_user', ctx());
    expect(result.runAll.length).toBeGreaterThanOrEqual(result.defaultSelection.length);
    for (const id of result.defaultSelection) expect(result.runAll).toContain(id);
    const optionalIds = result.tiers.optional.map((offer) => offer.transform.id);
    for (const id of result.defaultSelection) expect(optionalIds).not.toContain(id);
  });

  it('returns empty tiers when the input types to nothing routable', () => {
    const result = recommendServices(registry, 'example.com', ctx(), { kind: 'asn' });
    expect(result.kind).toBeUndefined();
    expect(result.runAll).toEqual([]);
    expect(result.tiers.required).toEqual([]);
  });
});
