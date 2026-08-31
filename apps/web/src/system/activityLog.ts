/**
 * The unified activity log (Part 2 §54).
 *
 * One place that answers "what has this session actually done" — queries, engine runs, objects
 * found, connections created, AI actions, errors, imports and exports — instead of the truth being
 * split across the run console, the System page and a toast that already faded.
 *
 * Session-scoped and in-memory, like `runtimeStore`: a log that survives a reload belongs in
 * `@nexus/db`, and a persisted-looking log that quietly forgets would be worse than none. Recording
 * is fire-and-forget so no caller has to care whether anyone is watching.
 */

import type { QueryEvent } from '@nexus/query-engine';
import { useSyncExternalStore } from 'react';

export const ACTIVITY_KINDS = [
  'query',
  'engine',
  'entity',
  'connection',
  'ai',
  'error',
  'import',
  'export',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface ActivityEntry {
  readonly seq: number;
  readonly at: number;
  readonly kind: ActivityKind;
  readonly text: string;
}

/** A session cannot need more than this, and the page must stay cheap to render. */
const MAX_ENTRIES = 500;

let entries: readonly ActivityEntry[] = [];
let seq = 0;
const listeners = new Set<() => void>();

const publish = (next: readonly ActivityEntry[]): void => {
  entries = next;
  for (const listener of listeners) listener();
};

export const activitySnapshot = (): readonly ActivityEntry[] => entries;

export const logActivity = (kind: ActivityKind, text: string): void => {
  seq += 1;
  publish([...entries, { seq, at: Date.now(), kind, text }].slice(-MAX_ENTRIES));
};

export const clearActivity = (): void => {
  publish([]);
};

/**
 * The run stream, translated into log lines. Only the events a person would look for later are
 * kept: per-step progress ticks are noise in a history, and the run console already shows them.
 */
export const recordQueryEvent = (event: QueryEvent): void => {
  switch (event.type) {
    case 'plan.started':
      logActivity('query', `Plan started · ${String(event.steps)} step(s)`);
      return;
    case 'step.started':
      logActivity(
        'engine',
        `${event.step.transform} via ${event.engine} on ${event.step.input.value}`,
      );
      return;
    case 'step.skipped':
      logActivity('engine', `${event.step.transform} skipped · ${event.reason}`);
      return;
    case 'entity.found':
      logActivity('entity', `${event.entity.kind} ${event.entity.value}`);
      return;
    case 'relation.found':
      logActivity(
        'connection',
        `${event.relation.kind} · ${event.relation.derived ? 'derived' : 'observed'}`,
      );
      return;
    case 'step.failed':
      logActivity(
        'error',
        `${event.step.transform} failed · ${event.message}${event.fallback ? ' (retrying)' : ''}`,
      );
      return;
    case 'step.done':
      if (event.cached) logActivity('engine', `${event.step.transform} answered from cache`);
      return;
    default:
      return;
  }
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useActivity = (): readonly ActivityEntry[] =>
  useSyncExternalStore(subscribe, activitySnapshot, activitySnapshot);
