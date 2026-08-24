/**
 * Lazily builds the cross-board index for the palette's `@@` mode (03_UX.md §9.2).
 *
 * It is built once per activation and kept for the life of the mount: the analyst types, refines,
 * and re-runs the query many times against one index instead of re-reading IndexedDB per keystroke.
 */

import { useEffect, useRef, useState } from 'react';

import {
  buildWorkspaceIndex,
  type SearchableBoard,
  type WorkspaceIndexResult,
} from './workspaceSearch.ts';

export type WorkspaceSearchPhase = 'idle' | 'building' | 'ready' | 'failed';

export interface WorkspaceSearchState {
  readonly phase: WorkspaceSearchPhase;
  readonly result: WorkspaceIndexResult | null;
}

export interface UseWorkspaceSearchOptions {
  /** Turns the build on — the palette sets this when the query enters `@@` mode. */
  readonly active: boolean;
  readonly boards: readonly SearchableBoard[];
  readonly skipBoardId?: string | null;
  /** Test seam; production reads IndexedDB. */
  readonly build?: typeof buildWorkspaceIndex;
}

export function useWorkspaceSearchIndex(options: UseWorkspaceSearchOptions): WorkspaceSearchState {
  const { active, boards, skipBoardId = null, build = buildWorkspaceIndex } = options;
  const [state, setState] = useState<WorkspaceSearchState>({ phase: 'idle', result: null });
  // The board set is read once per build; a re-render with an equal-but-new array must not restart it.
  const startedRef = useRef(false);

  useEffect(() => {
    if (!active || startedRef.current || boards.length === 0) return undefined;
    startedRef.current = true;
    let cancelled = false;
    setState({ phase: 'building', result: null });
    void build(boards, { skipBoardId })
      .then((result) => {
        if (!cancelled) setState({ phase: 'ready', result });
      })
      .catch(() => {
        if (!cancelled) setState({ phase: 'failed', result: null });
      });
    return () => {
      cancelled = true;
    };
  }, [active, boards, skipBoardId, build]);

  return state;
}
