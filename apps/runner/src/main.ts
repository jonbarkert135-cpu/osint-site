/**
 * The runner service (10_INTEGRATIONS.md §6.1).
 *
 * A separate deployable with its own service account and no database access beyond
 * `integration_runs`, `run_log_entries` and the S3 `runs/` prefix. It consumes `integration.run`,
 * executes exactly one integration per job in the sandbox, and hands the parse off to
 * `apps/worker` — the runner's container slot is the scarce resource and must not be spent parsing.
 */

import { createHash, randomUUID } from 'node:crypto';

import { Queue, Worker, type Job } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { prisma } from '@nexus/db';
import { loadServerEnvFromProcess } from '@nexus/config/env-file';
import { createLogger } from '@nexus/config/log';
import {
  builtinRegistry,
  effectiveLimits,
  networkPolicyOf,
  payloadFor,
  toErrorPayload,
  type ArtifactRef,
  type ExecutionLayer,
  type ExecutionRequest,
  type RawRunResult,
} from '@nexus/integrations';

import type { ArtifactSink } from './artifacts.ts';
import { runPlanJob, createHostAdapters } from './plan.ts';
import { watchCancel, type CancelBackend } from './cancel.ts';
import { createBuiltinExecutor } from './executors/builtin.ts';
import { createContainerExecutor, dockerRuntime } from './executors/container.ts';
import { createHttpExecutor } from './executors/http.ts';
import { nodeHostFetch, nodeResolver, nodeTransport } from './net.ts';
import {
  JOB_OPTIONS,
  PARSE_QUEUE,
  PLAN_QUEUE,
  RUN_QUEUE,
  cancelKey,
  runChannel,
  zPlanJob,
  zRunJob,
} from './protocol.ts';
import { RunLogWriter, type RunLogStore } from './runlog.ts';
import { sweep, type ReaperStore } from './reaper.ts';
import { createEgressProxy } from './sandbox/egress-proxy.ts';
import {
  DEFAULT_APPARMOR_PROFILE,
  DEFAULT_SECCOMP_PROFILE,
  EGRESS_NETWORK,
} from './sandbox/flags.ts';
import { materializeSecrets, scrub, SECRET_MOUNT } from './sandbox/secrets.ts';

const log = createLogger({
  service: 'raven-runner',
  env: process.env.NEXUS_ENV ?? 'local',
  version: process.env.NEXUS_VERSION ?? '0.1.0',
});

const REAPER_INTERVAL_MS = 30_000;

/** S3 sink over presigned PUTs — the same signer the API uses, no AWS SDK (see files/s3.ts). */
export function s3Sink(env: ReturnType<typeof loadServerEnvFromProcess>): ArtifactSink {
  return {
    async put(key, body, contentType) {
      const url = `${env.S3_ENDPOINT.replace(/\/$/, '')}/${env.S3_BUCKET}/${key}`;
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          'content-type': contentType,
          'content-disposition': 'attachment',
          'x-amz-content-sha256': createHash('sha256').update(body).digest('hex'),
          'x-amz-server-side-encryption': 'AES256',
        },
        body,
      });
      if (!response.ok) throw new Error(`artifact upload failed with ${String(response.status)}`);
    },
  };
}

export const prismaRunLogStore: RunLogStore = {
  async append(entries) {
    if (entries.length === 0) return;
    await prisma.runLogEntry.createMany({
      data: entries.map((entry) => ({
        runId: entry.runId,
        seq: entry.seq,
        at: new Date(entry.at),
        level: entry.level,
        phase: entry.phase,
        message: entry.message,
        // Prisma's Json input rejects `undefined` under exactOptionalPropertyTypes; an entry with
        // no structured data stores `{}` rather than a column-level null.
        data: (entry.data ?? {}) as unknown as Record<string, never>,
      })),
      skipDuplicates: true,
    });
  },
  async nextSeq(runId) {
    const last = await prisma.runLogEntry.findFirst({
      where: { runId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    return (last?.seq ?? -1) + 1;
  },
};

export const prismaReaperStore: ReaperStore = {
  async listActiveRuns() {
    const rows = await prisma.integrationRun.findMany({
      where: { status: { in: ['starting', 'running'] } },
      select: { id: true, status: true, startedAt: true, input: true },
    });
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      startedAt: row.startedAt,
      // The effective wall clock was written into the run row's stats at start time; the manifest
      // default is the floor so a missing value can never mean "never time out".
      wallClockMs: 300_000,
    }));
  },
  async listStuckParsing(olderThanMs) {
    const rows = await prisma.integrationRun.findMany({
      where: { status: 'parsing', startedAt: { lt: new Date(Date.now() - olderThanMs) } },
      select: { id: true, status: true, startedAt: true },
    });
    return rows.map((row) => ({ ...row, wallClockMs: 0 }));
  },
  async failRun(runId, code, detail) {
    await prisma.integrationRun.update({
      where: { id: runId },
      data: {
        status: 'failed',
        errorCode: code,
        errorDetail: { ...payloadFor(code, { runId }), ...detail } as unknown as Record<
          string,
          never
        >,
        finishedAt: new Date(),
      },
    });
  },
  flagStaleParsing(runId): Promise<void> {
    log.warn(
      { event: 'run.parse.stale', run_id: runId },
      'run has been parsing for over 10 minutes',
    );
    return Promise.resolve();
  },
};

function redisCancelBackend(redis: Redis, subscriber: Redis): CancelBackend {
  return {
    get: (key) => redis.get(key),
    set: async (key, value, ttlMs) => {
      await redis.set(key, value, 'PX', Math.max(1, ttlMs));
    },
    async subscribe(channel, listener) {
      await subscriber.subscribe(channel);
      const handler = (received: string, message: string): void => {
        if (received === channel) listener(message);
      };
      subscriber.on('message', handler);
      return async () => {
        subscriber.off('message', handler);
        await subscriber.unsubscribe(channel);
      };
    },
  };
}

export interface RunnerDeps {
  readonly redis: Redis;
  readonly subscriber: Redis;
  readonly parseQueue: Queue;
  readonly sink: ArtifactSink;
  readonly bucket: string;
  readonly proxyUrl: string;
  readonly allowedRegistries?: readonly string[];
}

/**
 * Executes one job. Exported so the integration test can drive it without a queue: the queue is
 * plumbing, this is the behaviour.
 */
export async function runJob(deps: RunnerDeps, raw: unknown): Promise<RawRunResult> {
  const job = zRunJob.parse(raw);
  const run = await prisma.integrationRun.findUnique({ where: { id: job.runId } });
  if (run === null) throw new Error(`run ${job.runId} does not exist`);

  const entry = builtinRegistry().entries.get(run.integrationId);
  const writer = new RunLogWriter({ runId: run.id, store: prismaRunLogStore });
  await writer.start();

  if (entry === undefined) {
    const payload = payloadFor('INTEGRATION_DISABLED', { runId: run.id });
    writer.error('validate', payload);
    await writer.flush();
    await prisma.integrationRun.update({
      where: { id: run.id },
      data: {
        status: 'failed',
        errorCode: payload.code,
        errorDetail: payload as unknown as Record<string, never>,
        finishedAt: new Date(),
      },
    });
    throw new Error(payload.code);
  }

  const manifest = entry.manifest;
  const network = networkPolicyOf(manifest);
  const limits = effectiveLimits(manifest.execution.limits, network);
  const watch = await watchCancel(redisCancelBackend(deps.redis, deps.subscriber), run.id);

  await prisma.integrationRun.update({
    where: { id: run.id },
    data: { status: 'starting', startedAt: new Date(), attempt: job.attempt },
  });
  await deps.redis.publish(
    runChannel(run.id),
    JSON.stringify({ t: 'status', status: 'starting', at: new Date().toISOString() }),
  );
  writer.log({
    level: 'info',
    phase: 'start',
    message: `runner claimed the run (attempt ${String(job.attempt)})`,
  });

  const secrets =
    manifest.execution.kind === 'container'
      ? await materializeSecrets({
          runId: run.id,
          projectId: run.projectId,
          secretEnv: manifest.execution.secretEnv,
          secretFiles: [],
          baseDir: SECRET_MOUNT,
          resolver: { read: () => Promise.resolve(undefined) },
        })
      : undefined;

  const common = {
    sink: deps.sink,
    bucket: deps.bucket,
    orgId: run.orgId,
    watch,
    now: () => new Date().toISOString(),
  };

  let executor: ExecutionLayer;
  if (manifest.execution.kind === 'builtin') {
    executor = createBuiltinExecutor({
      ...common,
      transport: nodeTransport,
      resolve: nodeResolver,
      log: (message) => writer.log({ level: 'info', phase: 'exec', message }),
    });
  } else if (manifest.execution.kind === 'http') {
    executor = createHttpExecutor({
      ...common,
      transport: nodeTransport,
      resolve: nodeResolver,
      ...(secrets === undefined ? {} : { secrets: secrets.env }),
    });
  } else {
    executor = createContainerExecutor({
      ...common,
      runtime: dockerRuntime(),
      ...(secrets === undefined ? {} : { secrets: secrets.env }),
      ...(deps.allowedRegistries === undefined
        ? {}
        : { allowedRegistries: deps.allowedRegistries }),
      sandbox: {
        runtime: process.env.NODE_ENV === 'production' ? 'runsc' : 'runc',
        proxyUrl: deps.proxyUrl,
        network: EGRESS_NETWORK,
        seccompProfile: DEFAULT_SECCOMP_PROFILE,
        apparmorProfile: DEFAULT_APPARMOR_PROFILE,
        env: {},
        secretEnv: manifest.execution.secretEnv,
      },
      onStdout: (chunk) => {
        void deps.redis.publish(runChannel(run.id), JSON.stringify({ t: 'stdout', chunk }));
      },
    });
  }

  await prisma.integrationRun.update({ where: { id: run.id }, data: { status: 'running' } });

  const request: ExecutionRequest = {
    runId: run.id,
    manifest,
    input: run.input,
    secretsRef: Object.values(
      manifest.execution.kind === 'container' ? manifest.execution.secretEnv : {},
    ),
    limits,
    cancelToken: cancelKey(run.id),
  };

  let result: RawRunResult;
  try {
    result = await executor.execute(request);
  } catch (error) {
    result = {
      runId: run.id,
      status: 'failed',
      exitCode: null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      artifacts: [],
      stats: { bytesOut: 0, egressRequests: 0, egressDenied: 0, peakMemMiB: 0 },
      error: toErrorPayload(error, run.id),
    };
  } finally {
    await watch.stop();
    await secrets?.cleanup();
  }

  writer.log({
    level: result.error === undefined ? 'info' : 'error',
    phase: 'collect',
    message: scrub(
      `run finished as ${result.status} with ${String(result.artifacts.length)} artifact(s)`,
      secrets?.env ?? {},
    ),
  });
  await writer.flush();

  const parseable = result.status === 'succeeded' || result.status === 'partial';
  await prisma.integrationRun.update({
    where: { id: run.id },
    data: {
      status: parseable ? 'parsing' : result.status,
      exitCode: result.exitCode,
      finishedAt: new Date(result.finishedAt),
      durationMs: result.durationMs,
      stats: result.stats as unknown as Record<string, never>,
      artifacts: result.artifacts as unknown as Record<string, never>[],
      ...(result.error === undefined
        ? {}
        : {
            errorCode: result.error.code,
            errorDetail: result.error as unknown as Record<string, never>,
          }),
    },
  });

  if (parseable) {
    await deps.parseQueue.add(
      PARSE_QUEUE,
      { runId: run.id, orgId: run.orgId, attempt: 1 },
      JOB_OPTIONS,
    );
  } else {
    await deps.redis.publish(
      runChannel(run.id),
      JSON.stringify({ t: 'done', status: result.status, error: result.error }),
    );
  }

  return result;
}

/** Reads a collected artifact back as text — the engine's stdout for the adapter (Part 2 §37). */
export function s3Read(env: ReturnType<typeof loadServerEnvFromProcess>) {
  return async (ref: ArtifactRef): Promise<string> => {
    const url = `${env.S3_ENDPOINT.replace(/\/$/, '')}/${ref.bucket}/${ref.key}`;
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) throw new Error(`artifact read failed with ${String(response.status)}`);
    return await response.text();
  };
}

/**
 * Executes one query plan on this host (Part 2 §36/§37). This is the trigger the architecture was
 * missing: `plan.ts` could always run a plan, but nothing asked it to. The engines reach processes
 * through the same container executor and the same sandbox flags every integration run gets — one
 * confinement, not a second door (N5) — and progress is published on the run channel so a UI can
 * follow it exactly like a run.
 */
export async function runPlanQueueJob(
  deps: RunnerDeps & { readonly readArtifact: (ref: ArtifactRef) => Promise<string> },
  raw: unknown,
): Promise<void> {
  const job = zPlanJob.parse(raw);
  const watch = await watchCancel(redisCancelBackend(deps.redis, deps.subscriber), job.runId);
  const executor = createContainerExecutor({
    sink: deps.sink,
    bucket: deps.bucket,
    orgId: job.orgId,
    watch,
    now: () => new Date().toISOString(),
    runtime: dockerRuntime(),
    ...(deps.allowedRegistries === undefined ? {} : { allowedRegistries: deps.allowedRegistries }),
    sandbox: {
      runtime: process.env.NODE_ENV === 'production' ? 'runsc' : 'runc',
      proxyUrl: deps.proxyUrl,
      network: EGRESS_NETWORK,
      seccompProfile: DEFAULT_SECCOMP_PROFILE,
      apparmorProfile: DEFAULT_APPARMOR_PROFILE,
      env: {},
      secretEnv: {},
    },
  });

  try {
    const result = await runPlanJob(job, {
      adapters: createHostAdapters({
        manifestFor: (id) => builtinRegistry().entries.get(id)?.manifest,
        executor,
        readArtifact: deps.readArtifact,
        runId: () => job.runId,
        cancelToken: cancelKey,
      }),
      fetch: nodeHostFetch,
      onEvent: (event) => {
        void deps.redis.publish(runChannel(job.runId), JSON.stringify(event));
      },
    });
    log.info(
      {
        event: 'plan.finished',
        run_id: job.runId,
        entities: result.entities.length,
        warnings: result.summary.warnings.length,
      },
      'plan finished',
    );
  } finally {
    await watch.stop();
  }
}

export async function start(): Promise<() => Promise<void>> {
  const env = loadServerEnvFromProcess();
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const subscriber = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const parseQueue = new Queue(PARSE_QUEUE, { connection });
  const proxy = createEgressProxy();
  const proxyPort = await proxy.listen(3128);

  const deps: RunnerDeps = {
    redis: connection,
    subscriber,
    parseQueue,
    sink: s3Sink(env),
    bucket: env.S3_BUCKET,
    proxyUrl: `http://egress:${String(proxyPort)}`,
  };

  const planWorker = new Worker(
    PLAN_QUEUE,
    async (job: Job) => {
      log.info({ event: 'plan.claimed', job_id: job.id }, 'claimed a plan');
      await runPlanQueueJob({ ...deps, readArtifact: s3Read(env) }, job.data);
    },
    { connection, concurrency: 1 },
  );

  const worker = new Worker(
    RUN_QUEUE,
    async (job: Job) => {
      const id = randomUUID();
      log.info({ event: 'run.claimed', job_id: job.id, trace: id }, 'claimed a run');
      await runJob(deps, job.data);
    },
    { connection, concurrency: Number(process.env.RUNNER_CONCURRENCY ?? 2) },
  );

  const runtime = dockerRuntime();
  const reaper = setInterval(() => {
    void sweep({
      store: prismaReaperStore,
      liveContainers: () => runtime.listRunIds().catch(() => []),
      killContainer: (runId) => runtime.kill(runId, 'SIGKILL'),
    }).catch((error: unknown) =>
      log.error({ event: 'reaper.failed', err: error }, 'reaper sweep failed'),
    );
  }, REAPER_INTERVAL_MS);

  log.info(
    { event: 'runner.started', proxy_port: proxyPort },
    'runner is consuming integration.run and query.plan',
  );

  return async () => {
    clearInterval(reaper);
    await worker.close();
    await planWorker.close();
    await parseQueue.close();
    await proxy.close();
    connection.disconnect();
    subscriber.disconnect();
  };
}

// `node src/main.ts` starts the service; importing the module (tests) does not.
if (process.argv[1]?.endsWith('main.ts') === true) {
  void start();
}
