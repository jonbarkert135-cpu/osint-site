/**
 * Workspace-wide search (03_UX.md §9.2 `@@`): every board's nodes end up in one index, results
 * carry the board they came from, the open board is skipped (its live index answers for it), and an
 * unreadable board degrades to a reported failure instead of an empty search.
 */

import { addNode, createBoardDoc, makeNode } from '@nexus/domain';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { IndexeddbPersistence } from 'y-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Y from 'yjs';

import { boardStoreName } from '../data/persistence.ts';
import {
  buildWorkspaceIndex,
  indexDocsForBoard,
  loadBoardDocFromIndexedDb,
  splitResultId,
} from './workspaceSearch';

const NOW = '2026-08-24T12:00:00.000Z';
const ORIGIN = { origin: 'local:create' as const, now: NOW };

function boardWith(boardId: string, titles: readonly string[]): Y.Doc {
  const doc = createBoardDoc({ boardId, title: boardId, now: NOW });
  titles.forEach((title, i) => {
    addNode(doc, makeNode({ id: `${boardId}-n${i}`, x: i * 10, y: 0, title }, NOW), ORIGIN);
  });
  return doc;
}

describe('indexDocsForBoard', () => {
  it('namespaces node ids by board so two boards never collide', () => {
    const docs = indexDocsForBoard(boardWith('b1', ['Alpha']), 'b1');
    expect(docs).toHaveLength(1);
    expect(docs[0]?.id).toBe('b1:b1-n0');
    expect(splitResultId(docs[0]?.id ?? '')).toEqual({ boardId: 'b1', nodeId: 'b1-n0' });
  });
});

describe('buildWorkspaceIndex', () => {
  const boards = [
    { id: 'b1', title: 'Infra' },
    { id: 'b2', title: 'People' },
  ];

  it('indexes every board and labels results with their board', async () => {
    const docs: Record<string, Y.Doc> = {
      b1: boardWith('b1', ['Alpha safehouse']),
      b2: boardWith('b2', ['Alpha contact']),
    };
    const { index, boardTitles, failed } = await buildWorkspaceIndex(boards, {
      load: (id) => Promise.resolve(docs[id] ?? null),
    });

    const hits = index.search('Alpha');
    expect(hits.map((hit) => hit.boardId).sort()).toEqual(['b1', 'b2']);
    expect(boardTitles.get('b2')).toBe('People');
    expect(failed).toEqual([]);
  });

  it('skips the open board — its live index already answers for it', async () => {
    const load = vi.fn((id: string) => Promise.resolve(boardWith(id, ['Alpha'])));
    const { index } = await buildWorkspaceIndex(boards, { skipBoardId: 'b1', load });

    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('b2');
    expect(index.search('Alpha').map((hit) => hit.boardId)).toEqual(['b2']);
  });

  it('reports an unreadable board instead of failing the whole search', async () => {
    const { index, failed } = await buildWorkspaceIndex(boards, {
      load: (id) =>
        id === 'b1'
          ? Promise.reject(new Error('idb blocked'))
          : Promise.resolve(boardWith(id, ['Alpha'])),
    });

    expect(failed).toEqual(['b1']);
    expect(index.search('Alpha').map((hit) => hit.boardId)).toEqual(['b2']);
  });

  it('treats a board with no local content as empty, not as a failure', async () => {
    const { index, failed } = await buildWorkspaceIndex(boards, {
      load: () => Promise.resolve(null),
    });
    expect(failed).toEqual([]);
    expect(index.size).toBe(0);
  });
});

describe('loadBoardDocFromIndexedDb', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    globalThis.IDBKeyRange = IDBKeyRange;
  });

  it('reads a board persisted in IndexedDB and detaches the provider', async () => {
    const doc = boardWith('b_idb', ['Persisted node']);
    const provider = new IndexeddbPersistence(boardStoreName('b_idb'), doc);
    await provider.whenSynced;
    await provider.destroy();

    const loaded = await loadBoardDocFromIndexedDb('b_idb');
    expect(loaded).not.toBeNull();
    expect(indexDocsForBoard(loaded as Y.Doc, 'b_idb').map((d) => d.title)).toEqual([
      'Persisted node',
    ]);
  });

  it('returns an empty document for a board that was never opened locally', async () => {
    const loaded = await loadBoardDocFromIndexedDb('b_missing');
    expect(indexDocsForBoard(loaded as Y.Doc, 'b_missing')).toEqual([]);
  });

  it('returns null when the environment has no IndexedDB', async () => {
    const original = globalThis.indexedDB;
    // @ts-expect-error — deliberately simulating a non-browser environment.
    delete globalThis.indexedDB;
    try {
      expect(await loadBoardDocFromIndexedDb('b_any')).toBeNull();
    } finally {
      globalThis.indexedDB = original;
    }
  });

  it('indexes a real workspace end to end through IndexedDB', async () => {
    const doc = boardWith('b_e2e', ['Canvas note']);
    const provider = new IndexeddbPersistence(boardStoreName('b_e2e'), doc);
    await provider.whenSynced;
    await provider.destroy();

    const { index, failed } = await buildWorkspaceIndex([{ id: 'b_e2e', title: 'E2E' }]);
    expect(failed).toEqual([]);
    expect(index.search('Canvas').map((hit) => hit.id)).toEqual(['b_e2e:b_e2e-n0']);
  });
});
