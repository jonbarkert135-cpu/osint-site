import { createCatalogRegistry, engineDocuments, type EngineDocument } from '@nexus/transforms';
import { describe, expect, it } from 'vitest';

import { catalogSummary, integrationCatalog, type CatalogEntry } from '../src/catalog.ts';

const registry = createCatalogRegistry();
const documents = engineDocuments(registry);
const find = (entries: readonly CatalogEntry[], engine: string): CatalogEntry | undefined =>
  entries.find((entry) => entry.engine === engine);

describe('integrationCatalog (Part 2 §55)', () => {
  it('marks the engines this build registered as installed', () => {
    const installed = new Set([documents[0]?.name ?? '']);
    const entries = integrationCatalog(registry, { installed });

    expect(find(entries, documents[0]?.name ?? '')?.state).toBe('installed');
    expect(find(entries, documents[0]?.name ?? '')?.action).toBe('open');
    expect(entries.length).toBe(documents.length);
  });

  it('gives every engine exactly one of the five states, installed first', () => {
    const entries = integrationCatalog(registry, { installed: new Set() });
    const states = [...new Set(entries.map((entry) => entry.state))];

    expect(states.every((state) => state.length > 0)).toBe(true);
    // Sorted by state bucket: nothing before the first recommended entry is available/deprecated.
    const order = entries.map((entry) => entry.state);
    expect([...order].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(order);
    expect(entries.every((entry) => entry.detail.length > 0)).toBe(true);
  });

  it('recommends a keyless free engine and only offers a keyed one as available', () => {
    const entries = integrationCatalog(registry, { installed: new Set() });
    const recommended = entries.filter((entry) => entry.state === 'recommended');
    const available = entries.filter((entry) => entry.state === 'available');

    expect(recommended.length).toBeGreaterThan(0);
    expect(recommended.every((entry) => !entry.needsCredentials)).toBe(true);
    expect(available.some((entry) => entry.needsCredentials)).toBe(true);
    expect(recommended[0]?.action).toBe('install');
  });

  it('stops asking for credentials once the provider is configured', () => {
    const keyed = integrationCatalog(registry, { installed: new Set() }).find(
      (entry) => entry.needsCredentials,
    );
    const entries = integrationCatalog(registry, {
      installed: new Set(),
      configuredProviders: new Set([keyed?.provider ?? '']),
    });

    expect(find(entries, keyed?.engine ?? '')?.needsCredentials).toBe(false);
  });

  it('separates deprecated (replace it) from incompatible (nothing to press)', () => {
    const base = documents[0];
    if (!base) throw new Error('the catalogue is empty');
    const external: EngineDocument[] = [
      { ...base, name: 'old-thing', status: 'deprecated' },
      {
        ...base,
        name: 'unrunnable',
        execution: { ...base.execution, adapter: 'planned' },
      },
      {
        ...base,
        name: 'wrong-host',
        execution: { ...base.execution, adapter: 'implemented', hostCompatible: false },
      },
    ];
    const entries = integrationCatalog(registry, { installed: new Set(), external });

    expect(find(entries, 'old-thing')).toMatchObject({ state: 'deprecated', action: 'replace' });
    expect(find(entries, 'unrunnable')).toMatchObject({ state: 'incompatible', action: 'none' });
    expect(find(entries, 'wrong-host')?.state).toBe('incompatible');
  });

  it('lists an installed engine that no transform routes to, without pretending it works', () => {
    const base = documents[0];
    if (!base) throw new Error('the catalogue is empty');
    const entries = integrationCatalog(registry, {
      installed: new Set(['orphan']),
      external: [{ ...base, name: 'orphan', transforms: [] }],
    });

    expect(find(entries, 'orphan')?.detail).toContain('no transform routes to it');
  });

  it('summarises the states for the filter chips', () => {
    const entries = integrationCatalog(registry, { installed: new Set(['sherlock']) });
    const summary = catalogSummary(entries);

    expect(Object.values(summary).reduce((a, b) => a + b, 0)).toBe(entries.length);
    expect(summary.installed).toBe(1);
  });
});
