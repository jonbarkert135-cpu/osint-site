/**
 * The analysis reader returns the newest row, and treats a payload the current schema cannot parse
 * as "not analyzed" so a stale analyzer version can never break the panel.
 */

import { describe, expect, it, vi } from 'vitest';

import { readLatestRepositoryAnalysis, type AnalysisRowClient } from '../github/analysisStore.ts';

const analysis = {
  repoKey: 'github.com/o/r',
  headSha: 'sha',
  inputsDigest: 'd',
  analyzerVersion: '1.0.0',
  producedAt: '2026-08-22T20:00:00.000Z',
  completeness: 1,
  skippedSteps: [],
  treeComplete: true,
  languages: [],
  primaryLanguage: 'Python',
  layout: { kind: 'single-package', packages: [], docsDirs: [], testDirs: [], ciProviders: [] },
  entryPoints: [],
  build: { systems: [], commands: [], runtimeVersions: {} },
  dependencies: [],
  surface: {
    cli: [],
    http: { spec: null, framework: null, routesKnown: false, routes: [] },
    grpc: [],
    library: false,
    mcp: false,
  },
  container: {
    dockerfile: null,
    compose: [],
    baseImages: [],
    exposedPorts: [],
    publishedImageHints: [],
    rootUser: null,
  },
  health: {
    license: { spdxId: null, method: 'none', permissive: null },
    maintenanceScore: 50,
    maintenanceBand: 'watch',
    signals: [],
    archived: false,
    contributorsCount: null,
  },
  narrative: {
    summary: null,
    architecture: null,
    integrationNotes: null,
    model: null,
    generatedAt: null,
  },
};

const clientOf = (row: { payload: unknown; proposal: unknown } | null) => {
  const findFirst = vi.fn().mockResolvedValue(row);
  return { client: { githubAnalysis: { findFirst } } as AnalysisRowClient, findFirst };
};

describe('readLatestRepositoryAnalysis', () => {
  it('asks for the newest row of that repository', async () => {
    const { client, findFirst } = clientOf({ payload: analysis, proposal: null });
    const result = await readLatestRepositoryAnalysis(client, 'github.com/o/r');

    expect(findFirst.mock.lastCall?.[0]).toMatchObject({
      where: { repoKey: 'github.com/o/r' },
      orderBy: { createdAt: 'desc' },
    });
    expect(result?.analysis.primaryLanguage).toBe('Python');
    expect(result?.proposal).toBeNull();
  });

  it('returns null when the repository was never analyzed', async () => {
    const { client } = clientOf(null);
    await expect(readLatestRepositoryAnalysis(client, 'github.com/o/r')).resolves.toBeNull();
  });

  it('treats an unparsable payload as not analyzed', async () => {
    const { client } = clientOf({ payload: { repoKey: 'x' }, proposal: null });
    await expect(readLatestRepositoryAnalysis(client, 'github.com/o/r')).resolves.toBeNull();
  });

  it('passes the stored proposal through', async () => {
    const { client } = clientOf({ payload: analysis, proposal: { id: 'p-1' } });
    const result = await readLatestRepositoryAnalysis(client, 'github.com/o/r');
    expect(result?.proposal?.id).toBe('p-1');
  });
});
