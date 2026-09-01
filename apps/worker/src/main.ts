/**
 * `apps/worker` — the first BullMQ consumer this codebase ships (10_INTEGRATIONS.md §2).
 *
 * It runs the CPU-heavy half of the pipeline (stages 3–7) outside the runner's container slot. It
 * depends on `packages/db`, `packages/domain` and `packages/integrations`, and deliberately not on
 * `apps/runner`: the only contract between the two services is the queue payload and the artifact
 * store.
 */

import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { Prisma, prisma } from '@nexus/db';
import { openAICompatibleEmbedder, unavailableEmbedder, type Embedder } from '@nexus/ai';
import { loadServerEnvFromProcess } from '@nexus/config/env-file';
import { createLogger } from '@nexus/config/log';
import { newId } from '@nexus/domain';
import { IDENTITY_KEY_PROP, type ArtifactRef, type ExistingNodeMatch } from '@nexus/integrations';

import { createGithubHandlers } from '@nexus/integrations/github/handlers';
import { GithubClient } from '@nexus/integrations/github/client';
import {
  GITHUB_JOB_SPECS,
  GITHUB_QUEUE,
  githubBackoff,
  githubJobOptions,
  type GithubJobName,
  type GithubJobPayload,
} from '@nexus/integrations/github/jobs';

import { measureJob, pollQueueDepth, startMetricsServer } from './metrics.ts';
import { createGithubHttp } from './net/github-http.ts';
import {
  WATCHER_QUEUE,
  githubGet,
  jsonFetch,
  textFetch,
  processWatcherJob,
  registerWatcherSchedule,
} from './watchers/queue.ts';
import type { WatcherName } from './watchers/checks.ts';
import { createGithubHandlerStore, syncNodePatcher } from './stores/github.ts';
import { processGithubJob, type GithubHandlers, type GithubJobStore } from './queues/github.ts';
import {
  processParseJob,
  type ArtifactReader,
  type ParseStore,
  type RunRow,
} from './queues/integration.parse.ts';
import {
  AI_EMBED_QUEUE,
  processEmbedJob,
  type EmbedJobPayload,
  type EmbedStore,
} from './queues/ai.embed.ts';

const log = createLogger({
  service: 'raven-worker',
  env: process.env.NEXUS_ENV ?? 'local',
  version: process.env.NEXUS_VERSION ?? '0.1.0',
});

export const PARSE_QUEUE = 'integration.parse';

/** Reads an artifact back out of S3 as a stream; the parser never buffers a whole 40 MB document. */
export function s3ArtifactReader(env: ReturnType<typeof loadServerEnvFromProcess>): ArtifactReader {
  return {
    async read(ref: ArtifactRef) {
      const url = `${env.S3_ENDPOINT.replace(/\/$/, '')}/${ref.bucket}/${ref.key}`;
      const response = await fetch(url);
      if (!response.ok || response.body === null) {
        throw new Error(`artifact ${ref.key} could not be read (${String(response.status)})`);
      }
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      return (async function* stream() {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value !== undefined) yield value;
        }
      })();
    },
  };
}

export const prismaParseStore: ParseStore = {
  async loadRun(runId) {
    const row = await prisma.integrationRun.findUnique({ where: { id: runId } });
    if (row === null) return null;
    return {
      id: row.id,
      orgId: row.orgId,
      projectId: row.projectId,
      boardId: row.boardId,
      integrationId: row.integrationId,
      actorUserId: row.actorUserId,
      anchorNodeId: row.anchorNodeId,
      input: (row.input ?? {}) as Record<string, unknown>,
      artifacts: (row.artifacts ?? []) as unknown as ArtifactRef[],
      status: row.status,
      exitCode: row.exitCode,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      durationMs: row.durationMs,
      stats: (row.stats ?? {}) as unknown as RunRow['stats'],
    };
  },

  async findCandidates(boardId, identityKeys) {
    if (identityKeys.length === 0) return [];
    // The projection (P8) is the queryable mirror of the board; identity keys live in `data`.
    const rows = await prisma.boardProjectionNode.findMany({
      where: { boardId, deletedAt: null },
      select: { id: true, title: true, type: true, data: true },
      take: 5000,
    });
    const wanted = new Set(identityKeys);
    const matches: ExistingNodeMatch[] = [];
    for (const row of rows) {
      const data = (row.data ?? {}) as Record<string, unknown>;
      const key = data[IDENTITY_KEY_PROP];
      if (typeof key !== 'string' || !wanted.has(key)) continue;
      matches.push({
        nodeId: row.id,
        kind: 'unknown',
        identityKey: key,
        title: row.title,
        props: data,
        boardId,
      });
    }
    return matches;
  },

  async saveProposal(proposal, run) {
    await prisma.importProposal.create({
      data: {
        id: proposal.id,
        orgId: run.orgId,
        projectId: run.projectId,
        boardId: run.boardId,
        runId: run.id,
        integrationId: proposal.integrationId,
        payload: proposal as unknown as Record<string, never>,
        summary: proposal.summary as unknown as Record<string, never>,
        expiresAt: new Date(proposal.expiresAt),
      },
    });
  },

  async markSucceeded(runId, proposalId, itemsFound) {
    const run = await prisma.integrationRun.findUnique({
      where: { id: runId },
      select: { status: true, stats: true },
    });
    await prisma.integrationRun.update({
      where: { id: runId },
      data: {
        // A run that produced partial output stays `partial`: the proposal is real but incomplete.
        status: run?.status === 'partial' ? 'partial' : 'succeeded',
        proposalId,
        stats: { ...((run?.stats ?? {}) as Record<string, unknown>), itemsFound },
      },
    });
  },

  async markFailed(runId, payload) {
    await prisma.integrationRun.update({
      where: { id: runId },
      data: {
        status: 'failed',
        errorCode: payload.code,
        errorDetail: payload as unknown as Record<string, never>,
      },
    });
  },

  async appendLog(runId, entries) {
    if (entries.length === 0) return;
    const last = await prisma.runLogEntry.findFirst({
      where: { runId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    let seq = (last?.seq ?? -1) + 1;
    await prisma.runLogEntry.createMany({
      data: entries.map((entry) => ({
        runId,
        seq: seq++,
        at: new Date(),
        level: entry.level,
        phase: entry.phase,
        message: entry.message.slice(0, 2000),
      })),
      skipDuplicates: true,
    });
  },
};

/** Runs on `IntegrationRun` rows, same as the parse queue — §10's lifecycle is per run, not per job. */
export const prismaGithubJobStore: GithubJobStore = {
  async markSucceeded(runId) {
    await prisma.integrationRun.update({ where: { id: runId }, data: { status: 'succeeded' } });
  },
  async markCanceled(runId) {
    await prisma.integrationRun.update({ where: { id: runId }, data: { status: 'cancelled' } });
  },
  async markFailed(runId, payload) {
    await prisma.integrationRun.update({
      where: { id: runId },
      data: {
        status: 'failed',
        errorCode: payload.code,
        errorDetail: payload as unknown as Record<string, never>,
      },
    });
  },
};

/** Same construction as `ai.search` in the API: no endpoint → honest keyword-only rows (U5). */
export function embedderFromEnv(env: ReturnType<typeof loadServerEnvFromProcess>): Embedder {
  return env.AI_PROVIDER === 'openai-compatible' && env.AI_BASE_URL !== undefined
    ? openAICompatibleEmbedder({
        baseUrl: env.AI_BASE_URL,
        model: env.AI_EMBED_MODEL,
        ...(env.AI_API_KEY === undefined ? {} : { apiKey: env.AI_API_KEY }),
      })
    : unavailableEmbedder();
}

/** pgvector rejects a bare float8[] parameter, so vectors travel as text literals (§6.4). */
export const prismaEmbedStore: EmbedStore = {
  async loadNode(nodeId) {
    const row = await prisma.boardProjectionNode.findUnique({
      where: { id: nodeId },
      include: { board: { select: { projectId: true } } },
    });
    if (row === null) return null;
    return {
      id: row.id,
      projectId: row.board.projectId,
      boardId: row.boardId,
      type: row.type,
      title: row.title,
      data: (row.data ?? {}) as Record<string, unknown>,
      deletedAt: row.deletedAt,
    };
  },

  async existing(nodeId, model) {
    // `embedding` is Unsupported() in the Prisma schema, so its NULL-ness travels via raw SQL.
    const rows = await prisma.$queryRaw<
      { id: string; kind: string; ord: number; content_hash: string; has_vector: boolean }[]
    >`SELECT "id", "kind", "ord", "content_hash", ("embedding" IS NOT NULL) AS "has_vector"
      FROM "ai_chunks" WHERE "node_id" = ${nodeId} AND "model" = ${model}`;
    return new Map(
      rows.map((row) => [
        `${row.kind}:${String(row.ord)}`,
        { id: row.id, hash: row.content_hash, hasVector: row.has_vector },
      ]),
    );
  },

  async upsertChunk(row) {
    const embedding =
      row.embedding === null
        ? Prisma.sql`NULL`
        : Prisma.sql`${`[${row.embedding.join(',')}]`}::vector(1536)`;
    await prisma.$executeRaw`
      INSERT INTO "ai_chunks"
        ("id", "project_id", "board_id", "node_id", "kind", "ord", "text",
         "token_count", "content_hash", "model", "embedding")
      VALUES (${crypto.randomUUID()}, ${row.projectId}, ${row.boardId}, ${row.nodeId},
              ${row.kind}, ${row.ord}, ${row.text}, ${row.tokenCount}, ${row.contentHash},
              ${row.model}, ${embedding})
      ON CONFLICT ("node_id", "kind", "ord", "model") DO UPDATE SET
        "text" = EXCLUDED."text",
        "token_count" = EXCLUDED."token_count",
        "content_hash" = EXCLUDED."content_hash",
        "embedding" = EXCLUDED."embedding"`;
  },

  async deleteChunks(ids) {
    await prisma.aiChunk.deleteMany({ where: { id: { in: [...ids] } } });
  },

  async deleteAllChunks(nodeId) {
    await prisma.aiChunk.deleteMany({ where: { nodeId } });
  },
};

/**
 * Registers the single `github` queue (§10). BullMQ has one concurrency per worker, not per job
 * name, so the highest value in the table is used and the slow jobs (`analyze`, `proposal`,
 * `sweep`) are kept in line by their own enqueue-time dedupe key rather than by a second worker.
 */
export function startGithubWorker(
  connection: IORedis,
  handlers: GithubHandlers,
  store: GithubJobStore = prismaGithubJobStore,
): Worker {
  const concurrency = Math.max(...Object.values(GITHUB_JOB_SPECS).map((spec) => spec.concurrency));
  return new Worker(
    GITHUB_QUEUE,
    async (job: Job) =>
      measureJob(GITHUB_QUEUE, job, async () => {
        const name = job.name as GithubJobName;
        const data = job.data as { runId?: string } & GithubJobPayload[GithubJobName];
        // Cancellation is a Redis-side flag; the poller turns it into the AbortSignal §10 requires.
        const controller = new AbortController();
        const poll = setInterval(() => {
          void job
            .isActive()
            .then((active) => {
              if (!active) controller.abort();
            })
            .catch(() => controller.abort());
        }, 2_000);
        try {
          const outcome = await processGithubJob(
            { handlers, store },
            name,
            data,
            data.runId ?? '',
            controller.signal,
          );
          log.info(
            { event: 'github.finished', job: name, status: outcome.status },
            'github job done',
          );
          // A failure must reach BullMQ too, or the retry policy in §10 never fires.
          if (outcome.status === 'failed') throw new Error(outcome.error?.code ?? 'GH_UNKNOWN');
        } finally {
          clearInterval(poll);
        }
      }),
    {
      connection,
      concurrency,
      settings: {
        backoffStrategy: (attemptsMade, _type, _err, job) =>
          githubBackoff((job?.name ?? 'github.sweep') as GithubJobName, attemptsMade),
      },
    },
  );
}

export function start(): Promise<() => Promise<void>> {
  const env = loadServerEnvFromProcess();
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const publisher = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const worker = new Worker(
    PARSE_QUEUE,
    async (job: Job) =>
      measureJob(PARSE_QUEUE, job, async () => {
        const runId = (job.data as { runId?: string }).runId ?? '';
        const outcome = await processParseJob(
          {
            store: prismaParseStore,
            artifacts: s3ArtifactReader(env),
            newProposalId: () => newId.proposal(),
            publish: (id, event) => {
              void publisher.publish(`run:${id}`, JSON.stringify(event));
            },
          },
          runId,
        );
        log.info(
          { event: 'parse.finished', run_id: runId, status: outcome.status },
          'parse job finished',
        );
      }),
    { connection, concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4) },
  );

  // The `github` queue (11_GITHUB.md §10). Mode A (anonymous) — no token is selected yet, so the
  // client runs on the shared unauthenticated budget and analyses come back partial (§5.9).
  const githubQueue = new Queue(GITHUB_QUEUE, { connection });
  const githubHandlers = createGithubHandlers({
    store: createGithubHandlerStore(syncNodePatcher(env)),
    createClient: (signal) => new GithubClient({ http: createGithubHttp({ signal }) }),
    enqueueHydrate: async (payload) => {
      await githubQueue.add('github.hydrate', payload, githubJobOptions('github.hydrate', payload));
    },
    enqueueProposal: async (payload) => {
      await githubQueue.add(
        'github.proposal',
        payload,
        githubJobOptions('github.proposal', payload),
      );
    },
    newId: () => newId.proposal(),
    now: () => Date.now(),
  });
  const githubWorker = startGithubWorker(connection, githubHandlers);

  // Registry watchers (Part 2 §7). Read-only: they record drift, a human merges the passport.
  const watcherQueue = new Queue(WATCHER_QUEUE, { connection });
  void registerWatcherSchedule(watcherQueue).catch((error: unknown) => {
    log.warn({ event: 'watch.schedule_failed', error: String(error) }, 'watcher schedule failed');
  });
  const watcherWorker = new Worker(
    WATCHER_QUEUE,
    async (job: Job) =>
      measureJob(WATCHER_QUEUE, job, async () => {
        const findings = await processWatcherJob(job.name as WatcherName, {
          github: githubGet,
          json: jsonFetch,
          text: textFetch,
        });
        const drift = findings.filter((finding) => finding.status === 'drift');
        log.info(
          {
            event: 'watch.finished',
            watcher: job.name,
            checked: findings.length,
            drift: drift.length,
          },
          'registry watcher finished',
        );
      }),
    { connection, concurrency: 1 },
  );

  // Chunk ingestion for retrieval (14_AI_AGENT.md §6.6): concurrency 4 per the spec.
  const embedder = embedderFromEnv(env);
  const embedWorker = new Worker(
    AI_EMBED_QUEUE,
    async (job: Job) =>
      measureJob(AI_EMBED_QUEUE, job, async () => {
        const payload = job.data as EmbedJobPayload;
        const outcome = await processEmbedJob({ store: prismaEmbedStore, embedder }, payload);
        log.info(
          { event: 'embed.finished', node_id: payload.nodeId, ...outcome },
          'embed job finished',
        );
      }),
    { connection, concurrency: 4 },
  );

  // Queue depth is polled, not derived from handlers; the metrics port binds only when the
  // deployment sets it (19_DEPLOYMENT.md §10.2).
  const stopDepth = pollQueueDepth([githubQueue, watcherQueue], 15_000, (error: unknown) => {
    log.warn({ event: 'metrics.depth_failed', error: String(error) }, 'queue depth poll failed');
  });
  const metricsPort = Number(process.env.METRICS_PORT ?? 0);
  const metrics = metricsPort > 0 ? startMetricsServer(metricsPort) : undefined;

  log.info(
    { event: 'worker.started' },
    'worker is consuming integration.parse, github, watchers and ai.embed',
  );

  return Promise.resolve(async () => {
    stopDepth();
    await (await metrics)?.close();
    await worker.close();
    await githubWorker.close();
    await githubQueue.close();
    await watcherWorker.close();
    await watcherQueue.close();
    await embedWorker.close();
    connection.disconnect();
    publisher.disconnect();
  });
}

if (process.argv[1]?.endsWith('main.ts') === true) {
  void start();
}
