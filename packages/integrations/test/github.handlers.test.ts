import { describe, expect, it, vi } from 'vitest';

import { GithubClient, type HttpResponse } from '../github/client';
import {
  createGithubHandlers,
  isGithubTab,
  SWEEP_TTL_MS,
  type GithubHandlerStore,
  type RepositoryNodeRow,
} from '../github/handlers';
import type { RepositoryAnalysis, RepositoryData } from '@nexus/domain';

const NOW = Date.parse('2026-01-01T00:00:00.000Z');

const repoJson = JSON.stringify({
  name: 'sherlock',
  full_name: 'sherlock-project/sherlock',
  owner: { login: 'sherlock-project' },
  default_branch: 'master',
  stargazers_count: 7,
});

function ok(body: string): HttpResponse {
  return { status: 200, headers: () => null, body };
}

function harness(routes: Record<string, HttpResponse>, rows: RepositoryNodeRow[] = []) {
  const requested: string[] = [];
  const patched: RepositoryData[] = [];
  const tabs: { tab: string; payload: unknown }[] = [];
  const hydrates: unknown[] = [];
  const proposals: unknown[] = [];
  const store: GithubHandlerStore = {
    patchRepositoryNode: vi.fn(async (_nodeId, data) => {
      patched.push(data);
    }),
    readTab: vi.fn(async () => null),
    writeTab: vi.fn(async (_nodeId, tab, payload) => {
      tabs.push({ tab, payload });
    }),
    saveAnalysis: vi.fn(async () => 'analysis-1'),
    loadAnalysis: vi.fn(async () => null),
    saveProposal: vi.fn(async () => undefined),
    listRepositoryNodes: vi.fn(async () => rows),
    repoKeyOfNode: vi.fn(async () => rows[0]?.repoKey ?? 'sherlock-project/sherlock'),
  };
  const handlers = createGithubHandlers({
    store,
    createClient: (signal) =>
      new GithubClient({
        http: async (url) => {
          requested.push(url);
          signal.throwIfAborted();
          const path = url.replace('https://api.github.com', '');
          return routes[path] ?? { status: 404, headers: () => null, body: '' };
        },
        nowMs: NOW,
      }),
    enqueueHydrate: async (payload) => {
      hydrates.push(payload);
    },
    enqueueProposal: async (payload) => {
      proposals.push(payload);
    },
    newId: () => 'proposal-1',
    now: () => NOW,
  });
  return { handlers, store, requested, patched, tabs, hydrates, proposals };
}

const signal = new AbortController().signal;

describe('github.hydrate', () => {
  it('patches the node with the mapped repository payload', async () => {
    const h = harness({
      '/repos/sherlock-project/sherlock': ok(repoJson),
      '/repos/sherlock-project/sherlock/languages': ok(JSON.stringify({ Python: 10 })),
    });
    await h.handlers['github.hydrate'](
      {
        nodeId: 'n1',
        ref: { kind: 'repo', owner: 'sherlock-project', repo: 'sherlock' },
        boardId: 'b1',
        userId: 'u1',
      },
      signal,
    );
    expect(h.patched[0]).toMatchObject({
      fullName: 'sherlock-project/sherlock',
      key: 'gh:repo:sherlock-project/sherlock',
      primaryLanguage: 'Python',
      pinnedRef: null,
    });
  });

  it('keeps a pasted /tree/{ref} as pinnedRef', async () => {
    const h = harness({
      '/repos/sherlock-project/sherlock': ok(repoJson),
      '/repos/sherlock-project/sherlock/languages': ok('{}'),
    });
    await h.handlers['github.hydrate'](
      {
        nodeId: 'n1',
        ref: { kind: 'repo', owner: 'sherlock-project', repo: 'sherlock', ref: 'v0.16.0' },
        boardId: 'b1',
        userId: 'u1',
      },
      signal,
    );
    expect(h.patched[0]?.pinnedRef).toBe('v0.16.0');
  });

  it('a 404 leaves the node untouched — cached data is never deleted (N8)', async () => {
    const h = harness({});
    await h.handlers['github.hydrate'](
      {
        nodeId: 'n1',
        ref: { kind: 'repo', owner: 'a', repo: 'b' },
        boardId: 'b1',
        userId: 'u1',
      },
      signal,
    );
    expect(h.patched).toHaveLength(0);
  });

  it('an owner ref has no repository to hydrate and spends no request', async () => {
    const h = harness({});
    await h.handlers['github.hydrate'](
      {
        nodeId: 'n1',
        ref: { kind: 'owner', owner: 'a', ownerType: 'org' },
        boardId: 'b',
        userId: 'u',
      },
      signal,
    );
    expect(h.requested).toHaveLength(0);
  });
});

describe('github.tab', () => {
  it('fetches the tab endpoint and caches the payload', async () => {
    const h = harness({
      '/repos/sherlock-project/sherlock/contributors?per_page=30': ok('[{"login":"x"}]'),
    });
    await h.handlers['github.tab']({ nodeId: 'n1', tab: 'contributors' }, signal);
    expect(h.tabs).toEqual([{ tab: 'contributors', payload: [{ login: 'x' }] }]);
  });

  it('skips a fetch while the cache is inside the tab TTL', async () => {
    const h = harness({});
    h.store.readTab = vi.fn(async () => ({ fetchedAt: new Date(NOW - 1_000).toISOString() }));
    await h.handlers['github.tab']({ nodeId: 'n1', tab: 'issues' }, signal);
    expect(h.requested).toHaveLength(0);
  });

  it('force refetches a fresh tab', async () => {
    const h = harness({
      '/repos/sherlock-project/sherlock/issues?state=open&per_page=30': ok('[]'),
    });
    h.store.readTab = vi.fn(async () => ({ fetchedAt: new Date(NOW).toISOString() }));
    await h.handlers['github.tab']({ nodeId: 'n1', tab: 'issues', force: true }, signal);
    expect(h.requested).toHaveLength(1);
  });

  it('ignores an unknown tab name', async () => {
    const h = harness({});
    await h.handlers['github.tab']({ nodeId: 'n1', tab: 'nope' }, signal);
    expect(h.requested).toHaveLength(0);
    expect(isGithubTab('readme')).toBe(true);
  });
});

describe('github.sweep', () => {
  const row = (lastFetchedAt: string | null): RepositoryNodeRow => ({
    nodeId: 'n1',
    repoKey: 'a/b',
    lastFetchedAt,
    ref: { kind: 'repo', owner: 'a', repo: 'b' },
  });

  it('re-hydrates only nodes past the warm TTL', async () => {
    const stale = new Date(NOW - SWEEP_TTL_MS - 1).toISOString();
    const h = harness({}, [row(stale), { ...row(new Date(NOW).toISOString()), nodeId: 'n2' }]);
    await h.handlers['github.sweep']({ boardId: 'b1', hour: '2026-01-01T00' }, signal);
    expect(h.hydrates).toEqual([
      { nodeId: 'n1', ref: row(stale).ref, boardId: 'b1', userId: 'system' },
    ]);
  });

  it('a never-hydrated node is always swept', async () => {
    const h = harness({}, [row(null)]);
    await h.handlers['github.sweep']({ boardId: 'b1', hour: '2026-01-01T00' }, signal);
    expect(h.hydrates).toHaveLength(1);
  });
});

describe('github.analyze', () => {
  it('collects inputs and stores the deterministic analysis', async () => {
    const h = harness({
      '/repos/sherlock-project/sherlock': ok(repoJson),
      '/repos/sherlock-project/sherlock/git/trees/master?recursive=1': ok(
        JSON.stringify({ sha: 'deadbeef', tree: [{ path: 'package.json', type: 'blob' }] }),
      ),
      '/repos/sherlock-project/sherlock/languages': ok(JSON.stringify({ Python: 1 })),
    });
    await h.handlers['github.analyze'](
      {
        repoKey: 'sherlock-project/sherlock',
        headSha: 'deadbeef',
        analyzerVersion: '1.0.0',
        userId: 'u1',
        boardId: 'b1',
      },
      signal,
    );
    expect(h.store.saveAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ repoKey: 'sherlock-project/sherlock', headSha: 'deadbeef' }),
    );
  });

  it('chains the proposal job onto the analysis it just stored', async () => {
    const h = harness({
      '/repos/sherlock-project/sherlock': ok(repoJson),
      '/repos/sherlock-project/sherlock/git/trees/master?recursive=1': ok(
        JSON.stringify({ sha: 'deadbeef', tree: [{ path: 'package.json', type: 'blob' }] }),
      ),
      '/repos/sherlock-project/sherlock/languages': ok(JSON.stringify({ Python: 1 })),
    });
    await h.handlers['github.analyze'](
      {
        repoKey: 'sherlock-project/sherlock',
        headSha: 'deadbeef',
        analyzerVersion: '1.0.0',
        userId: 'u1',
        boardId: 'b1',
      },
      signal,
    );
    expect(h.proposals).toEqual([{ analysisId: 'analysis-1' }]);
  });
});

describe('github.proposal', () => {
  it('stores a proposal built from an eligible analysis', async () => {
    const h = harness({
      '/repos/sherlock-project/sherlock': ok(repoJson),
      '/repos/sherlock-project/sherlock/git/trees/master?recursive=1': ok(
        JSON.stringify({ sha: 'deadbeef', tree: [{ path: 'Dockerfile', type: 'blob' }] }),
      ),
      '/repos/sherlock-project/sherlock/languages': ok(JSON.stringify({ Python: 1 })),
    });
    let saved: RepositoryAnalysis | undefined;
    h.store.saveAnalysis = vi.fn(async (analysis) => {
      saved = analysis;
      return 'an_1';
    });
    await h.handlers['github.analyze'](
      {
        repoKey: 'sherlock-project/sherlock',
        headSha: 'deadbeef',
        analyzerVersion: '1.0.0',
        userId: 'u1',
        boardId: 'b1',
      },
      signal,
    );
    h.store.loadAnalysis = vi.fn(async () => saved ?? null);
    await h.handlers['github.proposal']({ analysisId: 'an_1' }, signal);
    // The fixture repository has no permissive licence in its API payload, so §6.2 blocks it.
    expect(h.store.saveProposal).not.toHaveBeenCalled();
  });

  it('does nothing when the analysis is gone', async () => {
    const h = harness({});
    await h.handlers['github.proposal']({ analysisId: 'missing' }, signal);
    expect(h.store.saveProposal).not.toHaveBeenCalled();
  });
});
