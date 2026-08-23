/**
 * The command palette (P7 §5.8-10): fuzzy commands by default, plus four prefix modes. One input,
 * one list, arrow-key navigation and an `aria-live` result count for screen readers.
 *
 * Modes (P7 §5.9): `>` commands only (same list as no prefix), `#` tags on this board, `@` nodes
 * on this board (jumps the camera and pulses the result — the same path search results use),
 * `/` projects (and, once one is open, its boards), `?` help topics.
 */

import { Dialog } from '@nexus/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import { useBoards, useProjects, useWorkspaceRole } from '../../data/workspace/context.tsx';
import { useBoardStatus } from '../shell/boardStatus.tsx';
import { registerStaticCommands } from './commands/staticCommands.ts';
import { commandRegistry, recordRecentCommand, type CommandContext } from './registry.ts';

registerStaticCommands();

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** `combo` is `mod+k` style: `mod` = Cmd on macOS, Ctrl elsewhere. A bare key (e.g. `/`) works too. */
export function useShortcut(combo: string, handler: () => void): void {
  useEffect(() => {
    const parts = combo.toLowerCase().split('+');
    const key = parts[parts.length - 1] ?? '';
    const needsMod = parts.includes('mod');
    const needsShift = parts.includes('shift');
    const needsAlt = parts.includes('alt');

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== key) return;
      if (needsMod !== (event.metaKey || event.ctrlKey)) return;
      if (needsShift !== event.shiftKey) return;
      if (needsAlt !== event.altKey) return;
      // Bare keys must not fire while the user is typing; a modifier combo (⌘/Ctrl+K) must, or the
      // palette becomes unreachable from any field — including the inspector's own inputs.
      if (!needsMod && isTextEntry(event.target)) return;
      event.preventDefault();
      handler();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [combo, handler]);
}

type Mode = 'commands' | 'tags' | 'nodes' | 'switch' | 'help';

function modeOf(query: string): { mode: Mode; term: string } {
  const prefix = query.charAt(0);
  const term = query.slice(1);
  if (prefix === '>') return { mode: 'commands', term };
  if (prefix === '#') return { mode: 'tags', term };
  if (prefix === '@') return { mode: 'nodes', term };
  if (prefix === '/') return { mode: 'switch', term };
  if (prefix === '?') return { mode: 'help', term };
  return { mode: 'commands', term: query };
}

interface Row {
  key: string;
  label: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const role = useWorkspaceRole();
  const boardStatus = useBoardStatus();

  const view: CommandContext['view'] =
    params.boardId !== undefined || location.pathname.startsWith('/b/')
      ? 'board'
      : params.projectId !== undefined
        ? 'project'
        : location.pathname.startsWith('/settings')
          ? 'settings'
          : 'shell';

  const context: CommandContext = useMemo(
    () => ({
      role,
      view,
      projectId: params.projectId ?? null,
      boardId: params.boardId ?? boardStatus.boardId,
      navigate: (path: string) => navigate(path),
    }),
    [role, view, params.projectId, params.boardId, boardStatus.boardId, navigate],
  );

  const openWith = (initialQuery: string) => {
    setQuery(initialQuery);
    setActiveIndex(0);
    setOpen(true);
  };
  useShortcut('mod+k', () => openWith(''));
  useShortcut('mod+p', () => openWith('/'));

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery('');
  };

  useEffect(() => setActiveIndex(0), [query]);

  const { mode, term } = modeOf(query);

  // Always mounted at the shell level, so these run in the background regardless of `open`;
  // both are cheap local reads (or already-cached server queries), unlike a node-level index.
  const projects = useProjects();
  const boards = useBoards(context.projectId ?? '');

  const rows: Row[] = useMemo(() => {
    if (!open) return [];

    const nodeRows = (limit: number): Row[] => {
      const index = boardStatus.searchIndex;
      const boardId = boardStatus.boardId;
      if (index === null || boardId === null || term.trim() === '') return [];
      return index.search(term, { boardId, limit }).map(
        (result): Row => ({
          key: `n:${result.id}`,
          label: result.title === '' ? '(untitled)' : result.title,
          hint: 'node',
          run: () => boardStatus.focusNode?.(result.id),
        }),
      );
    };

    if (mode === 'commands') {
      const commandRows = commandRegistry.search(term, context).map(
        (command): Row => ({
          key: command.id,
          label: command.title,
          ...(command.shortcut !== undefined ? { hint: command.shortcut } : {}),
          run: () => {
            recordRecentCommand(command.id);
            void command.run(context);
          },
        }),
      );
      // A bare query searches the board too: typing a domain or a name should find the node
      // that holds it, without knowing the `@` prefix first (00_GOAL: findable evidence).
      return query.startsWith('>') ? commandRows : [...commandRows, ...nodeRows(8)];
    }

    if (mode === 'help') {
      return commandRegistry
        .available(context)
        .filter((c) => c.group === 'help')
        .map((c): Row => ({ key: c.id, label: c.title, run: () => void c.run(context) }));
    }

    if (mode === 'tags') {
      const needle = term.toLowerCase();
      return boardStatus.tags
        .filter((tag) => tag.toLowerCase().includes(needle))
        .map(
          (tag): Row => ({
            key: tag,
            label: tag,
            run: () => undefined, // Tag filtering on the canvas is out of this phase's scope.
          }),
        );
    }

    if (mode === 'nodes') return nodeRows(20);

    // mode === 'switch': projects, then (once one is in view) its boards.
    const projectRows: Row[] = (projects.data ?? [])
      .filter((p) => p.name.toLowerCase().includes(term.toLowerCase()))
      .map((p) => ({
        key: `p:${p.id}`,
        label: p.name,
        hint: 'project',
        run: () => navigate(`/p/${p.id}`),
      }));
    const boardRows: Row[] = (boards.data ?? [])
      .filter((b) => b.title.toLowerCase().includes(term.toLowerCase()))
      .map((b) => ({
        key: `b:${b.id}`,
        label: b.title,
        hint: 'board',
        run: () => navigate(`/b/${b.id}`),
      }));
    return [...boardRows, ...projectRows];
  }, [open, mode, term, query, context, boardStatus, projects.data, boards.data, navigate]);

  const choose = (row: Row | undefined) => {
    if (row === undefined) return;
    row.run();
    onOpenChange(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(rows.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(rows[activeIndex]);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Search actions, nodes and boards."
    >
      <div
        className="nx-stack"
        role="combobox"
        aria-expanded={open}
        aria-controls="nx-palette-list"
        aria-owns="nx-palette-list"
      >
        <input
          ref={inputRef}
          className="nx-input"
          aria-label="Command palette"
          placeholder="Search commands and this board — or #tag / @node / /board / ?help"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div aria-live="polite" className="nx-visually-hidden">
          {rows.length} {rows.length === 1 ? 'result' : 'results'}
        </div>
        {rows.length === 0 ? (
          <p className="nx-muted">No commands yet</p>
        ) : (
          <ul id="nx-palette-list" role="listbox" className="nx-stack">
            {rows.map((row, index) => (
              <li key={row.key}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  data-active={index === activeIndex}
                  onClick={() => choose(row)}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <span>{row.label}</span>
                  {row.hint !== undefined ? <span className="nx-muted">{row.hint}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

export type { Command, CommandContext } from './registry.ts';
