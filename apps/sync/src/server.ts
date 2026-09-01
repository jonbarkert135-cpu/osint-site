/**
 * `apps/sync` entrypoint (P8 §1, 00_MASTER.md §6, 09_BACKEND.md §5). Wires the pure modules
 * (`auth`, `projection`, `awareness`, `eviction`, `metrics`) into a real Hocuspocus 4 server.
 *
 * Excluded from unit-test coverage (`vitest.config.ts`) — it boots a real listener and a real
 * database connection, which is the e2e suite's job (P8 §11 `e2e/collab/*`), same convention as
 * `apps/api/src/server.ts`.
 */

import { randomUUID } from 'node:crypto';
import { Server } from '@hocuspocus/server';
import type {
  beforeHandleMessagePayload,
  onAuthenticatePayload,
  onChangePayload,
  onDisconnectPayload,
} from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import { Redis as RedisExtension } from '@hocuspocus/extension-redis';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import * as Y from 'yjs';
import { AI_EMBED_QUEUE, embedJobOptions } from '@nexus/ai';
import { createLogger } from '@nexus/config/log';
import { loadServerEnvFromProcess } from '@nexus/config/env-file';
import { prisma } from '@nexus/db';

import { AuthError, authenticateBoardToken, parseRoom } from './auth.ts';
import { RoomEvictionTracker } from './eviction.ts';
import {
  registry,
  startMetricsServer,
  syncConnections,
  syncDocMemoryBytes,
  syncProjectionFailuresTotal,
  syncRoomsOpen,
  syncUpdateBytesTotal,
} from './metrics.ts';
import { createPrismaProjectionWriter, createPrismaSnapshotStore } from './persistence.ts';
import { patchNodeData, type PatchNodeRequest } from './nodePatch.ts';
import { applyProposalToBoard, type ApplyProposalRequest } from './proposalApply.ts';
import { projectBoard } from './projection.ts';

const env = loadServerEnvFromProcess();
const logger = createLogger({
  service: 'raven-sync',
  env: env.NEXUS_ENV,
  version: process.env['NEXUS_VERSION'] ?? '0.1.0',
  level: env.LOG_LEVEL,
});

const snapshotStore = createPrismaSnapshotStore(prisma, () => randomUUID());

// Retrieval freshness (14_AI_AGENT.md §6.6 trigger 1): every projected node upsert enqueues an
// `ai.embed` job, debounced 20 s per node by its jobId. Lazy and fire-and-forget: a Redis outage
// must never fail a projection — the nightly reconciliation (§6.6.5, not built yet) is the catch-up.
let embedQueue: Queue | null = null;
function enqueueEmbed(nodeId: string): void {
  embedQueue ??= new Queue(AI_EMBED_QUEUE, {
    connection: new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null }),
  });
  embedQueue.add(AI_EMBED_QUEUE, { nodeId }, embedJobOptions(nodeId)).catch((error: unknown) => {
    logger.warn({ event: 'embed.enqueue_failed', node_id: nodeId, error: String(error) });
  });
}

const projectionWriter = createPrismaProjectionWriter(prisma, { onNodeUpserted: enqueueEmbed });

/** 10 MB per-message cap (P8 §7/§9/edge case §8) — Hocuspocus's own limit is per-frame; this one
 * additionally protects the projector from an oversized single update. */
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

interface Ctx {
  userId: string;
  role: 'viewer' | 'editor' | 'admin' | 'owner';
  readOnly: boolean;
  name: string;
  color: string;
}

const eviction = new RoomEvictionTracker({
  snapshotAndUnload(roomName) {
    const boardId = parseRoom(roomName);
    if (boardId === undefined) return Promise.resolve();
    syncRoomsOpen.dec();
    logger.info(
      { event: 'sync.room.evicted', board_id: boardId },
      'room evicted after idle timeout',
    );
    return Promise.resolve();
  },
});

const server = new Server<Ctx>({
  port: env.SYNC_PORT,
  name: `sync-${process.env['HOSTNAME'] ?? 'local'}`,
  timeout: 30_000,
  debounce: 2_000,
  maxDebounce: 10_000,
  quiet: true,

  extensions: [
    new RedisExtension({
      host: new URL(env.REDIS_URL).hostname,
      port: Number(new URL(env.REDIS_URL).port || 6379),
      identifier: `sync-${randomUUID()}`,
      prefix: 'raven:hp',
    }),
    new Database({
      // §5.1 fetch: null → a fresh, empty document (no prior snapshot).
      async fetch({ documentName }) {
        const boardId = parseRoom(documentName);
        if (boardId === undefined) return null;
        const snap = await snapshotStore.latest(boardId);
        return snap?.binary ?? null;
      },
      // §5.1/§7 store: snapshot + projection, same debounced cycle. Projection failures never
      // block the snapshot (P8 §4) — `projectBoard` already swallows its own errors.
      async store({ documentName, state, document }) {
        const boardId = parseRoom(documentName);
        if (boardId === undefined) return;

        const doc = document as unknown as Y.Doc;
        const stateVector = Y.encodeStateVector(doc);
        const prior = await snapshotStore.latest(boardId);
        await snapshotStore.write(boardId, {
          binary: state,
          stateVector,
          seq: (prior?.seq ?? 0) + 1,
        });

        const result = await projectBoard(doc, boardId, projectionWriter);
        if (!result.ok) {
          logger.warn(
            { event: 'sync.projection.failed', board_id: boardId, reason: result.reason },
            'projection failed after retries; snapshot was still committed',
          );
        }
      },
    }),
  ],

  /**
   * The two plain-HTTP routes this service exposes: headless proposal apply (§10) and the worker's
   * node `data` patch (11_GITHUB.md §3.5). Both are guarded by the same shared secret the API signs
   * board tokens with, and both go through the doc, so there is exactly one write path (N4).
   */
  async onRequest({ request, response }) {
    const url = request.url ?? '';
    const isApply = url.startsWith('/internal/proposals/apply');
    const isPatch = url.startsWith('/internal/nodes/patch');
    if (request.method !== 'POST' || (!isApply && !isPatch)) {
      return;
    }
    if (request.headers.authorization !== `Bearer ${env.SYNC_SHARED_SECRET}`) {
      response.writeHead(401).end('unauthorized');
      throw new Error('handled');
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    try {
      const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result = isApply
        ? (await applyProposalToBoard(snapshotStore, raw as ApplyProposalRequest)).result
        : await patchNodeData(snapshotStore, raw as PatchNodeRequest);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      logger.warn({ event: 'sync.internal.failed', url, err: error }, 'internal write failed');
      response
        .writeHead(422, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: error instanceof Error ? error.message : 'apply failed' }));
    }
    // Hocuspocus treats a thrown error as "the response was handled here".
    throw new Error('handled');
  },

  onConnect() {
    syncConnections.inc({ board_scope: 'default' });
    return Promise.resolve();
  },

  onAuthenticate({ token, documentName, connectionConfig }: onAuthenticatePayload<Ctx>) {
    try {
      const ctx = authenticateBoardToken({ token, documentName }, env.SYNC_SHARED_SECRET);
      connectionConfig.readOnly = ctx.readOnly;
      eviction.onConnect(documentName);
      syncRoomsOpen.set(eviction.openRoomCount());
      const context: Ctx = {
        userId: ctx.userId,
        role: ctx.role,
        readOnly: ctx.readOnly,
        name: ctx.name,
        color: ctx.color,
      };
      return Promise.resolve(context);
    } catch (error) {
      if (error instanceof AuthError) {
        logger.warn(
          { event: 'sync.auth.denied', code: error.code, reason: error.message },
          error.message,
        );
      }
      throw error;
    }
  },

  // §5.4 write authorization: a viewer's updates are rejected server-side even from a tampered
  // client — the client's own read-only UI is a courtesy, this is the authority (P8 §2).
  beforeHandleMessage({ context, update }: beforeHandleMessagePayload<Ctx>) {
    if (context.readOnly) {
      throw new Error('This connection is read-only; the update was rejected.');
    }
    if (update.byteLength > MAX_MESSAGE_BYTES) {
      throw new Error(`Update of ${String(update.byteLength)} bytes exceeds the 10 MB cap.`);
    }
    syncUpdateBytesTotal.inc({ direction: 'in' }, update.byteLength);
    return Promise.resolve();
  },

  onChange({ update }: onChangePayload<Ctx>) {
    syncUpdateBytesTotal.inc({ direction: 'out' }, update.byteLength);
    return Promise.resolve();
  },

  onDisconnect({ documentName }: onDisconnectPayload<Ctx>) {
    syncConnections.dec({ board_scope: 'default' });
    eviction.onDisconnect(documentName);
    syncRoomsOpen.set(eviction.openRoomCount());
    return Promise.resolve();
  },
});

async function main(): Promise<void> {
  const metricsApp = await startMetricsServer();
  await server.listen();
  logger.info({ event: 'sync.listening', port: env.SYNC_PORT }, 'sync service listening');

  const shutdown = (signal: string): void => {
    void (async () => {
      logger.info({ event: 'sync.shutdown', signal }, 'graceful shutdown: flushing rooms');
      // §7 graceful shutdown: stop accepting connections, flush every room, close with 1001 so
      // clients reconnect elsewhere within 5 s. Hocuspocus's own `destroy()` flushes debounced
      // stores before closing sockets.
      await server.destroy();
      await eviction.flushAll([]);
      await embedQueue?.close();
      await metricsApp.close();
      await prisma.$disconnect();
      process.exit(0);
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Exported for the memory-gauge sampler and tests that want the registry without booting a server.
export { registry, syncDocMemoryBytes, syncProjectionFailuresTotal };

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
