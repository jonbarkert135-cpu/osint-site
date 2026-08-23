/**
 * The command palette registry (P7 §5.8-10). Every user-facing action in the product registers
 * one `Command` here — `registry.test.ts` asserts that every menu action has a matching command,
 * which is what keeps the palette from silently falling behind the menus as the app grows.
 *
 * Fuzzy ranking reuses `@nexus/domain`'s local search index instead of a second matcher: a command
 * is just a very short document (title + group + keywords), and P7 §5.5's prefix/fuzzy rules are
 * exactly what "type part of a command name" wants too.
 */

import { createLocalIndex, type LocalIndex } from '@nexus/domain';

import type { WorkspaceRole } from '../../data/workspace/types.ts';

/** What a command's `when()`/`run()` can see and act on (P7 §7: "typed; when(context) gates"). */
export interface CommandContext {
  role: WorkspaceRole;
  /** Where the palette was opened from; gates view-specific commands (e.g. board-only actions). */
  view: 'shell' | 'project' | 'board' | 'settings';
  projectId: string | null;
  boardId: string | null;
  navigate: (path: string) => void;
}

export type CommandGroup = 'navigate' | 'project' | 'board' | 'search' | 'help' | 'plugin';

export interface Command {
  id: string;
  title: string;
  group: CommandGroup;
  keywords?: readonly string[];
  shortcut?: string;
  /** Omitted means "always available"; present means "only when this returns true". */
  when?: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext) => void | Promise<void>;
}

const RECENTS_KEY = 'raven.palette.recents';
const MAX_RECENTS = 5;

/** Recent commands rank first, stored per device (P7 §5.9) — not synced, not per-org. */
export function recordRecentCommand(id: string, storage: Storage = window.localStorage): void {
  try {
    const existing = readRecents(storage);
    const next = [id, ...existing.filter((x) => x !== id)].slice(0, MAX_RECENTS);
    storage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Storage can be unavailable (private browsing); recency ranking is a nicety, not a feature.
  }
}

export function readRecents(storage: Storage = window.localStorage): string[] {
  try {
    const raw = storage.getItem(RECENTS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export class CommandRegistry {
  readonly #commands = new Map<string, Command>();
  #index: LocalIndex | null = null;

  register(command: Command): void {
    this.#commands.set(command.id, command);
    this.#index = null;
  }

  unregister(id: string): void {
    this.#commands.delete(id);
    this.#index = null;
  }

  clear(): void {
    this.#commands.clear();
    this.#index = null;
  }

  get(id: string): Command | undefined {
    return this.#commands.get(id);
  }

  /** Every command whose `when()` passes (or has none), unfiltered by any query. */
  available(ctx: CommandContext): Command[] {
    return [...this.#commands.values()].filter((c) => c.when === undefined || c.when(ctx));
  }

  #buildIndex(): LocalIndex {
    if (this.#index !== null) return this.#index;
    const index = createLocalIndex();
    for (const command of this.#commands.values()) {
      index.upsert({
        id: command.id,
        boardId: 'commands',
        title: command.title,
        body: command.group,
        keywords: command.keywords ?? [],
      });
    }
    this.#index = index;
    return index;
  }

  /**
   * Fuzzy-searches available commands; an empty query returns them all with recents first
   * (P7 §5.9). `storage` is injected for tests.
   */
  search(query: string, ctx: CommandContext, storage: Storage = window.localStorage): Command[] {
    const available = this.available(ctx);
    const availableIds = new Set(available.map((c) => c.id));
    const byId = new Map(available.map((c) => [c.id, c] as const));

    if (query.trim() === '') {
      const recents = readRecents(storage).filter((id) => availableIds.has(id));
      const rest = available
        .filter((c) => !recents.includes(c.id))
        .sort((a, b) => a.title.localeCompare(b.title));
      return [
        ...recents.map((id) => byId.get(id)).filter((c): c is Command => c !== undefined),
        ...rest,
      ];
    }

    return this.#buildIndex()
      .search(query, { limit: 50 })
      .map((result) => byId.get(result.id))
      .filter((c): c is Command => c !== undefined);
  }
}

/** The one registry the app uses; a fresh instance is only ever needed in tests. */
export const commandRegistry = new CommandRegistry();
