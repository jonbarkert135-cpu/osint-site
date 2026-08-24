/**
 * The status bar is part of the shell, but the numbers it shows belong to the board. This is the
 * one-way channel between them: the board publishes what it knows, the status bar reads it, and
 * nothing renders a hard-coded "0 nodes" placeholder (04_DESIGN_SYSTEM.md P5 — every state is
 * designed, including the empty one).
 */

import type { LocalIndex } from '@nexus/domain';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

export interface BoardStatus {
  /** `null` while no board is open — the status bar then says so instead of showing zeros. */
  readonly counts: { readonly nodes: number; readonly edges: number } | null;
  /** Short, user-facing persistence state, e.g. "Saved locally". */
  readonly persistence: string;
  /** The open board's id, or `null` — lets the palette/search know what "this board" means. */
  readonly boardId: string | null;
  /** The open board's live search index (P7 §5), or `null` while none is open. */
  readonly searchIndex: LocalIndex | null;
  /** Every tag in use on the open board, for the palette's `#` mode (P7 §9). */
  readonly tags: readonly string[];
  /**
   * Animates the camera to a node and gives it a brief highlight pulse (P7 §7: "1.2 s highlight
   * pulse"). `null` while no board is open.
   */
  readonly focusNode: ((nodeId: string) => void) | null;
  /** The tag the canvas is currently filtered by (palette `#` mode, 03_UX.md §9.2), or `null`. */
  readonly tagFilter: string | null;
  /** Sets (or clears, with `null`) that filter. `null` while no board is open. */
  readonly setTagFilter: ((tag: string | null) => void) | null;
}

export interface BoardStatusApi extends BoardStatus {
  readonly publish: (next: Partial<BoardStatus>) => void;
}

const EMPTY: BoardStatus = {
  counts: null,
  persistence: 'Saved locally',
  boardId: null,
  searchIndex: null,
  tags: [],
  focusNode: null,
  tagFilter: null,
  setTagFilter: null,
};

const Context = createContext<BoardStatusApi>({ ...EMPTY, publish: () => undefined });

export function BoardStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<BoardStatus>(EMPTY);
  const api = useMemo<BoardStatusApi>(
    () => ({
      ...status,
      publish: (next: Partial<BoardStatus>) => {
        setStatus((current) => {
          const merged = { ...current, ...next };
          const sameCounts =
            merged.counts === current.counts ||
            (merged.counts !== null &&
              current.counts !== null &&
              merged.counts.nodes === current.counts.nodes &&
              merged.counts.edges === current.counts.edges);
          const unchanged =
            sameCounts &&
            merged.persistence === current.persistence &&
            merged.boardId === current.boardId &&
            merged.searchIndex === current.searchIndex &&
            merged.tags === current.tags &&
            merged.focusNode === current.focusNode &&
            merged.tagFilter === current.tagFilter &&
            merged.setTagFilter === current.setTagFilter;
          if (unchanged) return current;
          return merged;
        });
      },
    }),
    [status],
  );
  return <Context.Provider value={api}>{children}</Context.Provider>;
}

export function useBoardStatus(): BoardStatusApi {
  return useContext(Context);
}
