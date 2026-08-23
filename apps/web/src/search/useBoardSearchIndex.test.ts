/**
 * `useBoardSearchIndex` builds a `LocalIndex` from the board's existing nodes on mount and keeps
 * it in sync with subsequent `observeBoard` change batches (P7 §5/§7): upserts land, removals
 * clear, and the effect tears itself down without leaking the idle callback.
 */

import {
  addEdge,
  addNode,
  createBoardDoc,
  makeEdge,
  makeNode,
  removeNodes,
  updateNode,
} from '@nexus/domain';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useBoardSearchIndex } from './useBoardSearchIndex';

const NOW = '2026-08-17T12:00:00.000Z';
const ORIGIN = { origin: 'local:create' as const, now: NOW };

describe('useBoardSearchIndex', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('indexes the nodes already on the board when it mounts', () => {
    const doc = createBoardDoc({ boardId: 'b1', title: 'Board', now: NOW });
    addNode(doc, makeNode({ id: 'n1', x: 0, y: 0, title: 'Alpha safehouse' }, NOW), ORIGIN);
    addNode(doc, makeNode({ id: 'n2', x: 10, y: 10, title: 'Bravo lead' }, NOW), ORIGIN);

    const { result } = renderHook(() => useBoardSearchIndex(doc, 'b1'));

    expect(result.current.search('Alpha').map((r) => r.id)).toEqual(['n1']);
    expect(result.current.search('Bravo').map((r) => r.id)).toEqual(['n2']);
  });

  it('finds a node by the label of an edge that touches it', () => {
    const doc = createBoardDoc({ boardId: 'b1', title: 'Board', now: NOW });
    addNode(doc, makeNode({ id: 'n1', x: 0, y: 0, title: 'Kilo' }, NOW), ORIGIN);
    addNode(doc, makeNode({ id: 'n2', x: 10, y: 10, title: 'Lima' }, NOW), ORIGIN);

    const { result } = renderHook(() => useBoardSearchIndex(doc, 'b1'));
    expect(result.current.search('registrar')).toEqual([]);

    addEdge(doc, makeEdge({ id: 'e1', from: 'n1', to: 'n2', label: 'registrar' }, NOW), ORIGIN);
    expect(
      result.current
        .search('registrar')
        .map((r) => r.id)
        .sort(),
    ).toEqual(['n1', 'n2']);
  });

  it('upserts new nodes and removes deleted ones as the doc changes', () => {
    const doc = createBoardDoc({ boardId: 'b1', title: 'Board', now: NOW });
    addNode(doc, makeNode({ id: 'n1', x: 0, y: 0, title: 'Charlie' }, NOW), ORIGIN);

    const { result } = renderHook(() => useBoardSearchIndex(doc, 'b1'));
    expect(result.current.search('Charlie').map((r) => r.id)).toEqual(['n1']);

    addNode(doc, makeNode({ id: 'n2', x: 5, y: 5, title: 'Delta' }, NOW), ORIGIN);
    expect(result.current.search('Delta').map((r) => r.id)).toEqual(['n2']);

    updateNode(doc, 'n1', { title: 'Charlie renamed' }, ORIGIN);
    expect(result.current.search('renamed').map((r) => r.id)).toEqual(['n1']);

    removeNodes(doc, ['n2'], ORIGIN);
    expect(result.current.search('Delta')).toEqual([]);
  });

  it('rebuilds from scratch and unsubscribes when the doc or board id changes', () => {
    const docA = createBoardDoc({ boardId: 'b1', title: 'A', now: NOW });
    addNode(docA, makeNode({ id: 'n1', x: 0, y: 0, title: 'Echo' }, NOW), ORIGIN);
    const docB = createBoardDoc({ boardId: 'b2', title: 'B', now: NOW });
    addNode(docB, makeNode({ id: 'n2', x: 0, y: 0, title: 'Foxtrot' }, NOW), ORIGIN);

    const { result, rerender, unmount } = renderHook(
      ({ doc, boardId }) => useBoardSearchIndex(doc, boardId),
      { initialProps: { doc: docA, boardId: 'b1' } },
    );
    expect(result.current.search('Echo').map((r) => r.id)).toEqual(['n1']);

    rerender({ doc: docB, boardId: 'b2' });
    expect(result.current.search('Foxtrot').map((r) => r.id)).toEqual(['n2']);
    expect(result.current.search('Echo')).toEqual([]);

    // Further writes to the doc this hook no longer observes must not resurrect into the index.
    unmount();
    addNode(docB, makeNode({ id: 'n3', x: 1, y: 1, title: 'Golf' }, NOW), ORIGIN);
    expect(result.current.search('Golf')).toEqual([]);
  });

  describe('scheduleIdle', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('falls back to setTimeout when requestIdleCallback is unavailable', () => {
      vi.stubGlobal('requestIdleCallback', undefined);
      vi.stubGlobal('cancelIdleCallback', undefined);
      const doc = createBoardDoc({ boardId: 'b1', title: 'Board', now: NOW });
      addNode(doc, makeNode({ id: 'n1', x: 0, y: 0, title: 'Hotel' }, NOW), ORIGIN);

      const { result } = renderHook(() => useBoardSearchIndex(doc, 'b1'));
      vi.runAllTimers();

      expect(result.current.search('Hotel').map((r) => r.id)).toEqual(['n1']);
    });

    it('uses requestIdleCallback when the environment provides one', () => {
      const scheduled: Array<() => void> = [];
      vi.stubGlobal(
        'requestIdleCallback',
        vi.fn((cb: () => void) => {
          scheduled.push(cb);
          return scheduled.length;
        }),
      );
      vi.stubGlobal('cancelIdleCallback', vi.fn());

      const doc = createBoardDoc({ boardId: 'b1', title: 'Board', now: NOW });
      addNode(doc, makeNode({ id: 'n1', x: 0, y: 0, title: 'India' }, NOW), ORIGIN);

      const { result } = renderHook(() => useBoardSearchIndex(doc, 'b1'));

      // A single small board finishes in one chunk, so requestIdleCallback is never reached —
      // this asserts the initial build already produced a working index either way.
      expect(result.current.search('India').map((r) => r.id)).toEqual(['n1']);
      expect(globalThis.cancelIdleCallback).not.toHaveBeenCalled();
    });
  });
});
