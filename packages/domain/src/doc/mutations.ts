/**
 * Every write to a board document goes through this module (08_DATA_MODEL.md §2.4, P3 §5.3).
 * Callers outside `packages/domain/src/doc` may not touch `Y.Map.set` — the `no-direct-graph-write`
 * ESLint rule enforces it, which is what makes undo, the doc-size guard and the future projection
 * batching possible in one place.
 */

import * as Y from 'yjs';

import { EdgeSchema, type BoardEdge } from '../entities/edge.ts';
import { GroupSchema, type BoardGroup } from '../entities/group.ts';
import { NodeSchema, type BoardNode } from '../entities/node.ts';
import {
  NODE_HARD_LIMIT,
  NODE_SOFT_LIMIT,
  boardRoots,
  type BoardDocRoots,
  type EntityMap,
} from './schema.ts';
import { tx, type Origin } from './transactions.ts';

export class DocLimitError extends Error {
  readonly limit: number;
  constructor(message: string, limit: number) {
    super(message);
    this.name = 'DocLimitError';
    this.limit = limit;
  }
}

/** Fills a fresh `Y.Map` from a plain record. Nested values stay plain JSON (08 §2.2.2). */
function toEntityMap(record: Record<string, unknown>): EntityMap {
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(record)) map.set(key, value);
  return map;
}

/** Board-size guard (P3 §5.15): warn at 4,000 nodes, refuse to create past 20,000. */
export function nodeBudget(doc: Y.Doc): { count: number; warn: boolean; blocked: boolean } {
  const count = boardRoots(doc).nodes.size;
  return { count, warn: count >= NODE_SOFT_LIMIT, blocked: count >= NODE_HARD_LIMIT };
}

export function assertCanCreateNodes(doc: Y.Doc, adding: number): void {
  const { count } = nodeBudget(doc);
  if (count + adding > NODE_HARD_LIMIT) {
    throw new DocLimitError(
      `This board is limited to ${String(NODE_HARD_LIMIT)} nodes (it has ${String(count)}). ` +
        'Split the investigation into a second board.',
      NODE_HARD_LIMIT,
    );
  }
}

function bumpUpdated(map: EntityMap, now: string): void {
  map.set('updatedAt', now);
  const version = map.get('version');
  map.set('version', typeof version === 'number' ? version + 1 : 1);
}

function touchBoard(roots: BoardDocRoots, now: string): void {
  roots.meta.set('updatedAt', now);
}

/* --------------------------------------------------------------------- nodes */

export function addNodes(
  doc: Y.Doc,
  nodes: readonly BoardNode[],
  options: { origin: Origin; now: string },
): void {
  assertCanCreateNodes(doc, nodes.length);
  const roots = boardRoots(doc);
  tx(doc, options.origin, () => {
    for (const node of nodes) {
      const parsed = NodeSchema.parse(node);
      roots.nodes.set(parsed.id, toEntityMap(parsed));
      roots.order.push([parsed.id]);
    }
    touchBoard(roots, options.now);
  });
}

export function addNode(
  doc: Y.Doc,
  node: BoardNode,
  options: { origin: Origin; now: string },
): void {
  addNodes(doc, [node], options);
}

/** Patches scalar fields of one node. Unknown keys in `patch` are written as-is (forward compat). */
export function updateNode(
  doc: Y.Doc,
  id: string,
  patch: Record<string, unknown>,
  options: { origin: Origin; now: string },
): boolean {
  const roots = boardRoots(doc);
  const map = roots.nodes.get(id);
  if (map === undefined) return false;
  tx(doc, options.origin, () => {
    for (const [key, value] of Object.entries(patch)) map.set(key, value);
    bumpUpdated(map, options.now);
    touchBoard(roots, options.now);
  });
  return true;
}

/** One transaction for the whole drag, so a 200-node move is a single undo step (08 §2.4). */
export function moveNodes(
  doc: Y.Doc,
  moves: ReadonlyArray<{ id: string; x: number; y: number }>,
  options: { origin: Origin; now: string },
): void {
  const roots = boardRoots(doc);
  tx(doc, options.origin, () => {
    for (const move of moves) {
      const map = roots.nodes.get(move.id);
      if (map === undefined) continue;
      map.set('x', move.x);
      map.set('y', move.y);
      bumpUpdated(map, options.now);
    }
    touchBoard(roots, options.now);
  });
}

export function resizeNode(
  doc: Y.Doc,
  id: string,
  rect: { x: number; y: number; w: number; h: number },
  options: { origin: Origin; now: string },
): boolean {
  return updateNode(doc, id, rect, options);
}

/**
 * Hard-removes nodes together with their incident edges and their `order` entries. Deleting is a
 * CRDT delete, not a tombstone: soft delete (`deletedAt`) is a separate, user-visible trash flow.
 */
export function removeNodes(
  doc: Y.Doc,
  ids: readonly string[],
  options: { origin: Origin; now: string },
): void {
  const roots = boardRoots(doc);
  const doomed = new Set(ids);
  tx(doc, options.origin, () => {
    for (const id of doomed) roots.nodes.delete(id);
    for (const edgeId of incidentEdgeIds(roots, doomed)) roots.edges.delete(edgeId);
    pruneOrder(roots);
    touchBoard(roots, options.now);
  });
}

function incidentEdgeIds(roots: BoardDocRoots, nodeIds: ReadonlySet<string>): string[] {
  const ids: string[] = [];
  roots.edges.forEach((map, id) => {
    const source = map.get('source');
    const target = map.get('target');
    if (nodeIds.has(endpointId(source)) || nodeIds.has(endpointId(target))) ids.push(id);
  });
  return ids;
}

function endpointId(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const nodeId = (value as { nodeId?: unknown }).nodeId;
  return typeof nodeId === 'string' ? nodeId : '';
}

/** Rebuilds `order` so it holds every live node id exactly once (invariant §7.4). */
function pruneOrder(roots: BoardDocRoots): void {
  const live = new Set<string>();
  roots.nodes.forEach((_map, id) => live.add(id));
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of roots.order.toArray()) {
    if (live.has(id) && !seen.has(id)) {
      seen.add(id);
      next.push(id);
    }
  }
  for (const id of live) if (!seen.has(id)) next.push(id);
  const current = roots.order.toArray();
  if (current.length === next.length && current.every((id, i) => id === next[i])) return;
  roots.order.delete(0, roots.order.length);
  roots.order.push(next);
}

/** Public repair entry point; used after import and on load (08 §7). */
export function repairOrder(doc: Y.Doc): void {
  const roots = boardRoots(doc);
  tx(doc, 'system:gc', () => {
    pruneOrder(roots);
  });
}

/* --------------------------------------------------------------------- edges */

export function addEdges(
  doc: Y.Doc,
  edges: readonly BoardEdge[],
  options: { origin: Origin; now: string },
): void {
  const roots = boardRoots(doc);
  tx(doc, options.origin, () => {
    for (const edge of edges) {
      const parsed = EdgeSchema.parse(edge);
      roots.edges.set(parsed.id, toEntityMap(parsed));
    }
    touchBoard(roots, options.now);
  });
}

export function addEdge(
  doc: Y.Doc,
  edge: BoardEdge,
  options: { origin: Origin; now: string },
): void {
  addEdges(doc, [edge], options);
}

export function updateEdge(
  doc: Y.Doc,
  id: string,
  patch: Record<string, unknown>,
  options: { origin: Origin; now: string },
): boolean {
  const roots = boardRoots(doc);
  const map = roots.edges.get(id);
  if (map === undefined) return false;
  tx(doc, options.origin, () => {
    for (const [key, value] of Object.entries(patch)) map.set(key, value);
    bumpUpdated(map, options.now);
    touchBoard(roots, options.now);
  });
  return true;
}

export function removeEdges(
  doc: Y.Doc,
  ids: readonly string[],
  options: { origin: Origin; now: string },
): void {
  const roots = boardRoots(doc);
  tx(doc, options.origin, () => {
    for (const id of ids) roots.edges.delete(id);
    touchBoard(roots, options.now);
  });
}

/** Removes edges whose endpoints no longer exist (invariant §7.1) — used after a merge. */
export function pruneDanglingEdges(doc: Y.Doc): string[] {
  const roots = boardRoots(doc);
  const removed: string[] = [];
  tx(doc, 'system:gc', () => {
    roots.edges.forEach((map, id) => {
      const from = endpointId(map.get('source'));
      const to = endpointId(map.get('target'));
      if (!roots.nodes.has(from) || !roots.nodes.has(to)) removed.push(id);
    });
    for (const id of removed) roots.edges.delete(id);
  });
  return removed;
}

/* -------------------------------------------------------------------- groups */

export function addGroup(
  doc: Y.Doc,
  group: BoardGroup,
  options: { origin: Origin; now: string },
): void {
  const roots = boardRoots(doc);
  const parsed = GroupSchema.parse(group);
  tx(doc, options.origin, () => {
    roots.groups.set(parsed.id, toEntityMap(parsed));
    for (const childId of parsed.childIds) {
      const child = roots.nodes.get(childId);
      if (child !== undefined) child.set('parentId', parsed.id);
    }
    touchBoard(roots, options.now);
  });
}

/** Patches group fields (collapsed, label, geometry). Mirrors `updateNode` deliberately. */
export function updateGroup(
  doc: Y.Doc,
  id: string,
  patch: Record<string, unknown>,
  options: { origin: Origin; now: string },
): boolean {
  const roots = boardRoots(doc);
  const map = roots.groups.get(id);
  if (map === undefined) return false;
  tx(doc, options.origin, () => {
    for (const [key, value] of Object.entries(patch)) map.set(key, value);
    bumpUpdated(map, options.now);
    touchBoard(roots, options.now);
  });
  return true;
}

export function removeGroup(
  doc: Y.Doc,
  id: string,
  options: { origin: Origin; now: string },
): boolean {
  const roots = boardRoots(doc);
  if (!roots.groups.has(id)) return false;
  tx(doc, options.origin, () => {
    roots.groups.delete(id);
    roots.nodes.forEach((map) => {
      if (map.get('parentId') === id) map.set('parentId', null);
    });
    touchBoard(roots, options.now);
  });
  return true;
}

/* ------------------------------------------------------------------ z-order */

export type ZOrderOp = 'front' | 'back' | 'forward' | 'backward';

/** Moves ids inside `order` (08 §2.2.4) and denormalises the resulting index into `node.z`. */
export function reorder(
  doc: Y.Doc,
  ids: readonly string[],
  op: ZOrderOp,
  options: { origin: Origin; now: string },
): void {
  const roots = boardRoots(doc);
  tx(doc, options.origin, () => {
    pruneOrder(roots);
    const current = roots.order.toArray();
    const moving = current.filter((id) => ids.includes(id));
    if (moving.length === 0) return;
    const rest = current.filter((id) => !moving.includes(id));
    let next: string[];
    if (op === 'front') next = [...rest, ...moving];
    else if (op === 'back') next = [...moving, ...rest];
    else {
      next = [...current];
      const order = op === 'forward' ? [...moving].reverse() : moving;
      for (const id of order) {
        const from = next.indexOf(id);
        const to = op === 'forward' ? Math.min(next.length - 1, from + 1) : Math.max(0, from - 1);
        if (from === to) continue;
        next.splice(from, 1);
        next.splice(to, 0, id);
      }
    }
    roots.order.delete(0, roots.order.length);
    roots.order.push(next);
    next.forEach((id, index) => {
      const map = roots.nodes.get(id);
      if (map !== undefined) map.set('z', index);
    });
    touchBoard(roots, options.now);
  });
}

/* ---------------------------------------------------------------- rich text */

/** Creates (or returns) the `Y.XmlFragment` a node's body is bound to (08 §2.2.5). */
export function ensureFragment(doc: Y.Doc, fragmentKey: string, origin: Origin): Y.XmlFragment {
  const roots = boardRoots(doc);
  const existing = roots.richtext.get(fragmentKey);
  if (existing !== undefined) return existing;
  return tx(doc, origin, () => {
    const fragment = new Y.XmlFragment();
    roots.richtext.set(fragmentKey, fragment);
    return fragment;
  });
}

/* ------------------------------------------------------------------- reads */

export function getNode(doc: Y.Doc, id: string): BoardNode | undefined {
  const map = boardRoots(doc).nodes.get(id);
  if (map === undefined) return undefined;
  const parsed = NodeSchema.safeParse(map.toJSON());
  return parsed.success ? parsed.data : undefined;
}

export function listNodes(doc: Y.Doc): BoardNode[] {
  const roots = boardRoots(doc);
  const nodes: BoardNode[] = [];
  roots.nodes.forEach((map) => {
    const parsed = NodeSchema.safeParse(map.toJSON());
    if (parsed.success) nodes.push(parsed.data);
  });
  // `id` is the tiebreak; timestamps are never an ordering key (P3 §8, clock skew).
  return nodes.sort((a, b) => (a.z === b.z ? a.id.localeCompare(b.id) : a.z - b.z));
}

/** Cheap size read for snapshots, budgets and telemetry. */
export function countEntities(doc: Y.Doc): { nodes: number; edges: number; groups: number } {
  const roots = boardRoots(doc);
  return { nodes: roots.nodes.size, edges: roots.edges.size, groups: roots.groups.size };
}

export function getEdge(doc: Y.Doc, id: string): BoardEdge | undefined {
  const map = boardRoots(doc).edges.get(id);
  if (map === undefined) return undefined;
  const parsed = EdgeSchema.safeParse(map.toJSON());
  return parsed.success ? parsed.data : undefined;
}

export function hasNode(doc: Y.Doc, id: string): boolean {
  return boardRoots(doc).nodes.has(id);
}

export function hasEdge(doc: Y.Doc, id: string): boolean {
  return boardRoots(doc).edges.has(id);
}

export function listEdges(doc: Y.Doc): BoardEdge[] {
  const edges: BoardEdge[] = [];
  boardRoots(doc).edges.forEach((map) => {
    const parsed = EdgeSchema.safeParse(map.toJSON());
    if (parsed.success) edges.push(parsed.data);
  });
  return edges.sort((a, b) => a.id.localeCompare(b.id));
}

export function listGroups(doc: Y.Doc): BoardGroup[] {
  const groups: BoardGroup[] = [];
  boardRoots(doc).groups.forEach((map) => {
    const parsed = GroupSchema.safeParse(map.toJSON());
    if (parsed.success) groups.push(parsed.data);
  });
  return groups.sort((a, b) => a.id.localeCompare(b.id));
}
