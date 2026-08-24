/**
 * DAG scheduling for a query plan (24_UNIFIED_QUERY.md §6, Part 2 §11–§13).
 *
 * A plan is not a list of stages, it is a dependency graph. Two steps that need nothing from each
 * other must start at the same moment; a step that consumes another's output must wait for exactly
 * that step and nothing else. Depth-barrier scheduling gets the second right and the first wrong:
 * one slow engine in stage 1 holds back every independent step behind it.
 *
 * This module turns `PlanStep[]` into an execution DAG and hands the executor a ready-queue: a node
 * becomes runnable the instant its own predecessors have settled, whatever the rest of the plan is
 * doing. It decides ordering only — it never runs anything and never touches the network.
 */

import type { PlanStep, TransformId } from '@nexus/transforms';

export interface DagNode {
  readonly step: PlanStep;
  /** Transform ids this node consumes output from, restricted to steps that exist in the plan. */
  readonly dependsOn: readonly TransformId[];
  /** Transform ids waiting on this node — the wake-up list when it settles. */
  readonly dependents: readonly TransformId[];
  /** Longest dependency chain ending here; 0 for a root. Used for reporting, not for gating. */
  readonly rank: number;
}

export interface ExecutionDag {
  readonly nodes: ReadonlyMap<TransformId, DagNode>;
  /** Nodes runnable immediately, in plan order. */
  readonly roots: readonly TransformId[];
  /** Longest path through the graph, i.e. the number of sequential hops the plan forces. */
  readonly depth: number;
  /** Widest set of nodes that share a rank — the parallelism the plan can actually offer. */
  readonly width: number;
  /**
   * Edges dropped to keep the graph acyclic, plus edges pointing at absent steps. A cycle in a
   * plan is a planner bug; the run must still be able to proceed, so it is reported, not thrown.
   */
  readonly warnings: readonly string[];
}

/** Depth-first cycle break: an edge that closes a loop back to an in-progress node is dropped. */
const acyclicEdges = (
  raw: Map<TransformId, TransformId[]>,
  order: readonly TransformId[],
  warnings: string[],
): Map<TransformId, TransformId[]> => {
  const state = new Map<TransformId, 'open' | 'closed'>();
  const kept = new Map<TransformId, TransformId[]>();
  for (const id of order) kept.set(id, []);

  const visit = (id: TransformId): void => {
    state.set(id, 'open');
    for (const parent of raw.get(id) ?? []) {
      const parentState = state.get(parent);
      if (parentState === 'open') {
        warnings.push(`dependency cycle: ${id} → ${parent} dropped to keep the plan runnable`);
        continue;
      }
      if (parentState === undefined) visit(parent);
      kept.get(id)?.push(parent);
    }
    state.set(id, 'closed');
  };

  for (const id of order) if (state.get(id) === undefined) visit(id);
  return kept;
};

/**
 * Builds the execution DAG. Dependencies come from `PlanStep.dependsOn`; a step that declares none
 * (or only unknown ones) is a root and starts immediately.
 */
export const buildDag = (steps: readonly PlanStep[]): ExecutionDag => {
  const warnings: string[] = [];
  const order = steps.map((step) => step.transform);
  const present = new Set(order);
  const byId = new Map<TransformId, PlanStep>();
  for (const step of steps) {
    if (byId.has(step.transform)) {
      warnings.push(`duplicate step ${step.transform}: only the first occurrence is scheduled`);
      continue;
    }
    byId.set(step.transform, step);
  }

  const raw = new Map<TransformId, TransformId[]>();
  for (const [id, step] of byId) {
    const parents: TransformId[] = [];
    for (const parent of step.dependsOn) {
      if (parent === id) continue;
      if (!present.has(parent)) {
        warnings.push(`${id} depends on ${parent}, which is not in the plan: edge ignored`);
        continue;
      }
      if (!parents.includes(parent)) parents.push(parent);
    }
    raw.set(id, parents);
  }

  const uniqueOrder = [...byId.keys()];
  const edges = acyclicEdges(raw, uniqueOrder, warnings);

  const dependents = new Map<TransformId, TransformId[]>();
  for (const id of uniqueOrder) dependents.set(id, []);
  for (const [id, parents] of edges) {
    for (const parent of parents) dependents.get(parent)?.push(id);
  }

  const rank = new Map<TransformId, number>();
  const rankOf = (id: TransformId): number => {
    const known = rank.get(id);
    if (known !== undefined) return known;
    rank.set(id, 0);
    const parents = edges.get(id) ?? [];
    const value = parents.length === 0 ? 0 : Math.max(...parents.map(rankOf)) + 1;
    rank.set(id, value);
    return value;
  };

  const nodes = new Map<TransformId, DagNode>();
  for (const id of uniqueOrder) {
    const step = byId.get(id);
    if (!step) continue;
    nodes.set(id, {
      step,
      dependsOn: edges.get(id) ?? [],
      dependents: dependents.get(id) ?? [],
      rank: rankOf(id),
    });
  }

  const roots = uniqueOrder.filter((id) => (nodes.get(id)?.dependsOn.length ?? 0) === 0);
  const perRank = new Map<number, number>();
  for (const node of nodes.values()) perRank.set(node.rank, (perRank.get(node.rank) ?? 0) + 1);

  return {
    nodes,
    roots,
    depth: nodes.size === 0 ? 0 : Math.max(...[...nodes.values()].map((node) => node.rank)) + 1,
    width: perRank.size === 0 ? 0 : Math.max(...perRank.values()),
    warnings,
  };
};

export interface DagScheduler {
  /** Ids that can start now, removed from the queue as they are handed out. */
  readonly take: (limit: number) => readonly TransformId[];
  /** Marks a node settled (done, failed or skipped) and releases whatever it was blocking. */
  readonly settle: (id: TransformId) => void;
  /** Nothing left to run and nothing in flight. */
  readonly finished: () => boolean;
  readonly pending: () => number;
  readonly inFlight: () => number;
  /** Nodes that can never run because a dependency never settled — reported at the end of a run. */
  readonly blocked: () => readonly TransformId[];
}

/**
 * Ready-queue over a DAG. The executor asks for as many runnable nodes as its parallelism budget
 * allows, and reports each one back when it settles; dependents unlock immediately, without waiting
 * for the rest of their rank.
 *
 * A failed dependency still unlocks its dependents: partial beats perfect (U5), and a downstream
 * step with no inputs skips itself cheaply rather than being silently dropped from the plan.
 */
export const createScheduler = (dag: ExecutionDag): DagScheduler => {
  const remaining = new Map<TransformId, number>();
  for (const [id, node] of dag.nodes) remaining.set(id, node.dependsOn.length);

  const ready: TransformId[] = [...dag.roots];
  const running = new Set<TransformId>();
  const settled = new Set<TransformId>();

  return {
    take: (limit) => {
      const batch = ready.splice(0, Math.max(0, limit));
      for (const id of batch) running.add(id);
      return batch;
    },
    settle: (id) => {
      running.delete(id);
      if (settled.has(id)) return;
      settled.add(id);
      for (const dependent of dag.nodes.get(id)?.dependents ?? []) {
        const left = (remaining.get(dependent) ?? 0) - 1;
        remaining.set(dependent, left);
        if (left <= 0 && !settled.has(dependent) && !running.has(dependent)) ready.push(dependent);
      }
    },
    finished: () => ready.length === 0 && running.size === 0,
    pending: () => ready.length,
    inFlight: () => running.size,
    blocked: () => [...dag.nodes.keys()].filter((id) => !settled.has(id) && !running.has(id)),
  };
};
