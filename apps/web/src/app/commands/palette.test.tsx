import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLocalIndex } from '@nexus/domain';

import type * as WorkspaceSearch from '../../search/workspaceSearch';

type WorkspaceSearchModule = typeof WorkspaceSearch;

// Workspace search reads other boards from IndexedDB, which jsdom has none of: the loader is the
// seam, so the palette is exercised against a real `LocalIndex` built from fake board documents.
vi.mock('../../search/workspaceSearch', async (importOriginal) => {
  const actual = await importOriginal<WorkspaceSearchModule>();
  return {
    ...actual,
    loadBoardDocFromIndexedDb: () => Promise.resolve(null),
  };
});

import { WorkspaceProvider } from '../../data/workspace/context';
import { BoardStatusProvider, useBoardStatus } from '../shell/boardStatus';
import { fakeWorkspaceRepository } from '../../data/workspace/testFakes';
import { commandRegistry } from './registry';
import { CommandPalette } from './palette';

function renderPalette(path = '/', extra?: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceProvider repository={fakeWorkspaceRepository()}>
        <MemoryRouter initialEntries={[path]}>
          {extra}
          <CommandPalette />
        </MemoryRouter>
      </WorkspaceProvider>
    </QueryClientProvider>,
  );
}

function PublishBoard({ index }: { index: ReturnType<typeof createLocalIndex> }) {
  const status = useBoardStatus();
  useEffect(() => {
    status.publish({ boardId: 'b1', searchIndex: index });
  }, [status, index]);
  return null;
}

function renderPaletteWithBoardAt(path: string, index: ReturnType<typeof createLocalIndex>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceProvider repository={fakeWorkspaceRepository()}>
        <MemoryRouter initialEntries={[path]}>
          <BoardStatusProvider>
            <PublishBoard index={index} />
            <CommandPalette />
          </BoardStatusProvider>
        </MemoryRouter>
      </WorkspaceProvider>
    </QueryClientProvider>,
  );
}

function PublishTags({
  tags,
  setTagFilter,
  tagFilter = null,
}: {
  tags: readonly string[];
  setTagFilter: (tag: string | null) => void;
  tagFilter?: string | null;
}) {
  const status = useBoardStatus();
  useEffect(() => {
    status.publish({ boardId: 'b1', tags, setTagFilter, tagFilter });
  }, [status, tags, setTagFilter, tagFilter]);
  return null;
}

function renderPaletteWithTags(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceProvider repository={fakeWorkspaceRepository()}>
        <MemoryRouter initialEntries={['/b/b1']}>
          <BoardStatusProvider>
            {node}
            <CommandPalette />
          </BoardStatusProvider>
        </MemoryRouter>
      </WorkspaceProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  window.localStorage.clear();
});

describe('CommandPalette', () => {
  it('opens on Cmd/Ctrl+K and lists the registered commands', async () => {
    const user = userEvent.setup();
    renderPalette();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('option', { name: /go to settings/i })).toBeInTheDocument();
  });

  it('still opens while the caret sits in a text input (an inspector field, say)', async () => {
    const user = userEvent.setup();
    renderPalette('/', <input aria-label="note" />);
    await user.click(screen.getByLabelText('note'));
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('option', { name: /go to settings/i })).toBeInTheDocument();
  });

  it('filters commands by fuzzy title match', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(screen.getByRole('textbox', { name: 'Command palette' }), 'settings');
    expect(await screen.findByRole('option', { name: /go to settings/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /keyboard shortcuts/i })).not.toBeInTheDocument();
  });

  it('opens the board switcher on Cmd/Ctrl+P, pre-filled with "/"', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}p{/Control}');
    expect(await screen.findByDisplayValue('/')).toBeInTheDocument();
  });

  it('runs the highlighted command on Enter', async () => {
    let ran = false;
    commandRegistry.register({
      id: 'test.run',
      title: 'Run me',
      group: 'help',
      run: () => {
        ran = true;
      },
    });
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(screen.getByRole('textbox', { name: 'Command palette' }), 'Run me');
    await user.keyboard('{Enter}');
    expect(ran).toBe(true);
    commandRegistry.unregister('test.run');
  });

  it('announces the result count for screen readers', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    const region = document.querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region?.textContent).toMatch(/results?/);
  });

  it('finds a board node from a bare query, without the @ prefix', async () => {
    const user = userEvent.setup();
    const index = createLocalIndex();
    index.upsert({
      id: 'n1',
      boardId: 'b1',
      title: 'Acme Corp',
      body: 'contact@acme-corp.io',
      keywords: ['target'],
    });
    renderPaletteWithBoardAt('/b/b1', index);
    await user.keyboard('{Control>}k{/Control}');
    await user.type(screen.getByRole('textbox', { name: 'Command palette' }), 'acme');
    expect(await screen.findByRole('option', { name: /acme corp/i })).toBeInTheDocument();
  });

  it('shows board commands on the default board, which has no /b/ in its path', async () => {
    commandRegistry.register({
      id: 'test.board',
      title: 'Board only action',
      group: 'board',
      when: (ctx) => ctx.view === 'board',
      run: () => undefined,
    });
    const user = userEvent.setup();
    renderPaletteWithBoardAt('/', createLocalIndex());
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('option', { name: /board only action/i })).toBeInTheDocument();
    commandRegistry.unregister('test.board');
  });

  it('finds a project by name from a bare query', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(screen.getByRole('textbox', { name: 'Command palette' }), 'atlas');
    expect(await screen.findByRole('option', { name: /atlas/i })).toBeInTheDocument();
  });

  it('filters the canvas by the tag picked in # mode', async () => {
    const user = userEvent.setup();
    const setTagFilter = vi.fn();
    renderPaletteWithTags(<PublishTags tags={['infra', 'people']} setTagFilter={setTagFilter} />);
    await user.keyboard('{Control>}k{/Control}');
    await user.type(screen.getByRole('textbox', { name: 'Command palette' }), '#inf');
    await user.click(await screen.findByRole('option', { name: /infra/i }));
    expect(setTagFilter).toHaveBeenCalledWith('infra');
  });

  it('offers to clear an active tag filter from # mode', async () => {
    const user = userEvent.setup();
    const setTagFilter = vi.fn();
    renderPaletteWithTags(
      <PublishTags tags={['infra']} setTagFilter={setTagFilter} tagFilter="infra" />,
    );
    await user.keyboard('{Control>}k{/Control}');
    await user.type(screen.getByRole('textbox', { name: 'Command palette' }), '#');
    await user.click(await screen.findByRole('option', { name: /clear filter/i }));
    expect(setTagFilter).toHaveBeenCalledWith(null);
  });

  it('says so when no other board on this device can be read in @@ mode', async () => {
    const user = userEvent.setup();
    renderPaletteWithBoardAt('/b/b1', createLocalIndex());
    await user.keyboard('{Control>}k{/Control}');
    await user.type(screen.getByRole('textbox', { name: 'Command palette' }), '@@acme');
    // The fake workspace has one board with no local document: no cross-board hits, no crash.
    expect(screen.queryByRole('option', { name: /acme/i })).not.toBeInTheDocument();
  });

  it('switches to help mode with "?"', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(screen.getByRole('textbox', { name: 'Command palette' }), '?');
    expect(await screen.findByRole('option', { name: /keyboard shortcuts/i })).toBeInTheDocument();
  });
});
