/**
 * Cross-board (workspace-wide) search — the `@@` mode of the palette (03_UX.md §9.2).
 *
 * The open board already has a live incremental index (`useBoardSearchIndex`). Every *other* board
 * lives only in IndexedDB (`raven-board-<id>`, N2 local-first), so this module opens those documents
 * on demand, indexes their nodes into one `LocalIndex`, and closes them again. Nothing here touches
 * the network: workspace search works offline exactly like the rest of the app.
 *
 * The build is explicitly lazy and one-shot: it runs when the analyst asks for cross-board results,
 * not on app start, because opening N documents costs IndexedDB reads proportional to the workspace.
 */

import { builtinNodeTypes, createLocalIndex, listEdges, listNodes } from '@nexus/domain';
import type { IndexedDoc, LocalIndex } from '@nexus/domain';
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';

import { boardStoreName } from '../data/persistence.ts';

/** Just enough of a board row to index and label its results. */
export interface SearchableBoard {
  readonly id: string;
  readonly title: string;
}

/** Opens a board document; returns `null` when that board has no local content yet. */
export type BoardDocLoader = (boardId: string) => Promise<Y.Doc | null>;

/** Docs produced for one board — exported so the mapping can be tested without IndexedDB. */
export function indexDocsForBoard(doc: Y.Doc, boardId: string): IndexedDoc[] {
  const registry = builtinNodeTypes();
  const edges = listEdges(doc);
  return listNodes(doc).map((node) => {
    const fields = registry.get(node.type).searchFields(node);
    const edgeTerms = edges
      .filter((edge) => edge.source.nodeId === node.id || edge.target.nodeId === node.id)
      .flatMap((edge) => [edge.type, edge.label ?? ''])
      .filter((term) => term !== '');
    return {
      id: `${boardId}:${node.id}`,
      boardId,
      title: fields.title,
      body: fields.body,
      keywords: [...fields.keywords, ...edgeTerms],
    };
  });
}

/** `boardId:nodeId` back into its parts — results carry the composite id so ids stay unique. */
export function splitResultId(id: string): { boardId: string; nodeId: string } {
  const separator = id.indexOf(':');
  if (separator === -1) return { boardId: '', nodeId: id };
  return { boardId: id.slice(0, separator), nodeId: id.slice(separator + 1) };
}

function synced(provider: IndexeddbPersistence): Promise<void> {
  return new Promise((resolve) => {
    if (provider.synced) {
      resolve();
      return;
    }
    provider.once('synced', () => resolve());
  });
}

/**
 * Reads one board document out of IndexedDB and detaches the provider again, so a search never
 * leaves N live persistence handles behind (each one keeps its own IndexedDB connection open).
 */
export const loadBoardDocFromIndexedDb: BoardDocLoader = async (boardId) => {
  if (typeof indexedDB === 'undefined') return null;
  const doc = new Y.Doc();
  const provider = new IndexeddbPersistence(boardStoreName(boardId), doc);
  try {
    await synced(provider);
    // A detached copy: destroying the provider must not tear down what we just indexed.
    const snapshot = new Y.Doc();
    Y.applyUpdate(snapshot, Y.encodeStateAsUpdate(doc), 'system:search');
    return snapshot;
  } finally {
    await provider.destroy();
  }
};

export interface WorkspaceIndexOptions {
  /**
   * The board that is already open. Its live index answers for it, so re-reading it from
   * IndexedDB would both cost a read and return a stale copy of unsaved-but-in-memory edits.
   */
  readonly skipBoardId?: string | null;
  readonly load?: BoardDocLoader;
}

export interface WorkspaceIndexResult {
  readonly index: LocalIndex;
  /** Boards whose document could not be read; the UI says so rather than silently under-reporting. */
  readonly failed: readonly string[];
  readonly boardTitles: ReadonlyMap<string, string>;
}

export async function buildWorkspaceIndex(
  boards: readonly SearchableBoard[],
  options: WorkspaceIndexOptions = {},
): Promise<WorkspaceIndexResult> {
  const load = options.load ?? loadBoardDocFromIndexedDb;
  const index = createLocalIndex();
  const failed: string[] = [];
  const boardTitles = new Map<string, string>();

  for (const board of boards) {
    boardTitles.set(board.id, board.title);
    if (board.id === options.skipBoardId) continue;
    try {
      const doc = await load(board.id);
      if (doc === null) continue;
      for (const entry of indexDocsForBoard(doc, board.id)) index.upsert(entry);
    } catch {
      // One unreadable board must not fail the whole search (P7: degrade, never dead-end).
      failed.push(board.id);
    }
  }

  return { index, failed, boardTitles };
}
