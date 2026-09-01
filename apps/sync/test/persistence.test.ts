/**
 * `createPrismaSnapshotStore` / `createPrismaProjectionWriter` against a fake Prisma client —
 * verifies the row shapes and ordering guard translate correctly without a real database.
 */

import { describe, expect, it, vi } from 'vitest';

import { createPrismaProjectionWriter, createPrismaSnapshotStore } from '../src/persistence.ts';

function fakePrisma() {
  const boardSnapshot = {
    findFirst: vi.fn(),
    create: vi.fn(),
  };
  const boardProjectionNode = {
    findMany: vi.fn().mockResolvedValue([]),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  };
  const boardProjectionEdge = {
    findMany: vi.fn().mockResolvedValue([]),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  };
  const board = { update: vi.fn() };
  const aiChunk = { deleteMany: vi.fn() };
  interface Tx {
    boardProjectionNode: typeof boardProjectionNode;
    boardProjectionEdge: typeof boardProjectionEdge;
    aiChunk: typeof aiChunk;
  }
  const tx: Tx = { boardProjectionNode, boardProjectionEdge, aiChunk };
  const $transaction = vi.fn(async (fn: (tx: Tx) => Promise<void>) => fn(tx));

  return {
    boardSnapshot,
    boardProjectionNode,
    boardProjectionEdge,
    board,
    aiChunk,
    $transaction,
  } as never;
}

describe('createPrismaSnapshotStore', () => {
  it('returns null when the board has never been stored', async () => {
    const prisma = fakePrisma();
    (
      prisma as { boardSnapshot: { findFirst: ReturnType<typeof vi.fn> } }
    ).boardSnapshot.findFirst.mockResolvedValue(null);
    const store = createPrismaSnapshotStore(prisma, () => 'snap1');
    expect(await store.latest('b1')).toBeNull();
  });

  it('writes a snapshot with the given seq', async () => {
    const prisma = fakePrisma();
    const store = createPrismaSnapshotStore(prisma, () => 'snap1');
    await store.write('b1', {
      binary: new Uint8Array([1, 2]),
      stateVector: new Uint8Array([3]),
      seq: 4,
    });
    const create = (prisma as { boardSnapshot: { create: ReturnType<typeof vi.fn> } }).boardSnapshot
      .create;
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ id: 'snap1', boardId: 'b1', seq: 4, kind: 'current' }),
    });
  });

  it('reads the latest snapshot back out', async () => {
    const prisma = fakePrisma();
    (
      prisma as { boardSnapshot: { findFirst: ReturnType<typeof vi.fn> } }
    ).boardSnapshot.findFirst.mockResolvedValue({
      binary: Buffer.from([9]),
      stateVector: Buffer.from([8]),
      seq: 2,
    });
    const store = createPrismaSnapshotStore(prisma, () => 'x');
    const latest = await store.latest('b1');
    expect(latest).toEqual({ binary: Buffer.from([9]), stateVector: Buffer.from([8]), seq: 2 });
  });
});

describe('createPrismaProjectionWriter', () => {
  it('loads prior state from projected rows, keyed by id', async () => {
    const prisma = fakePrisma();
    (
      prisma as { boardProjectionNode: { findMany: ReturnType<typeof vi.fn> } }
    ).boardProjectionNode.findMany.mockResolvedValue([
      { id: 'n1', version: 2, updatedAt: new Date('2026-01-01T00:00:00.000Z') },
    ]);
    const writer = createPrismaProjectionWriter(prisma);
    const state = await writer.loadPriorState('b1');
    expect(state.nodes.get('n1')).toEqual({
      id: 'n1',
      version: 2,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('loads prior edge state from projected rows, keyed by id', async () => {
    const prisma = fakePrisma();
    (
      prisma as { boardProjectionEdge: { findMany: ReturnType<typeof vi.fn> } }
    ).boardProjectionEdge.findMany.mockResolvedValue([
      { id: 'e1', version: 3, updatedAt: new Date('2026-02-01T00:00:00.000Z') },
    ]);
    const writer = createPrismaProjectionWriter(prisma);
    const state = await writer.loadPriorState('b1');
    expect(state.edges.get('e1')).toEqual({
      id: 'e1',
      version: 3,
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
  });

  it('applyDiff upserts and deletes inside one transaction', async () => {
    const prisma = fakePrisma();
    const writer = createPrismaProjectionWriter(prisma);
    await writer.applyDiff('b1', {
      upsertNodes: [
        {
          id: 'n1',
          type: 'note',
          title: 'Hello',
          x: 0,
          y: 0,
          w: 10,
          h: 10,
          z: 0,
          rotation: 0,
          parentId: null,
          locked: false,
          hidden: false,
          tags: [],
          confidence: 'unknown',
          color: null,
          starred: false,
          status: 'active',
          provenance: { kind: 'user' },
          enrichment: { state: 'idle', jobId: null, attempts: 0, lastError: null, updatedAt: null },
          version: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          deletedAt: null,
          data: {},
        } as never,
      ],
      deleteNodeIds: ['gone'],
      upsertEdges: [],
      deleteEdgeIds: [],
    });

    expect(
      (prisma as { $transaction: ReturnType<typeof vi.fn> }).$transaction,
    ).toHaveBeenCalledTimes(1);
    // A deleted node takes its retrieval chunks with it in the same transaction (14 §6.6).
    expect(
      (prisma as { aiChunk: { deleteMany: ReturnType<typeof vi.fn> } }).aiChunk.deleteMany,
    ).toHaveBeenCalledWith({ where: { nodeId: 'gone' } });
  });

  it('fires onNodeUpserted once per upserted node, after the transaction', async () => {
    const prisma = fakePrisma();
    const seen: string[] = [];
    const writer = createPrismaProjectionWriter(prisma, {
      onNodeUpserted: (nodeId) => seen.push(nodeId),
    });
    await writer.applyDiff('b1', {
      upsertNodes: [{ id: 'n1' } as never, { id: 'n2' } as never],
      deleteNodeIds: [],
      upsertEdges: [],
      deleteEdgeIds: [],
    });
    expect(seen).toEqual(['n1', 'n2']);
  });

  it('applyDiff upserts and deletes edges inside the same transaction', async () => {
    const prisma = fakePrisma();
    const writer = createPrismaProjectionWriter(prisma);
    await writer.applyDiff('b1', {
      upsertNodes: [],
      deleteNodeIds: [],
      upsertEdges: [
        {
          id: 'e1',
          type: 'link',
          source: { nodeId: 'n1' },
          target: { nodeId: 'n2' },
          version: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          deletedAt: null,
          status: 'active',
          data: {},
        } as never,
      ],
      deleteEdgeIds: ['gone-edge'],
    });

    const edge = (prisma as { boardProjectionEdge: { upsert: ReturnType<typeof vi.fn> } })
      .boardProjectionEdge;
    expect(edge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'e1' },
        create: expect.objectContaining({
          id: 'e1',
          boardId: 'b1',
          sourceNodeId: 'n1',
          targetNodeId: 'n2',
        }),
        update: expect.objectContaining({ sourceNodeId: 'n1', targetNodeId: 'n2' }),
      }),
    );
    const deleteMany = (prisma as { boardProjectionEdge: { deleteMany: ReturnType<typeof vi.fn> } })
      .boardProjectionEdge.deleteMany;
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: 'gone-edge', boardId: 'b1' } });
  });

  it('sets deletedAt on upserted rows when the node/edge is soft-deleted', async () => {
    const prisma = fakePrisma();
    const writer = createPrismaProjectionWriter(prisma);
    await writer.applyDiff('b1', {
      upsertNodes: [
        {
          id: 'n1',
          type: 'note',
          title: 'Hello',
          x: 0,
          y: 0,
          w: 10,
          h: 10,
          z: 0,
          rotation: 0,
          parentId: null,
          locked: false,
          hidden: false,
          tags: [],
          confidence: 'unknown',
          color: null,
          starred: false,
          status: 'active',
          provenance: { kind: 'user' },
          enrichment: { state: 'idle', jobId: null, attempts: 0, lastError: null, updatedAt: null },
          version: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          deletedAt: '2026-01-02T00:00:00.000Z',
          data: {},
        } as never,
      ],
      deleteNodeIds: [],
      upsertEdges: [
        {
          id: 'e1',
          type: 'link',
          source: { nodeId: 'n1' },
          target: { nodeId: 'n2' },
          version: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          deletedAt: '2026-01-03T00:00:00.000Z',
          status: 'active',
          data: {},
        } as never,
      ],
      deleteEdgeIds: [],
    });

    const nodeUpsert = (prisma as { boardProjectionNode: { upsert: ReturnType<typeof vi.fn> } })
      .boardProjectionNode.upsert;
    const nodeArg = nodeUpsert.mock.calls[0]?.[0] as {
      create: { deletedAt: Date };
      update: { deletedAt: Date };
    };
    expect(nodeArg.create.deletedAt).toEqual(new Date('2026-01-02T00:00:00.000Z'));
    expect(nodeArg.update.deletedAt).toEqual(new Date('2026-01-02T00:00:00.000Z'));

    const edgeUpsert = (prisma as { boardProjectionEdge: { upsert: ReturnType<typeof vi.fn> } })
      .boardProjectionEdge.upsert;
    const edgeArg = edgeUpsert.mock.calls[0]?.[0] as {
      create: { deletedAt: Date };
      update: { deletedAt: Date };
    };
    expect(edgeArg.create.deletedAt).toEqual(new Date('2026-01-03T00:00:00.000Z'));
    expect(edgeArg.update.deletedAt).toEqual(new Date('2026-01-03T00:00:00.000Z'));
  });

  it('marks a board projected / projection-failed', async () => {
    const prisma = fakePrisma();
    const writer = createPrismaProjectionWriter(prisma);
    const at = new Date('2026-01-02T00:00:00.000Z');
    await writer.markProjected('b1', at);
    await writer.markProjectionFailed('b1');
    const update = (prisma as { board: { update: ReturnType<typeof vi.fn> } }).board.update;
    expect(update).toHaveBeenNthCalledWith(1, {
      where: { id: 'b1' },
      data: { lastProjectedAt: at, projectionFailed: false },
    });
    expect(update).toHaveBeenNthCalledWith(2, {
      where: { id: 'b1' },
      data: { projectionFailed: true },
    });
  });
});
