import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ctx, prismaMock, recordAuditMock } from './prisma-mock.ts';

vi.mock('@nexus/db', () => ({ prisma: prismaMock, recordAudit: recordAuditMock }));

const enqueueRepositoryAnalysis = vi.fn();
vi.mock('../src/integrations/analysisQueue.ts', () => ({ enqueueRepositoryAnalysis }));

const { appRouter } = await import('../src/trpc/router.ts');
const { createCallerFactory } = await import('../src/trpc/trpc.ts');
const { ANALYZER_VERSION } = await import('@nexus/domain');

const caller = createCallerFactory(appRouter);

const REPO = 'github.com/smicallef/spiderfoot';

beforeEach(() => {
  vi.clearAllMocks();
  recordAuditMock.mockResolvedValue(undefined);
  enqueueRepositoryAnalysis.mockResolvedValue(undefined);
  prismaMock.repository.findUnique.mockResolvedValue(null);
});

describe('repositories.analyze', () => {
  it('enqueues the analysis job and audits the request', async () => {
    prismaMock.repository.findUnique.mockResolvedValue({ lastHeadSha: 'deadbeef' });

    const result = await caller(ctx({ role: 'editor' })).repositories.analyze({ repoKey: REPO });

    expect(result).toEqual({ queued: true, repoKey: REPO, headSha: 'deadbeef' });
    expect(enqueueRepositoryAnalysis).toHaveBeenCalledWith({
      repoKey: REPO,
      headSha: 'deadbeef',
      analyzerVersion: ANALYZER_VERSION,
      userId: 'u1',
      boardId: '',
      force: false,
    });
    const entry = recordAuditMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(entry.action).toBe('repository.analysis.requested');
    expect(entry.targetId).toBe(REPO);
  });

  it('falls back to HEAD for a repository that was never hydrated', async () => {
    const result = await caller(ctx({ role: 'editor' })).repositories.analyze({ repoKey: REPO });
    expect(result.headSha).toBe('HEAD');
  });

  it('refuses a host the analyzer does not support', async () => {
    await expect(
      caller(ctx({ role: 'editor' })).repositories.analyze({ repoKey: 'gitlab.com/o/r' }),
    ).rejects.toThrow(/not on a host the analyzer supports/);
    expect(enqueueRepositoryAnalysis).not.toHaveBeenCalled();
  });

  it('refuses a viewer', async () => {
    await expect(
      caller(ctx({ role: 'viewer' })).repositories.analyze({ repoKey: REPO }),
    ).rejects.toThrow();
    expect(enqueueRepositoryAnalysis).not.toHaveBeenCalled();
  });
});

describe('repositories.latestAnalysis', () => {
  it('reads null for a repository that was never analyzed', async () => {
    prismaMock.githubAnalysis.findFirst.mockResolvedValue(null);
    await expect(
      caller(ctx({ role: 'viewer' })).repositories.latestAnalysis({ repoKey: REPO }),
    ).resolves.toBeNull();
  });
});
