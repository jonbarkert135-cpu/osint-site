/**
 * Worker bootstrap: the S3 artifact reader, the Prisma-backed parse store and `start()`'s wiring
 * (queue registration, job handler, shutdown). Everything the worker touches at the edges (Redis,
 * BullMQ, Prisma) is mocked; what is asserted is the wiring, not the drivers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactRef } from '@nexus/integrations';

const prismaMock = {
  integrationRun: { findUnique: vi.fn(), update: vi.fn() },
  boardProjectionNode: { findMany: vi.fn() },
  importProposal: { create: vi.fn() },
  runLogEntry: { findFirst: vi.fn(), createMany: vi.fn() },
};

const workerCtor = vi.fn();
const workerClose = vi.fn(() => Promise.resolve());
const redisInstances: {
  url: string;
  disconnect: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
}[] = [];

vi.mock('@nexus/db', () => ({ prisma: prismaMock }));

const queueAdd = vi.fn(() => Promise.resolve());
const queueClose = vi.fn(() => Promise.resolve());

vi.mock('bullmq', () => ({
  Queue: class {
    add = queueAdd;
    close = queueClose;
  },
  Worker: class {
    constructor(...args: unknown[]) {
      workerCtor(...args);
    }
    close = workerClose;
  },
}));

vi.mock('ioredis', () => ({
  default: class {
    publish = vi.fn();
    disconnect = vi.fn();
    constructor(url: string) {
      redisInstances.push(this as unknown as (typeof redisInstances)[number]);
      (this as unknown as { url: string }).url = url;
    }
  },
}));

vi.mock('@nexus/config/env-file', () => ({
  loadServerEnvFromProcess: () => ({
    REDIS_URL: 'redis://localhost:6379',
    S3_ENDPOINT: 'https://s3.test/',
    SYNC_URL: 'http://sync:3002',
    SYNC_SHARED_SECRET: 's'.repeat(32),
  }),
}));

const createHandlers = vi.fn((_deps: unknown) => ({}) as Record<string, unknown>);
vi.mock('@nexus/integrations/github/handlers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createGithubHandlers: (deps: unknown) => createHandlers(deps),
}));

const parseJob = vi.fn(() => Promise.resolve({ status: 'succeeded' as const }));
vi.mock('../src/queues/integration.parse.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  processParseJob: (...args: unknown[]) => parseJob(...(args as [])),
}));

const {
  PARSE_QUEUE,
  prismaGithubJobStore,
  prismaParseStore,
  s3ArtifactReader,
  start,
  startGithubWorker,
} = await import('../src/main.ts');

const env = { S3_ENDPOINT: 'https://s3.test/' } as Parameters<typeof s3ArtifactReader>[0];

const ref: ArtifactRef = {
  bucket: 'raven',
  key: 'runs/a/result.json',
  bytes: 4,
  sha256: '0'.repeat(64),
  contentType: 'application/json',
  truncated: false,
};

const runRow = {
  id: 'run-1',
  orgId: 'org-1',
  projectId: 'proj-1',
  boardId: 'board-1',
  integrationId: 'expand-url',
  actorUserId: 'user-1',
  anchorNodeId: null,
  input: null,
  artifacts: null,
  status: 'parsing',
  exitCode: 0,
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  stats: null,
};

beforeEach(() => {
  redisInstances.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('s3ArtifactReader', () => {
  it('streams the artifact body chunk by chunk', async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
    let index = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          body: {
            getReader: () => ({
              read: () =>
                Promise.resolve(
                  index < chunks.length
                    ? { done: false, value: chunks[index++] }
                    : { done: true, value: undefined },
                ),
            }),
          },
        }),
      ),
    );

    const out: number[] = [];
    for await (const chunk of await s3ArtifactReader(env).read(ref)) out.push(...chunk);
    expect(out).toEqual([1, 2, 3]);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('https://s3.test/raven/runs/a/result.json');
  });

  it('skips undefined chunks and stops at done', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          body: {
            getReader: () => ({
              read: () =>
                Promise.resolve(
                  calls++ === 0
                    ? { done: false, value: undefined }
                    : { done: true, value: undefined },
                ),
            }),
          },
        }),
      ),
    );
    const out: Uint8Array[] = [];
    for await (const chunk of await s3ArtifactReader(env).read(ref)) out.push(chunk);
    expect(out).toEqual([]);
  });

  it.each([
    ['a non-ok response', { ok: false, status: 404, body: {} }],
    ['an empty body', { ok: true, status: 200, body: null }],
  ])('throws on %s', async (_label, response) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response)),
    );
    await expect(s3ArtifactReader(env).read(ref)).rejects.toThrow(/could not be read/);
  });
});

describe('prismaParseStore', () => {
  it('returns null for a run that does not exist', async () => {
    prismaMock.integrationRun.findUnique.mockResolvedValueOnce(null);
    expect(await prismaParseStore.loadRun('nope')).toBeNull();
  });

  it('defaults the nullable json columns when mapping a run row', async () => {
    prismaMock.integrationRun.findUnique.mockResolvedValueOnce(runRow);
    const row = await prismaParseStore.loadRun('run-1');
    expect(row).toMatchObject({ id: 'run-1', input: {}, artifacts: [], stats: {} });
  });

  it('keeps populated json columns as they are', async () => {
    prismaMock.integrationRun.findUnique.mockResolvedValueOnce({
      ...runRow,
      input: { url: 'x' },
      artifacts: [ref],
      stats: { bytesOut: 1 },
    });
    const row = await prismaParseStore.loadRun('run-1');
    expect(row?.artifacts).toEqual([ref]);
    expect(row?.input).toEqual({ url: 'x' });
  });

  it('does not query the projection when there are no identity keys', async () => {
    expect(await prismaParseStore.findCandidates('board-1', [])).toEqual([]);
    expect(prismaMock.boardProjectionNode.findMany).not.toHaveBeenCalled();
  });

  it('keeps only projection rows whose identity key was asked for', async () => {
    prismaMock.boardProjectionNode.findMany.mockResolvedValueOnce([
      { id: 'n1', title: 'A', type: 'url', data: { __identityKey: 'url:a' } },
      { id: 'n2', title: 'B', type: 'url', data: { __identityKey: 'url:other' } },
      { id: 'n3', title: 'C', type: 'url', data: { __identityKey: 42 } },
      { id: 'n4', title: 'D', type: 'url', data: null },
    ]);
    const matches = await prismaParseStore.findCandidates('board-1', ['url:a']);
    expect(matches).toEqual([
      {
        nodeId: 'n1',
        kind: 'unknown',
        identityKey: 'url:a',
        title: 'A',
        props: { __identityKey: 'url:a' },
        boardId: 'board-1',
      },
    ]);
  });

  it('writes a proposal row scoped to the run', async () => {
    const proposal = {
      id: 'prop-1',
      integrationId: 'expand-url',
      summary: { newNodes: 1 },
      expiresAt: '2026-02-01T00:00:00.000Z',
    };
    await prismaParseStore.saveProposal(
      proposal as never,
      { id: 'run-1', orgId: 'org-1', projectId: 'proj-1', boardId: 'board-1' } as never,
    );
    expect(prismaMock.importProposal.create.mock.calls[0]?.[0].data).toMatchObject({
      id: 'prop-1',
      runId: 'run-1',
      orgId: 'org-1',
    });
  });

  it.each([
    ['partial', 'partial'],
    ['parsing', 'succeeded'],
  ])('marking a %s run succeeded stores status %s', async (status, expected) => {
    prismaMock.integrationRun.findUnique.mockResolvedValueOnce({ status, stats: { a: 1 } });
    await prismaParseStore.markSucceeded('run-1', 'prop-1', 3);
    expect(prismaMock.integrationRun.update.mock.calls[0]?.[0].data).toEqual({
      status: expected,
      proposalId: 'prop-1',
      stats: { a: 1, itemsFound: 3 },
    });
  });

  it('tolerates a missing run row when marking succeeded', async () => {
    prismaMock.integrationRun.findUnique.mockResolvedValueOnce(null);
    await prismaParseStore.markSucceeded('run-1', 'prop-1', 0);
    expect(prismaMock.integrationRun.update.mock.calls[0]?.[0].data).toEqual({
      status: 'succeeded',
      proposalId: 'prop-1',
      stats: { itemsFound: 0 },
    });
  });

  it('records the error code and payload when marking failed', async () => {
    await prismaParseStore.markFailed('run-1', { code: 'PARSE_TIMEOUT' } as never);
    expect(prismaMock.integrationRun.update.mock.calls[0]?.[0].data).toMatchObject({
      status: 'failed',
      errorCode: 'PARSE_TIMEOUT',
    });
  });

  it('writes nothing for an empty log batch', async () => {
    await prismaParseStore.appendLog('run-1', []);
    expect(prismaMock.runLogEntry.createMany).not.toHaveBeenCalled();
  });

  it.each([
    ['no previous entry', null, 0],
    ['an existing tail', { seq: 7 }, 8],
  ])('continues the log sequence after %s', async (_label, last, firstSeq) => {
    prismaMock.runLogEntry.findFirst.mockResolvedValueOnce(last);
    await prismaParseStore.appendLog('run-1', [
      { level: 'info', phase: 'parse', message: 'a' },
      { level: 'info', phase: 'parse', message: 'b'.repeat(3000) },
    ]);
    const rows = prismaMock.runLogEntry.createMany.mock.calls[0]?.[0].data as {
      seq: number;
      message: string;
    }[];
    expect(rows.map((row) => row.seq)).toEqual([firstSeq, firstSeq + 1]);
    expect(rows[1]?.message).toHaveLength(2000);
  });
});

describe('start()', () => {
  it('registers a worker on the parse queue and shuts everything down', async () => {
    const stop = await start();

    expect(workerCtor.mock.calls[0]?.[0]).toBe(PARSE_QUEUE);
    expect(workerCtor.mock.calls[0]?.[2]).toMatchObject({ concurrency: 4 });
    expect(redisInstances).toHaveLength(2); // connection + publisher

    await stop();
    expect(workerClose).toHaveBeenCalled();
    for (const redis of redisInstances) expect(redis.disconnect).toHaveBeenCalled();
  });

  it('honours WORKER_CONCURRENCY', async () => {
    vi.stubEnv('WORKER_CONCURRENCY', '9');
    workerCtor.mockClear();
    await start();
    expect(workerCtor.mock.calls[0]?.[2]).toMatchObject({ concurrency: 9 });
  });

  it('also registers the github queue and its worker', async () => {
    workerCtor.mockClear();
    const stop = await start();
    expect(workerCtor.mock.calls[1]?.[0]).toBe('github');

    await stop();
    expect(queueClose).toHaveBeenCalled();
  });

  it('registers the registry watcher queue and its schedule (Part 2 §7)', async () => {
    workerCtor.mockClear();
    queueAdd.mockClear();
    await start();
    expect(workerCtor.mock.calls[2]?.[0]).toBe('registry.watch');
    await vi.waitFor(() => {
      expect((queueAdd.mock.calls as unknown[][]).map((call) => call[0])).toEqual(
        expect.arrayContaining(['release-watch', 'liveness-watch', 'license-watch']),
      );
    });
  });

  it('enqueues a hydrate job with the §10 idempotency key', async () => {
    workerCtor.mockClear();
    queueAdd.mockClear();
    await start();
    const deps = createHandlers.mock.lastCall?.[0] as {
      enqueueHydrate: (p: unknown) => Promise<void>;
      newId: () => string;
      now: () => number;
      createClient: (s: AbortSignal) => unknown;
    };
    await deps.enqueueHydrate({
      nodeId: 'n1',
      ref: { kind: 'repo', owner: 'a', repo: 'b', ref: null },
      boardId: 'b1',
      userId: 'u1',
    });
    const hydrateCall = (queueAdd.mock.calls as unknown[][]).find(
      (call) => call[0] === 'github.hydrate',
    );
    expect(hydrateCall).toMatchObject([
      'github.hydrate',
      { nodeId: 'n1' },
      { jobId: 'hydrate:n1:gh:repo:a/b', attempts: 4 },
    ]);
    expect(deps.newId()).not.toBe(deps.newId());
    expect(deps.now()).toBeGreaterThan(0);
    expect(deps.createClient(new AbortController().signal)).toBeDefined();
  });

  it.each([
    ['the job payload', { runId: 'run-7' }, 'run-7'],
    ['an empty payload', {}, ''],
  ])('processes a job with the run id from %s', async (_label, data, expectedRunId) => {
    workerCtor.mockClear();
    await start();
    const handler = workerCtor.mock.calls[0]?.[1] as (job: unknown) => Promise<void>;
    await handler({ data });

    expect(parseJob).toHaveBeenCalledTimes(1);
    const [deps, runId] = parseJob.mock.lastCall as unknown as [
      { newProposalId: () => string; publish: (id: string, event: unknown) => void },
      string,
    ];
    expect(runId).toBe(expectedRunId);
    expect(deps.newProposalId()).not.toBe(deps.newProposalId());

    deps.publish('run-7', { t: 'done' });
    expect(redisInstances[1]?.publish).toHaveBeenCalledWith('run:run-7', '{"t":"done"}');
    parseJob.mockClear();
  });
});

describe('startGithubWorker()', () => {
  const redis = {} as unknown as Parameters<typeof startGithubWorker>[0];
  const handlers = {
    'github.hydrate': vi.fn(() => Promise.resolve()),
    'github.tab': vi.fn(() => Promise.resolve()),
    'github.analyze': vi.fn(() => Promise.resolve()),
    'github.proposal': vi.fn(() => Promise.resolve()),
    'github.sweep': vi.fn(() => Promise.resolve()),
  };
  const store = {
    markSucceeded: vi.fn(() => Promise.resolve()),
    markCanceled: vi.fn(() => Promise.resolve()),
    markFailed: vi.fn(() => Promise.resolve()),
  };

  it('registers one worker on the github queue at the table max concurrency', () => {
    startGithubWorker(redis, handlers, store);
    expect(workerCtor.mock.lastCall?.[0]).toBe('github');
    expect(workerCtor.mock.lastCall?.[2]).toMatchObject({ concurrency: 8 });
  });

  it('routes a job by name and marks the run succeeded', async () => {
    startGithubWorker(redis, handlers, store);
    const handler = workerCtor.mock.lastCall?.[1] as (job: unknown) => Promise<void>;
    await handler({
      name: 'github.tab',
      data: { runId: 'run-9', nodeId: 'n1', tab: 'readme' },
      isActive: () => Promise.resolve(true),
    });
    expect(handlers['github.tab']).toHaveBeenCalled();
    expect(store.markSucceeded).toHaveBeenCalledWith('run-9');
  });

  it('rethrows a handler failure so BullMQ applies the retry policy', async () => {
    handlers['github.analyze'].mockRejectedValueOnce(new Error('boom'));
    startGithubWorker(redis, handlers, store);
    const handler = workerCtor.mock.lastCall?.[1] as (job: unknown) => Promise<void>;
    await expect(
      handler({
        name: 'github.analyze',
        data: { runId: 'run-10' },
        isActive: () => Promise.resolve(true),
      }),
    ).rejects.toThrow();
    expect(store.markFailed).toHaveBeenCalled();
  });

  it('uses the §10 backoff delays', () => {
    startGithubWorker(redis, handlers, store);
    const settings = (
      workerCtor.mock.lastCall?.[2] as {
        settings: { backoffStrategy: (n: number, t?: string, e?: unknown, j?: unknown) => number };
      }
    ).settings;
    expect(settings.backoffStrategy(1, '', null, { name: 'github.hydrate' })).toBe(2_000);
    expect(settings.backoffStrategy(3, '', null, { name: 'github.hydrate' })).toBe(30_000);
    expect(settings.backoffStrategy(1, '', null, undefined)).toBe(0);
  });
});

describe('prismaGithubJobStore', () => {
  it.each([
    ['markSucceeded', 'succeeded'],
    ['markCanceled', 'cancelled'],
  ] as const)('%s writes status %s', async (method, status) => {
    prismaMock.integrationRun.update.mockClear();
    await prismaGithubJobStore[method]('run-1');
    expect(prismaMock.integrationRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { status },
    });
  });

  it('markFailed records the error code and detail', async () => {
    prismaMock.integrationRun.update.mockClear();
    const payload = { code: 'GH_RATE_LIMITED', message: 'slow down', runId: 'run-1' };
    await prismaGithubJobStore.markFailed('run-1', payload as never);
    expect(prismaMock.integrationRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { status: 'failed', errorCode: 'GH_RATE_LIMITED', errorDetail: payload },
    });
  });
});
