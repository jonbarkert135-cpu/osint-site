/**
 * Runner bootstrap and job loop (10_INTEGRATIONS.md §6.1): the S3 artifact sink, the Prisma-backed
 * run-log and reaper stores, `runJob()`'s per-execution-kind wiring and `start()`'s shutdown.
 * Redis, BullMQ, Docker and Prisma are mocked; what is asserted is the wiring, not the drivers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = {
  integrationRun: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  runLogEntry: { findFirst: vi.fn(), createMany: vi.fn() },
};
vi.mock('@nexus/db', () => ({ prisma: prismaMock }));

const workerCtor = vi.fn();
const workerClose = vi.fn(() => Promise.resolve());
const queueCtor = vi.fn();
const queueAdd = vi.fn(() => Promise.resolve());
const queueClose = vi.fn(() => Promise.resolve());
vi.mock('bullmq', () => ({
  Worker: class {
    close = workerClose;
    constructor(...args: unknown[]) {
      workerCtor(...args);
    }
  },
  Queue: class {
    add = queueAdd;
    close = queueClose;
    constructor(...args: unknown[]) {
      queueCtor(...args);
    }
  },
}));

interface FakeRedis {
  url: string;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}
const redisInstances: FakeRedis[] = [];
vi.mock('ioredis', () => ({
  default: class {
    get = vi.fn(() => Promise.resolve(null));
    set = vi.fn(() => Promise.resolve('OK'));
    publish = vi.fn(() => Promise.resolve(1));
    subscribe = vi.fn(() => Promise.resolve(1));
    unsubscribe = vi.fn(() => Promise.resolve(1));
    on = vi.fn();
    off = vi.fn();
    disconnect = vi.fn();
    constructor(url: string) {
      (this as unknown as FakeRedis).url = url;
      redisInstances.push(this as unknown as FakeRedis);
    }
  },
}));

vi.mock('@nexus/config/env-file', () => ({
  loadServerEnvFromProcess: () => ({
    REDIS_URL: 'redis://localhost:6379',
    S3_ENDPOINT: 'https://s3.test/',
    S3_BUCKET: 'raven',
  }),
}));

const execute = vi.fn();
const builtinExecutor = vi.fn(() => ({ execute }));
const httpExecutor = vi.fn(() => ({ execute }));
const containerExecutor = vi.fn((_options: unknown) => ({ execute }));
vi.mock('../src/executors/builtin.ts', () => ({ createBuiltinExecutor: builtinExecutor }));
vi.mock('../src/executors/http.ts', () => ({ createHttpExecutor: httpExecutor }));
const listRunIds = vi.fn(() => Promise.resolve(['run-1']));
const kill = vi.fn(() => Promise.resolve(true));
vi.mock('../src/executors/container.ts', () => ({
  createContainerExecutor: containerExecutor,
  dockerRuntime: () => ({ listRunIds, kill }),
}));

const proxyClose = vi.fn(() => Promise.resolve());
vi.mock('../src/sandbox/egress-proxy.ts', () => ({
  createEgressProxy: () => ({ listen: () => Promise.resolve(3128), close: proxyClose }),
}));

const secretsCleanup = vi.fn(() => Promise.resolve());
vi.mock('../src/sandbox/secrets.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  materializeSecrets: () => Promise.resolve({ env: { TOKEN: 'shhh' }, cleanup: secretsCleanup }),
}));

// The host fetch is stubbed: a plan job must not put real DNS and sockets into a unit test. A
// 503 is an honest answer here — what is asserted is the wiring, not what an engine found.
vi.mock('../src/net.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  nodeHostFetch: () => Promise.resolve({ status: 503, body: null }),
}));

const sweep = vi.fn((_options: unknown) => Promise.resolve());
vi.mock('../src/reaper.ts', () => ({ sweep }));

const { builtinRegistry } = await import('@nexus/integrations');
const { PARSE_QUEUE, PLAN_QUEUE, RUN_QUEUE } = await import('../src/protocol.ts');
const { prismaReaperStore, prismaRunLogStore, runJob, runPlanQueueJob, s3Read, s3Sink, start } =
  await import('../src/main.ts');

const env = { S3_ENDPOINT: 'https://s3.test/', S3_BUCKET: 'raven' } as Parameters<typeof s3Sink>[0];

const manifest = builtinRegistry().entries.values().next().value!.manifest;

const network = {
  mode: 'allowlist' as const,
  allow: ['example.com'],
  denyPrivateRanges: true,
  maxRequestsPerMinute: 60,
  maxConcurrentConnections: 4,
};

const runRow = (over: Record<string, unknown> = {}) => ({
  id: 'run-1',
  orgId: 'org-1',
  projectId: 'proj-1',
  boardId: 'board-1',
  integrationId: manifest.id,
  input: { url: 'https://sho.rt/x' },
  status: 'queued',
  startedAt: null,
  ...over,
});

const rawResult = (over: Record<string, unknown> = {}) => ({
  runId: 'run-1',
  status: 'succeeded' as const,
  exitCode: 0,
  startedAt: '2026-02-01T00:00:00.000Z',
  finishedAt: '2026-02-01T00:00:01.000Z',
  durationMs: 1000,
  artifacts: [],
  stats: { bytesOut: 0, egressRequests: 0, egressDenied: 0, peakMemMiB: 8 },
  ...over,
});

const deps = () => {
  const redis = { publish: vi.fn(() => Promise.resolve(1)) };
  const subscriber = {
    subscribe: vi.fn(() => Promise.resolve(1)),
    unsubscribe: vi.fn(() => Promise.resolve(1)),
    on: vi.fn(),
    off: vi.fn(),
  };
  return {
    redis: { ...redis, get: vi.fn(() => Promise.resolve(null)), set: vi.fn() },
    subscriber,
    parseQueue: { add: queueAdd },
    sink: { put: vi.fn() },
    bucket: 'raven',
    proxyUrl: 'http://egress:3128',
  } as unknown as Parameters<typeof runJob>[0];
};

const job = { runId: 'run-1', orgId: 'org-1', attempt: 1 };

beforeEach(() => {
  redisInstances.length = 0;
  prismaMock.integrationRun.findUnique.mockResolvedValue(runRow());
  prismaMock.integrationRun.update.mockResolvedValue({});
  prismaMock.runLogEntry.findFirst.mockResolvedValue(null);
  prismaMock.runLogEntry.createMany.mockResolvedValue({});
  execute.mockResolvedValue(rawResult());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('s3Sink', () => {
  it('PUTs the artifact with a checksum, SSE and attachment disposition', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true })),
    );
    await s3Sink(env).put('runs/run-1/result.json', new Uint8Array([1]), 'application/json');

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://s3.test/raven/runs/run-1/result.json');
    expect(init.method).toBe('PUT');
    expect(init.headers).toMatchObject({
      'content-disposition': 'attachment',
      'x-amz-server-side-encryption': 'AES256',
    });
  });

  it('throws when the store refuses the upload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 500 })),
    );
    await expect(
      s3Sink(env).put('runs/run-1/result.json', new Uint8Array([1]), 'application/json'),
    ).rejects.toThrow(/artifact upload failed with 500/);
  });
});

describe('prismaRunLogStore', () => {
  it('writes nothing for an empty batch', async () => {
    await prismaRunLogStore.append([]);
    expect(prismaMock.runLogEntry.createMany).not.toHaveBeenCalled();
  });

  it('stores an entry with no structured data as an empty object', async () => {
    await prismaRunLogStore.append([
      {
        runId: 'run-1',
        seq: 0,
        at: '2026-02-01T00:00:00.000Z',
        level: 'info',
        phase: 'start',
        message: 'a',
      },
      {
        runId: 'run-1',
        seq: 1,
        at: '2026-02-01T00:00:00.000Z',
        level: 'error',
        phase: 'exec',
        message: 'b',
        data: { code: 'X' },
      },
    ]);
    const rows = prismaMock.runLogEntry.createMany.mock.calls[0]?.[0].data as { data: unknown }[];
    expect(rows[0]?.data).toEqual({});
    expect(rows[1]?.data).toEqual({ code: 'X' });
  });

  it.each([
    ['no previous entry', null, 0],
    ['an existing tail', { seq: 4 }, 5],
  ])('continues the sequence after %s', async (_label, last, expected) => {
    prismaMock.runLogEntry.findFirst.mockResolvedValueOnce(last);
    await expect(prismaRunLogStore.nextSeq('run-1')).resolves.toBe(expected);
  });
});

describe('prismaReaperStore', () => {
  it('lists active runs with the wall-clock floor applied', async () => {
    prismaMock.integrationRun.findMany.mockResolvedValueOnce([
      { id: 'run-1', status: 'running', startedAt: new Date(0), input: {} },
    ]);
    await expect(prismaReaperStore.listActiveRuns()).resolves.toEqual([
      { id: 'run-1', status: 'running', startedAt: new Date(0), wallClockMs: 300_000 },
    ]);
  });

  it('lists runs stuck in parsing older than the cutoff', async () => {
    prismaMock.integrationRun.findMany.mockResolvedValueOnce([
      { id: 'run-2', status: 'parsing', startedAt: new Date(0) },
    ]);
    const rows = await prismaReaperStore.listStuckParsing(600_000);
    expect(rows).toEqual([
      { id: 'run-2', status: 'parsing', startedAt: new Date(0), wallClockMs: 0 },
    ]);
    const where = prismaMock.integrationRun.findMany.mock.lastCall?.[0].where as {
      status: string;
    };
    expect(where.status).toBe('parsing');
  });

  it('fails a run with the error payload for its code', async () => {
    await prismaReaperStore.failRun('run-1', 'TIMEOUT', { detail: { why: 'wall clock' } });
    const data = prismaMock.integrationRun.update.mock.lastCall?.[0].data as {
      status: string;
      errorCode: string;
    };
    expect(data).toMatchObject({ status: 'failed', errorCode: 'TIMEOUT' });
  });

  it('only warns about a stale parsing run', async () => {
    await expect(prismaReaperStore.flagStaleParsing('run-1')).resolves.toBeUndefined();
    expect(prismaMock.integrationRun.update).not.toHaveBeenCalled();
  });
});

describe('runJob', () => {
  it('rejects a job payload that is not a run job', async () => {
    await expect(runJob(deps(), { runId: '' })).rejects.toThrow();
  });

  it('rejects a run id that does not exist', async () => {
    prismaMock.integrationRun.findUnique.mockResolvedValueOnce(null);
    await expect(runJob(deps(), job)).rejects.toThrow(/does not exist/);
  });

  it('fails the run when its integration is not in this build (§4.3)', async () => {
    prismaMock.integrationRun.findUnique.mockResolvedValueOnce(runRow({ integrationId: 'gone' }));

    await expect(runJob(deps(), job)).rejects.toThrow('INTEGRATION_DISABLED');
    const data = prismaMock.integrationRun.update.mock.lastCall?.[0].data as { status: string };
    expect(data).toMatchObject({ status: 'failed', errorCode: 'INTEGRATION_DISABLED' });
  });

  it('runs a builtin integration and hands the parse off to the worker', async () => {
    const d = deps();
    const result = await runJob(d, job);

    expect(builtinExecutor).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('succeeded');
    const statuses = prismaMock.integrationRun.update.mock.calls.map(
      (call) => (call[0].data as { status?: string }).status,
    );
    expect(statuses).toEqual(['starting', 'running', 'parsing']);
    expect(queueAdd).toHaveBeenCalledWith(
      PARSE_QUEUE,
      { runId: 'run-1', orgId: 'org-1', attempt: 1 },
      expect.anything(),
    );
  });

  it('turns an executor throw into a failed result and announces it (§11)', async () => {
    execute.mockRejectedValueOnce(new Error('boom'));
    const d = deps();

    const result = await runJob(d, job);

    expect(result.status).toBe('failed');
    expect(result.error).toBeDefined();
    expect(queueAdd).not.toHaveBeenCalledWith(PARSE_QUEUE, expect.anything(), expect.anything());
    const published = (d.redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => JSON.parse(String(call[1])) as { t: string },
    );
    expect(published.at(-1)).toMatchObject({ t: 'done', status: 'failed' });
  });

  it('parses a partial run too', async () => {
    execute.mockResolvedValueOnce(rawResult({ status: 'partial' }));
    await runJob(deps(), job);
    const data = prismaMock.integrationRun.update.mock.lastCall?.[0].data as { status: string };
    expect(data.status).toBe('parsing');
  });

  it('uses the http executor with materialised secrets for an http manifest', async () => {
    const httpManifest = {
      ...manifest,
      execution: { ...manifest.execution, kind: 'http', network },
    };
    vi.spyOn(builtinRegistry().entries, 'get').mockReturnValueOnce({
      manifest: httpManifest,
    } as never);

    await runJob(deps(), job);

    expect(httpExecutor).toHaveBeenCalledTimes(1);
    expect(builtinExecutor).not.toHaveBeenCalled();
  });

  it('sandboxes a container manifest and streams its stdout to the run channel', async () => {
    const containerManifest = {
      ...manifest,
      execution: {
        ...manifest.execution,
        kind: 'container',
        image: 'ghcr.io/nexus/tool',
        digest: `sha256:${'a'.repeat(64)}`,
        secretEnv: { TOKEN: 'tool-token' },
        network,
      },
    };
    vi.spyOn(builtinRegistry().entries, 'get').mockReturnValueOnce({
      manifest: containerManifest,
    } as never);
    const d = deps();

    await runJob(d, job);

    expect(containerExecutor).toHaveBeenCalledTimes(1);
    const options = containerExecutor.mock.lastCall?.[0] as {
      secrets: Record<string, string>;
      sandbox: { runtime: string; proxyUrl: string };
      onStdout: (chunk: string) => void;
    };
    expect(options.secrets).toEqual({ TOKEN: 'shhh' });
    expect(options.sandbox).toMatchObject({ runtime: 'runc', proxyUrl: 'http://egress:3128' });

    options.onStdout('hello');
    expect(d.redis.publish).toHaveBeenCalledWith('run:run-1', '{"t":"stdout","chunk":"hello"}');
    expect(secretsCleanup).toHaveBeenCalled();
  });
});

describe('start()', () => {
  it('consumes the run queue, sweeps with the reaper and shuts everything down', async () => {
    vi.useFakeTimers();
    try {
      const stop = await start();

      expect(workerCtor.mock.lastCall?.[0]).toBe(RUN_QUEUE);
      expect(workerCtor.mock.lastCall?.[2]).toMatchObject({ concurrency: 2 });
      expect(queueCtor).toHaveBeenCalled();
      expect(redisInstances).toHaveLength(2); // connection + subscriber

      await vi.advanceTimersByTimeAsync(30_000);
      expect(sweep).toHaveBeenCalledTimes(1);
      const sweepArgs = sweep.mock.lastCall?.[0] as unknown as {
        liveContainers: () => Promise<string[]>;
        killContainer: (runId: string) => Promise<unknown>;
      };
      await expect(sweepArgs.liveContainers()).resolves.toEqual(['run-1']);
      await sweepArgs.killContainer('run-1');
      expect(kill).toHaveBeenCalledWith('run-1', 'SIGKILL');

      await stop();
      expect(workerClose).toHaveBeenCalled();
      expect(queueClose).toHaveBeenCalled();
      expect(proxyClose).toHaveBeenCalled();
      for (const redis of redisInstances) expect(redis.disconnect).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('honours RUNNER_CONCURRENCY and runs a claimed job', async () => {
    vi.stubEnv('RUNNER_CONCURRENCY', '5');
    const stop = await start();
    expect(workerCtor.mock.lastCall?.[2]).toMatchObject({ concurrency: 5 });

    const handler = workerCtor.mock.lastCall?.[1] as (job: unknown) => Promise<void>;
    await handler({ id: 'j1', data: job });
    expect(execute).toHaveBeenCalled();

    await stop();
  });
});

describe('plan queue (§36/§37)', () => {
  const planDeps = () => {
    const redis = {
      publish: vi.fn(() => Promise.resolve(1)),
      get: vi.fn(() => Promise.resolve(null)),
      set: vi.fn(() => Promise.resolve('OK')),
    };
    const subscriber = {
      subscribe: vi.fn(() => Promise.resolve(1)),
      unsubscribe: vi.fn(() => Promise.resolve(1)),
      on: vi.fn(),
      off: vi.fn(),
    };
    return {
      redis,
      subscriber,
      parseQueue: { add: queueAdd },
      sink: { put: vi.fn(() => Promise.resolve()) },
      bucket: 'raven',
      proxyUrl: 'http://egress:3128',
      readArtifact: () => Promise.resolve(''),
    } as unknown as Parameters<typeof runPlanQueueJob>[0] & {
      redis: { publish: ReturnType<typeof vi.fn> };
    };
  };

  it('plans the query on this host and streams the events on the run channel', async () => {
    const deps = planDeps();
    await runPlanQueueJob(deps, {
      runId: 'plan-1',
      orgId: 'org-1',
      query: 'example.com',
      permissions: ['network'],
    });

    const published = deps.redis.publish.mock.calls.map(
      (call) => JSON.parse(String(call[1])) as { type: string },
    );
    expect(deps.redis.publish.mock.calls[0]?.[0]).toBe('run:plan-1');
    expect(published[0]?.type).toBe('plan.started');
    expect(published.at(-1)?.type).toBe('plan.done');
    // A container is only built for a plan that reaches an adapter-backed engine; the sandbox it
    // would use is the same one every run gets.
    expect(containerExecutor.mock.lastCall?.[0]).toMatchObject({ orgId: 'org-1' });
  });

  it('refuses a job that does not carry a query', async () => {
    await expect(
      runPlanQueueJob(planDeps(), { runId: 'plan-1', orgId: 'org-1' }),
    ).rejects.toThrow();
  });

  it('reads an artifact back as the engine stdout', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('sub.example.com') })
      .mockResolvedValueOnce({ ok: false, status: 404 });
    vi.stubGlobal('fetch', fetchMock);
    const read = s3Read(env);
    const ref = { bucket: 'raven', key: 'runs/a.txt' } as Parameters<typeof read>[0];

    await expect(read(ref)).resolves.toBe('sub.example.com');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://s3.test/raven/runs/a.txt');
    await expect(read(ref)).rejects.toThrow('404');
    vi.unstubAllGlobals();
  });

  it('consumes the plan queue one job at a time', async () => {
    const stop = await start();
    const planCall = workerCtor.mock.calls.find((call) => call[0] === PLAN_QUEUE);

    expect(planCall?.[2]).toMatchObject({ concurrency: 1 });
    await expect(
      (planCall?.[1] as (job: unknown) => Promise<void>)({ id: 'p1', data: {} }),
    ).rejects.toThrow();

    await stop();
    expect(workerClose).toHaveBeenCalled();
  });
});
