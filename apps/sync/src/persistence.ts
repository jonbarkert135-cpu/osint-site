/**
 * Prisma-backed persistence for Hocuspocus's `onLoadDocument`/`onStoreDocument` (P8 §1/§7,
 * 08_DATA_MODEL.md §5.1). The snapshot write and the projection upserts happen in one
 * transaction; a projection failure never rolls back the snapshot (P8 §4) — `projectBoard`
 * already swallows its own errors, so the only thing this module must guarantee is that the
 * snapshot insert always runs.
 */

import type { PriorProjectionState, ProjectionDiff } from '@nexus/domain';
import type { Prisma, PrismaClient } from '@nexus/db';

import type { ProjectionWriter } from './projection.ts';

/** Snapshot retention (P8 §7): the last 10 plus one per day for 30 days. */
export const SNAPSHOT_KEEP_LAST = 10;
export const SNAPSHOT_DAILY_RETENTION_DAYS = 30;

export interface SnapshotRecord {
  binary: Uint8Array;
  stateVector: Uint8Array;
  seq: number;
}

export interface SnapshotStore {
  /** `null` when the board has never been stored — a fresh doc (§5.1 `fetch`). */
  latest(boardId: string): Promise<SnapshotRecord | null>;
  write(boardId: string, record: SnapshotRecord): Promise<void>;
}

export function createPrismaSnapshotStore(
  prisma: PrismaClient,
  newId: () => string,
): SnapshotStore {
  return {
    async latest(boardId) {
      const row = await prisma.boardSnapshot.findFirst({
        where: { boardId },
        orderBy: { seq: 'desc' },
      });
      if (!row) return null;
      return { binary: row.binary, stateVector: row.stateVector, seq: row.seq };
    },
    async write(boardId, record) {
      await prisma.boardSnapshot.create({
        data: {
          id: newId(),
          boardId,
          seq: record.seq,
          binary: Buffer.from(record.binary),
          stateVector: Buffer.from(record.stateVector),
          kind: 'current',
        },
      });
    },
  };
}

export interface ProjectionHooks {
  /**
   * Fired after a diff commits, once per upserted node (14_AI_AGENT.md §6.6 trigger 1). The hook
   * enqueues `ai.embed`; whether the text actually changed is the worker's `content_hash` check —
   * the writer does not keep prior text. Errors must not fail the projection.
   */
  onNodeUpserted?(nodeId: string): void;
}

export function createPrismaProjectionWriter(
  prisma: PrismaClient,
  hooks: ProjectionHooks = {},
): ProjectionWriter {
  return {
    async loadPriorState(boardId): Promise<PriorProjectionState> {
      const [nodes, edges] = await Promise.all([
        prisma.boardProjectionNode.findMany({
          where: { boardId },
          select: { id: true, version: true, updatedAt: true },
        }),
        prisma.boardProjectionEdge.findMany({
          where: { boardId },
          select: { id: true, version: true, updatedAt: true },
        }),
      ]);
      return {
        nodes: new Map(
          nodes.map((n): [string, { id: string; version: number; updatedAt: string }] => [
            n.id,
            { id: n.id, version: n.version, updatedAt: n.updatedAt.toISOString() },
          ]),
        ),
        edges: new Map(
          edges.map((e): [string, { id: string; version: number; updatedAt: string }] => [
            e.id,
            { id: e.id, version: e.version, updatedAt: e.updatedAt.toISOString() },
          ]),
        ),
      };
    },

    async applyDiff(boardId, diff: ProjectionDiff): Promise<void> {
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        for (const node of diff.upsertNodes) {
          await tx.boardProjectionNode.upsert({
            where: { id: node.id },
            create: {
              id: node.id,
              boardId,
              type: node.type,
              title: node.title,
              x: node.x,
              y: node.y,
              tags: node.tags,
              status: node.status,
              data: node.data as Prisma.InputJsonValue,
              version: node.version,
              docUpdatedAt: new Date(node.updatedAt),
              deletedAt: node.deletedAt ? new Date(node.deletedAt) : null,
            },
            update: {
              type: node.type,
              title: node.title,
              x: node.x,
              y: node.y,
              tags: node.tags,
              status: node.status,
              data: node.data as Prisma.InputJsonValue,
              version: node.version,
              docUpdatedAt: new Date(node.updatedAt),
              deletedAt: node.deletedAt ? new Date(node.deletedAt) : null,
            },
          });
        }
        for (const id of diff.deleteNodeIds) {
          await tx.boardProjectionNode.deleteMany({ where: { id, boardId } });
          // Node delete cascades to its retrieval chunks in the same transaction (14 §6.6).
          await tx.aiChunk.deleteMany({ where: { nodeId: id } });
        }
        for (const edge of diff.upsertEdges) {
          await tx.boardProjectionEdge.upsert({
            where: { id: edge.id },
            create: {
              id: edge.id,
              boardId,
              type: edge.type,
              sourceNodeId: edge.source.nodeId,
              targetNodeId: edge.target.nodeId,
              status: edge.status,
              data: edge.data as Prisma.InputJsonValue,
              version: edge.version,
              docUpdatedAt: new Date(edge.updatedAt),
              deletedAt: edge.deletedAt ? new Date(edge.deletedAt) : null,
            },
            update: {
              type: edge.type,
              sourceNodeId: edge.source.nodeId,
              targetNodeId: edge.target.nodeId,
              status: edge.status,
              data: edge.data as Prisma.InputJsonValue,
              version: edge.version,
              docUpdatedAt: new Date(edge.updatedAt),
              deletedAt: edge.deletedAt ? new Date(edge.deletedAt) : null,
            },
          });
        }
        for (const id of diff.deleteEdgeIds) {
          await tx.boardProjectionEdge.deleteMany({ where: { id, boardId } });
        }
      });
      for (const node of diff.upsertNodes) hooks.onNodeUpserted?.(node.id);
    },

    async markProjected(boardId, at) {
      await prisma.board.update({
        where: { id: boardId },
        data: { lastProjectedAt: at, projectionFailed: false },
      });
    },

    async markProjectionFailed(boardId) {
      await prisma.board.update({ where: { id: boardId }, data: { projectionFailed: true } });
    },
  };
}
