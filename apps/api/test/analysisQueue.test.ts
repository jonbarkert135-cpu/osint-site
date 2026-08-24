/** The API enqueues a repository analysis and never runs one itself (N5, 11_GITHUB.md §10). */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const queueAdd = vi.fn();
const queueClose = vi.fn();
const QueueCtor = vi.fn();
vi.mock('bullmq', () => ({
  Queue: class {
    add = queueAdd;
    close = queueClose;
    constructor(...args: unknown[]) {
      QueueCtor(...args);
    }
  },
}));

const redisDisconnect = vi.fn();
const RedisCtor = vi.fn();
vi.mock('ioredis', () => ({
  default: class {
    disconnect = redisDisconnect;
    constructor(...args: unknown[]) {
      RedisCtor(...args);
    }
  },
}));

vi.mock('../src/env.ts', () => ({
  loadServerEnvFromProcess: () => ({ REDIS_URL: 'redis://localhost:6379' }),
}));

const { closeAnalysisQueue, enqueueRepositoryAnalysis } = await import(
  '../src/integrations/analysisQueue.ts'
);
const { repositoryAnalysisJob } = await import('@nexus/integrations/repository-analysis');

const request = {
  repoKey: 'github.com/acme/raven',
  headSha: 'abc123',
  analyzerVersion: '1',
  userId: 'u1',
  boardId: 'b1',
};

beforeEach(async () => {
  await closeAnalysisQueue();
  queueAdd.mockResolvedValue(undefined);
  queueClose.mockResolvedValue(undefined);
  QueueCtor.mockClear();
  RedisCtor.mockClear();
  queueAdd.mockClear();
  queueClose.mockClear();
  redisDisconnect.mockClear();
});

describe('enqueueRepositoryAnalysis', () => {
  it('adds the job the integration package describes', async () => {
    await enqueueRepositoryAnalysis(request);

    const job = repositoryAnalysisJob(request);
    expect(QueueCtor).toHaveBeenCalledWith(job.queue, expect.anything());
    expect(queueAdd).toHaveBeenCalledWith(job.name, job.payload, job.options);
  });

  it('opens redis lazily and reuses one queue', async () => {
    await enqueueRepositoryAnalysis(request);
    await enqueueRepositoryAnalysis({ ...request, force: true });

    expect(RedisCtor).toHaveBeenCalledTimes(1);
    expect(RedisCtor).toHaveBeenCalledWith('redis://localhost:6379', {
      maxRetriesPerRequest: null,
    });
    expect(QueueCtor).toHaveBeenCalledTimes(1);
    expect(queueAdd).toHaveBeenCalledTimes(2);
  });
});

describe('closeAnalysisQueue', () => {
  it('closes what was opened and lets the next call reopen it', async () => {
    await enqueueRepositoryAnalysis(request);
    await closeAnalysisQueue();

    expect(queueClose).toHaveBeenCalledTimes(1);
    expect(redisDisconnect).toHaveBeenCalledTimes(1);

    await enqueueRepositoryAnalysis(request);
    expect(RedisCtor).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when nothing was opened', async () => {
    await expect(closeAnalysisQueue()).resolves.toBeUndefined();
    expect(queueClose).not.toHaveBeenCalled();
  });
});
