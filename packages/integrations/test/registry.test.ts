/** The registry loader: what it accepts, what it rejects, and what it defaults (§4.3). */

import { describe, expect, it } from 'vitest';

import { manifest as expandUrl } from '../builtin/manifest.ts';
import { parser as expandUrlParser } from '../builtin/parser.ts';
import {
  BUILTIN_SOURCES,
  buildRegistry,
  builtinRegistry,
  loadRegistry,
  type IntegrationSource,
} from '../src/registry.ts';
import type {
  EntityExtractor,
  InputAdapter,
  NodeMapper,
  RelationshipMapper,
} from '../src/pipeline.ts';

const raw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...(JSON.parse(JSON.stringify(expandUrl)) as Record<string, unknown>),
  ...over,
});

const source = (over: Partial<IntegrationSource> = {}): IntegrationSource => ({
  raw: raw(),
  parser: expandUrlParser,
  ...over,
});

describe('safe defaults in the registry (§61)', () => {
  it('defaults enablement to the gate verdict rather than to on', async () => {
    const blocked = buildRegistry([source({ raw: raw({ maturity: 'experimental' }) })]);
    const entry = blocked.entries.get(expandUrl.id);

    expect(entry?.safeDefaults.enabledByDefault).toBe(false);
    expect(entry?.safeDefaults.blockers.map((b) => b.check)).toContain('compatibility');
    await expect(entry?.enabledForOrg('org-1')).resolves.toBe(false);
  });

  it('enables an integration that passes every gate', async () => {
    const entry = buildRegistry([source()]).entries.get(expandUrl.id);

    expect(entry?.safeDefaults.blockers).toEqual([]);
    await expect(entry?.enabledForOrg('org-1')).resolves.toBe(true);
  });

  it('lets an explicit resolver override the default', async () => {
    const entry = buildRegistry([
      source({
        raw: raw({ maturity: 'experimental' }),
        enabledForOrg: (orgId: string) => Promise.resolve(orgId === 'org-1'),
      }),
    ]).entries.get(expandUrl.id);

    await expect(entry?.enabledForOrg('org-1')).resolves.toBe(true);
    await expect(entry?.enabledForOrg('org-2')).resolves.toBe(false);
  });
});

describe('buildRegistry', () => {
  it('registers a valid manifest under its id with default stages', () => {
    const registry = buildRegistry([source()]);
    const entry = registry.entries.get(expandUrl.id);

    expect(registry.rejected).toEqual([]);
    expect(entry?.manifest.id).toBe(expandUrl.id);
    expect(entry?.parser).toBe(expandUrlParser);
    expect(typeof entry?.inputAdapter.adapt).toBe('function');
    expect(typeof entry?.extractor.extract).toBe('function');
  });

  it('defaults enabledForOrg to true so a first-party tool needs no wiring', async () => {
    const entry = buildRegistry([source()]).entries.get(expandUrl.id);
    await expect(entry?.enabledForOrg('org-1')).resolves.toBe(true);
  });

  it('uses every stage override the source supplies', () => {
    const extractor: EntityExtractor = {
      extract: () => ({ entities: [], relations: [], issues: [] }),
    };
    const nodeMapper: NodeMapper = { map: () => [] };
    const relationshipMapper: RelationshipMapper = { map: () => [] };
    const inputAdapter: InputAdapter = {
      adapt: () => ({ input: {}, targets: [], warnings: [] }),
      accepts: () => true,
    };
    const enabledForOrg = (orgId: string): Promise<boolean> => Promise.resolve(orgId === 'org-1');

    const entry = buildRegistry([
      source({
        inputAdapter: () => inputAdapter,
        extractor: () => extractor,
        nodeMapper: () => nodeMapper,
        relationshipMapper: () => relationshipMapper,
        enabledForOrg,
      }),
    ]).entries.get(expandUrl.id);

    expect(entry?.inputAdapter).toBe(inputAdapter);
    expect(entry?.extractor).toBe(extractor);
    expect(entry?.nodeMapper).toBe(nodeMapper);
    expect(entry?.relationshipMapper).toBe(relationshipMapper);
  });

  it('reports an invalid manifest under its declared id instead of throwing', () => {
    const registry = buildRegistry([source({ raw: raw({ version: 'not-semver' }) })]);

    expect(registry.entries.size).toBe(0);
    expect(registry.rejected).toHaveLength(1);
    expect(registry.rejected[0]?.id).toBe(expandUrl.id);
    expect(registry.rejected[0]?.issues.length).toBeGreaterThan(0);
  });

  it('falls back to "(unnamed)" when the rejected declaration has no string id', () => {
    expect(buildRegistry([source({ raw: { id: 42 } })]).rejected[0]?.id).toBe('(unnamed)');
    expect(buildRegistry([source({ raw: null })]).rejected[0]?.id).toBe('(unnamed)');
  });

  it('keeps the good entries when one source in the list is broken', () => {
    const registry = buildRegistry([source(), source({ raw: { id: 'broken' } })]);
    expect(registry.entries.size).toBe(1);
    expect(registry.rejected.map((r) => r.id)).toEqual(['broken']);
  });
});

describe('loadRegistry', () => {
  it('loads the built-ins only, unless third-party discovery is opted into', async () => {
    const third = source({ raw: raw({ id: 'third-party' }) });

    await expect(loadRegistry().then((r) => r.entries.size)).resolves.toBe(BUILTIN_SOURCES.length);
    await expect(
      loadRegistry({ thirdParty: [third] }).then((r) => r.entries.has('third-party')),
    ).resolves.toBe(false);
    await expect(
      loadRegistry({ includeThirdParty: true, thirdParty: [third] }).then((r) =>
        r.entries.has('third-party'),
      ),
    ).resolves.toBe(true);
    await expect(
      loadRegistry({ includeThirdParty: true }).then((r) => r.entries.size),
    ).resolves.toBe(BUILTIN_SOURCES.length);
  });
});

describe('builtinRegistry', () => {
  it('is memoised, so every caller shares one registry instance', () => {
    expect(builtinRegistry()).toBe(builtinRegistry());
    expect(builtinRegistry().entries.size).toBe(BUILTIN_SOURCES.length);
  });
});
