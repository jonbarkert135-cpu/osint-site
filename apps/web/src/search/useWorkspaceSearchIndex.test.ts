/**
 * The cross-board index is built lazily and exactly once (03_UX.md §9.1: the palette never pays for
 * a workspace-wide read until the analyst asks for one).
 */

import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useWorkspaceSearchIndex } from './useWorkspaceSearchIndex';
import { createLocalIndex } from '@nexus/domain';

import type { SearchableBoard, WorkspaceIndexResult } from './workspaceSearch';

const boards: SearchableBoard[] = [{ id: 'b1', title: 'Infra' }];

const emptyResult = (): WorkspaceIndexResult => ({
  index: createLocalIndex(),
  failed: [],
  boardTitles: new Map(),
});

const fakeBuild = () => vi.fn(() => Promise.resolve(emptyResult()));

describe('useWorkspaceSearchIndex', () => {
  it('stays idle until it is activated', () => {
    const build = fakeBuild();
    const { result } = renderHook(() => useWorkspaceSearchIndex({ active: false, boards, build }));
    expect(result.current.phase).toBe('idle');
    expect(build.mock.calls).toHaveLength(0);
  });

  it('builds once and stays ready across re-renders', async () => {
    const build = fakeBuild();
    const { result, rerender } = renderHook(() =>
      useWorkspaceSearchIndex({ active: true, boards, build }),
    );
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    rerender();
    rerender();
    expect(build.mock.calls).toHaveLength(1);
  });

  it('reports failure instead of hanging on "building"', async () => {
    const build = vi.fn(() => Promise.reject(new Error('no idb')));
    const { result } = renderHook(() => useWorkspaceSearchIndex({ active: true, boards, build }));
    await waitFor(() => expect(result.current.phase).toBe('failed'));
  });
});
