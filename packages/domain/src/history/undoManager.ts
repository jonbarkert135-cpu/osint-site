/**
 * Undo/redo (P3 §5.4–5.5, 08_DATA_MODEL.md §2.5).
 *
 * `Y.UndoManager` already scopes by origin; this wrapper adds the two things the product needs:
 * a bounded stack (200 items, so a long session cannot grow without limit) and a label per step,
 * so the UI can say "Undo: move 12 nodes" instead of "Undo".
 */

import * as Y from 'yjs';

import { undoScope } from '../doc/schema.ts';
import { TRACKED_ORIGINS } from './origins.ts';

/** 08 §2.5 caps the stack at 200 items. */
export const UNDO_STACK_LIMIT = 200;
/** 08 §2.5: interim drag commits merge into one undo step. */
export const UNDO_CAPTURE_TIMEOUT_MS = 500;

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  /** Human label of the step that ⌘Z would revert, e.g. `move 12 nodes`; null when empty. */
  undoLabel: string | null;
  redoLabel: string | null;
  undoDepth: number;
  redoDepth: number;
}

export interface BoardHistory {
  readonly manager: Y.UndoManager;
  readonly state: HistoryState;
  undo(): boolean;
  redo(): boolean;
  /** Names the next captured step; the manager merges follow-ups within the capture timeout. */
  label(text: string): void;
  /**
   * Closes the current capture window: the next transaction starts a fresh undo step even when it
   * lands within the capture timeout. Discrete commands call this so two quick clicks are two
   * undo steps, while a drag keeps merging its interim commits (08 §2.5).
   */
  separate(): void;
  subscribe(listener: (state: HistoryState) => void): () => void;
  destroy(): void;
}

interface StackItemMeta {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

const LABEL_KEY = 'raven:label';

const emptyState = (): HistoryState => ({
  canUndo: false,
  canRedo: false,
  undoLabel: null,
  redoLabel: null,
  undoDepth: 0,
  redoDepth: 0,
});

function labelOf(item: { meta: StackItemMeta } | undefined): string | null {
  const value = item?.meta.get(LABEL_KEY);
  return typeof value === 'string' ? value : null;
}

export interface CreateHistoryOptions {
  captureTimeout?: number;
  stackLimit?: number;
  /**
   * Origins produced by an embedded editor rather than by our own `tx()` calls. The rich-text
   * binding (y-prosemirror) transacts under its own plugin key, so without this the editor's
   * keystrokes would land in the document but not on the undo stack — and ⌘Z would silently skip
   * them. Everything passed here is still a *local* gesture; remote and system origins are never
   * tracked (08_DATA_MODEL.md §2.5).
   */
  extraTrackedOrigins?: readonly unknown[];
}

export function createBoardHistory(doc: Y.Doc, options: CreateHistoryOptions = {}): BoardHistory {
  const stackLimit = options.stackLimit ?? UNDO_STACK_LIMIT;
  const manager = new Y.UndoManager(undoScope(doc), {
    trackedOrigins: new Set<unknown>([...TRACKED_ORIGINS, ...(options.extraTrackedOrigins ?? [])]),
    captureTimeout: options.captureTimeout ?? UNDO_CAPTURE_TIMEOUT_MS,
    ignoreRemoteMapChanges: true,
  });

  let pendingLabel: string | null = null;
  const state: HistoryState = emptyState();
  const listeners = new Set<(next: HistoryState) => void>();

  const refresh = (): void => {
    // Drop the oldest steps: Y.UndoManager is unbounded by default (08 §2.5).
    if (manager.undoStack.length > stackLimit) {
      manager.undoStack.splice(0, manager.undoStack.length - stackLimit);
    }
    // The redo stack is unbounded too: undoing a long session moved every step into it and the
    // heap kept growing (measured in a browser, 2026-08-23). Same cap, same reason.
    if (manager.redoStack.length > stackLimit) {
      manager.redoStack.splice(0, manager.redoStack.length - stackLimit);
    }
    state.canUndo = manager.undoStack.length > 0;
    state.canRedo = manager.redoStack.length > 0;
    state.undoDepth = manager.undoStack.length;
    state.redoDepth = manager.redoStack.length;
    state.undoLabel = labelOf(manager.undoStack.at(-1));
    state.redoLabel = labelOf(manager.redoStack.at(-1));
    for (const listener of listeners) listener({ ...state });
  };

  const onAdded = (event: { stackItem: { meta: StackItemMeta } }): void => {
    if (pendingLabel !== null) event.stackItem.meta.set(LABEL_KEY, pendingLabel);
    refresh();
  };
  const onPopped = (event: { stackItem: { meta: StackItemMeta } }): void => {
    // Carry the label across to the opposite stack so redo can name the step too.
    const label = labelOf(event.stackItem);
    if (label !== null) event.stackItem.meta.set(LABEL_KEY, label);
    refresh();
  };

  manager.on('stack-item-added', onAdded);
  manager.on('stack-item-popped', onPopped);
  manager.on('stack-cleared', refresh);

  return {
    manager,
    state,
    undo() {
      if (manager.undoStack.length === 0) return false;
      manager.undo();
      refresh();
      return true;
    },
    redo() {
      if (manager.redoStack.length === 0) return false;
      manager.redo();
      refresh();
      return true;
    },
    label(text: string) {
      pendingLabel = text;
    },
    separate() {
      manager.stopCapturing();
    },
    subscribe(listener) {
      listeners.add(listener);
      listener({ ...state });
      return () => listeners.delete(listener);
    },
    destroy() {
      manager.off('stack-item-added', onAdded);
      manager.off('stack-item-popped', onPopped);
      manager.off('stack-cleared', refresh);
      listeners.clear();
      manager.destroy();
    },
  };
}
