/**
 * The analysis reader returns the newest row, and treats a payload the current schema cannot parse
 * as "not analyzed" so a stale analyzer version can never break the panel.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ANALYZABLE_HOSTS,
  isAnalyzableRepoKey,
  readLatestRepositoryAnalysis,
  REPO_KEY_PATTERN,
  repositoryAnalysisJob,
  type AnalysisRowClient,
} from '../github/analysisStore.ts';
import { GITHUB_QUEUE } from '../github/jobs.ts';

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

describe('isAnalyzableRepoKey', () => {
  it('accepts a well-formed key on a supported host', () => {
    expect(isAnalyzableRepoKey('github.com/acme/raven')).toBe(true);
    expect(isAnalyzableRepoKey('github.com/acme/raven.osint-1')).toBe(true);
  });

  it('rejects an unsupported host', () => {
    expect(isAnalyzableRepoKey('gitlab.com/acme/raven')).toBe(false);
  });

  it('rejects a malformed key', () => {
    expect(isAnalyzableRepoKey('github.com/acme')).toBe(false);
    expect(isAnalyzableRepoKey('GitHub.com/acme/raven')).toBe(false);
    expect(isAnalyzableRepoKey('')).toBe(false);
  });

  it('lists github.com as analyzable', () => {
    expect(ANALYZABLE_HOSTS).toContain('github.com');
    expect(REPO_KEY_PATTERN.test('github.com/acme/raven')).toBe(true);
  });
});

describe('repositoryAnalysisJob', () => {
  const request = {
    repoKey: 'github.com/acme/raven',
    headSha: 'abc123',
    analyzerVersion: '1',
    userId: 'u1',
    boardId: 'b1',
  };

  it('describes one github.analyze job carrying the request', () => {
    const job = repositoryAnalysisJob(request);
    expect(job.name).toBe('github.analyze');
    expect(job.queue).toBe(GITHUB_QUEUE);
    expect(job.payload).toEqual(request);
  });

  it('dedupes the same head and lets force through', () => {
    const first = repositoryAnalysisJob(request);
    const same = repositoryAnalysisJob(request);
    const forced = repositoryAnalysisJob({ ...request, force: true });
    expect(first.options).toEqual(same.options);
    expect(forced.payload.force).toBe(true);
  });
});
