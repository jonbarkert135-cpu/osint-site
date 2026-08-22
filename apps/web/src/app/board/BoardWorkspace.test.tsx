/**
 * The board page end to end inside jsdom: create a node, undo it, export it, import an archive and
 * restore a snapshot — all without a network and without a real canvas context.
 */

import {
  addNode,
  createBoardDoc,
  exportBoard,
  listNodes,
  makeNode,
  serializeBoardExport,
} from '@nexus/domain';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { MemoryRouter } from 'react-router-dom';

import { BoardDocProvider } from '../../data/docProvider';
import { snapshotOf, type SnapshotRecord, type SnapshotStore } from '../../data/snapshots';
import { WorkspaceProvider } from '../../data/workspace/context';
import { fakeWorkspaceRepository } from '../../data/workspace/testFakes';
import { BoardWorkspace } from './BoardWorkspace';

const NOW = '2026-08-17T12:00:00.000Z';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = IDBKeyRange;
  vi.spyOn(console, 'error').mockImplementation(() => undefined); // jsdom has no 2D context
});

function memoryStore(records: SnapshotRecord[] = []): SnapshotStore {
  return {
    save: (record) => {
      records.push(record);
      return Promise.resolve();
    },
    list: (boardId) =>
      Promise.resolve(
        records
          .filter((record) => record.boardId === boardId)
          .map(({ update: _update, ...summary }) => summary),
      ),
    load: (id) => Promise.resolve(records.find((record) => record.id === id) ?? null),
    prune: () => Promise.resolve(0),
  };
}

function view(store: SnapshotStore = memoryStore()) {
  return render(
    <MemoryRouter>
      <WorkspaceProvider repository={fakeWorkspaceRepository()}>
        <BoardDocProvider boardId="b_work" snapshotStoreImpl={store}>
          <BoardWorkspace />
        </BoardDocProvider>
      </WorkspaceProvider>
    </MemoryRouter>,
  );
}

function archiveJson(): unknown {
  const doc = createBoardDoc({ boardId: 'b_other', title: 'Imported', now: NOW });
  addNode(doc, makeNode({ id: 'i1', x: 0, y: 0, title: 'From file' }, NOW), {
    origin: 'local:create',
    now: NOW,
  });
  return JSON.parse(serializeBoardExport(exportBoard(doc, { appVersion: '0.3.0', now: NOW })));
}

function fileWith(value: unknown): File {
  const text = JSON.stringify(value);
  const file = new File([text], 'board.raven.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(text) });
  return file;
}

describe('<BoardWorkspace>', () => {
  it('creates a note, then undoes it with the keyboard', async () => {
    view();
    await waitFor(() => expect(screen.getByTestId('sync-status')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('add-note'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Undo: create 1 node/ })).toBeEnabled(),
    );

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Redo/ })).toBeEnabled());

    fireEvent.keyDown(window, { key: 'Z', ctrlKey: true, shiftKey: true });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Undo: create 1 node/ })).toBeEnabled(),
    );
  });

  it('focuses the title of a freshly created note so typing does not hit shortcuts', async () => {
    view();
    await waitFor(() => expect(screen.getByTestId('sync-status')).toBeInTheDocument());
    const before = screen.queryByLabelText('Title');
    expect(before).toBeNull();

    fireEvent.click(screen.getByTestId('add-note'));

    const title = await screen.findByLabelText('Title');
    await waitFor(() => expect(document.activeElement).toBe(title));
  });

  it('exports the board as a downloadable archive', async () => {
    const createObjectURL = vi.fn(() => 'blob:board');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });

    view();
    await waitFor(() => expect(screen.getByTestId('sync-status')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('add-note'));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    // The export dialog is a lazy chunk (§23), so it arrives a microtask after the click.
    await waitFor(() => expect(screen.getByTestId('export-run')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('export-run'));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });

  it('hides the canvas from focus while a view mode covers it', async () => {
    view();
    await waitFor(() => expect(screen.getByTestId('sync-status')).toBeInTheDocument());
    expect(screen.getByTestId('canvas-host')).not.toHaveAttribute('inert');

    fireEvent.change(screen.getByTestId('view-mode'), { target: { value: 'table' } });
    await waitFor(() => expect(screen.getByTestId('canvas-host')).toHaveAttribute('inert'));
  });

  it('imports an archive only after an explicit confirmation', async () => {
    view();
    await waitFor(() => expect(screen.getByTestId('sync-status')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    // The dialog is a lazy chunk (§23), so it arrives a microtask after the click.
    fireEvent.change(await screen.findByTestId('import-file'), {
      target: { files: [fileWith(archiveJson())] },
    });
    await waitFor(() => expect(screen.getByTestId('import-summary')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Import', hidden: false }));
    await waitFor(() => expect(screen.getByText(/Imported 1 nodes/)).toBeInTheDocument());
  });

  it('restores a snapshot from the version history', async () => {
    const past = createBoardDoc({ boardId: 'b_work', now: NOW });
    addNode(past, makeNode({ id: 'old', x: 0, y: 0, title: 'From snapshot' }, NOW), {
      origin: 'local:create',
      now: NOW,
    });
    const record = snapshotOf(past, 'b_work', 's1', 1_000, 'auto');
    view(memoryStore([record]));
    await waitFor(() => expect(screen.getByTestId('sync-status')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Version history' }));
    const restore = await screen.findByRole('button', { name: 'Restore this version' });
    fireEvent.click(restore);
    await waitFor(() => expect(screen.getByText(/Version restored/)).toBeInTheDocument());
  });

  it('tracks the pointer over the board so a paste/drop can re-aim at it', async () => {
    const { container } = view();
    await waitFor(() => expect(screen.getByTestId('sync-status')).toBeInTheDocument());

    const main = container.querySelector('.nx-board-main');
    expect(main).not.toBeNull();
    fireEvent.pointerMove(main as Element, { clientX: 123, clientY: 45 });
    // No engine in this render, so `aim()` falls back to the origin — the assertion here is just
    // that tracking the pointer over the board doesn't throw, and note creation still works after.
    fireEvent.click(screen.getByTestId('add-note'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Undo: create 1 node/ })).toBeEnabled(),
    );
  });

  it('applies a snapshot update onto the live document', () => {
    const doc = createBoardDoc({ boardId: 'b_apply', now: NOW });
    addNode(doc, makeNode({ id: 'n1', x: 0, y: 0 }, NOW), { origin: 'local:create', now: NOW });
    const clone = new Y.Doc();
    Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
    expect(listNodes(clone)).toHaveLength(1);
  });
});
