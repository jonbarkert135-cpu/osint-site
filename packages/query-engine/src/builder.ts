/**
 * The visual workflow editor's model, and running a saved workflow again (Part 2 §45, §46).
 *
 * §45 asks for the same canvas architecture: a workflow is assembled by dropping nodes and drawing
 * arrows — `Sherlock → SpiderFoot → Entity Resolver`. So the editor is not a second graph engine.
 * It is the two functions a canvas needs:
 *
 *   `layoutWorkflow()`  saved workflow → positioned nodes + arrows (what the canvas draws)
 *   `graphToWorkflow()` positioned nodes + arrows → saved workflow (what the canvas produces)
 *
 * The canvas edits an `EditorGraph`, which is unordered by nature (an analyst draws arrows in any
 * order), while a `Workflow` is declaration-ordered. `graphToWorkflow` is the seam: it topologically
 * sorts the arrows, so a cycle is reported here as a cycle instead of surfacing later as the
 * "upstream node must be declared earlier" complaint from `validateWorkflow`.
 *
 * §46 is the reason the model is data: `runWorkflow()` binds a *new* input to the saved pipeline
 * and returns the same `QueryPlan` shape `planQuery` produces, so re-running the workflow for
 * tomorrow's username uses the existing orchestrator, budgets, cost gate and provenance unchanged.
 */

import {
  DEFAULT_BUDGET,
  type EntityKind,
  type PlannerContext,
  type TransformRegistry,
} from '@nexus/transforms';

import { groupExclusions, type QueryPlan } from './plan.ts';
import { typeQuery } from './selectors.ts';
import {
  compileWorkflow,
  parseWorkflow,
  type Workflow,
  type WorkflowIssue,
  type WorkflowNode,
  type WorkflowStage,
} from './workflow.ts';

/** Canvas geometry, in board units. One column per dependency rank, one row per node in it. */
export const EDITOR_LAYOUT = {
  nodeWidth: 180,
  nodeHeight: 64,
  columnGap: 80,
  rowGap: 32,
  originX: 0,
  originY: 0,
} as const;

export interface EditorNode {
  readonly id: string;
  readonly stage: WorkflowStage;
  readonly transform?: string;
  /** Only the input node: the entity kind the pipeline is pinned to (§46). */
  readonly kind?: EntityKind;
  readonly label: string;
  readonly x: number;
  readonly y: number;
}

/** An arrow the analyst drew: `from` feeds `to`. */
export interface EditorEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

export interface EditorGraph {
  readonly nodes: readonly EditorNode[];
  readonly edges: readonly EditorEdge[];
}

const labelFor = (node: WorkflowNode): string => node.label ?? node.transform ?? node.stage;

/**
 * Positions a saved workflow for the canvas. Rank is the longest path from the input node, so a
 * step never sits left of something it consumes and independent branches share a column — the
 * same reading the DAG scheduler acts on (`schedule.ts`).
 */
export const layoutWorkflow = (workflow: Workflow): EditorGraph => {
  const rank = new Map<string, number>();
  for (const node of workflow.nodes) {
    const upstream = node.after.map((parent) => rank.get(parent) ?? 0);
    rank.set(node.id, upstream.length === 0 ? 0 : Math.max(...upstream) + 1);
  }

  const rows = new Map<number, number>();
  const nodes = workflow.nodes.map((node) => {
    const column = rank.get(node.id) ?? 0;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return {
      id: node.id,
      stage: node.stage,
      ...(node.transform === undefined ? {} : { transform: node.transform }),
      ...(node.kind === undefined ? {} : { kind: node.kind }),
      label: labelFor(node),
      x: EDITOR_LAYOUT.originX + column * (EDITOR_LAYOUT.nodeWidth + EDITOR_LAYOUT.columnGap),
      y: EDITOR_LAYOUT.originY + row * (EDITOR_LAYOUT.nodeHeight + EDITOR_LAYOUT.rowGap),
    };
  });

  const edges = workflow.nodes.flatMap((node) =>
    node.after.map((parent) => ({ id: `${parent}->${node.id}`, from: parent, to: node.id })),
  );

  return { nodes, edges };
};

export interface WorkflowMeta {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export type BuiltWorkflow =
  | { readonly ok: true; readonly workflow: Workflow }
  | { readonly ok: false; readonly issues: readonly WorkflowIssue[] };

/**
 * Turns what the analyst drew into a saved workflow. Only structural facts of the *drawing* are
 * decided here — node order and cycles; everything else (unknown transforms, illegal stage order)
 * stays the business of `validateWorkflow`, which the caller runs on the result.
 */
export const graphToWorkflow = (graph: EditorGraph, meta: WorkflowMeta): BuiltWorkflow => {
  const issues: WorkflowIssue[] = [];
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const parents = new Map<string, string[]>(graph.nodes.map((node) => [node.id, []]));

  for (const edge of graph.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) {
      issues.push({ message: `an arrow points at a node that is not on the canvas: ${edge.id}` });
      continue;
    }
    if (edge.from === edge.to) {
      issues.push({ node: edge.from, message: 'a node cannot feed itself' });
      continue;
    }
    const into = parents.get(edge.to);
    if (into && !into.includes(edge.from)) into.push(edge.from);
  }

  // Kahn's algorithm: whatever is left when no node has all its parents placed is inside a cycle.
  const placed: EditorNode[] = [];
  const remaining = new Set(byId.keys());
  const done = new Set<string>();
  for (;;) {
    const ready = [...remaining].filter((id) =>
      (parents.get(id) ?? []).every((parent) => done.has(parent)),
    );
    if (ready.length === 0) break;
    for (const id of ready) {
      const node = byId.get(id);
      if (node) placed.push(node);
      remaining.delete(id);
      done.add(id);
    }
  }
  for (const id of remaining) {
    issues.push({ node: id, message: 'the arrows form a cycle through this node' });
  }
  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    workflow: {
      id: meta.id,
      name: meta.name,
      version: 1,
      ...(meta.description === undefined ? {} : { description: meta.description }),
      nodes: placed.map((node) => ({
        id: node.id,
        stage: node.stage,
        ...(node.transform === undefined ? {} : { transform: node.transform }),
        ...(node.kind === undefined ? {} : { kind: node.kind }),
        label: node.label,
        after: parents.get(node.id) ?? [],
      })),
    },
  };
};

/** What a saved workflow is on disk or in a board attachment: JSON, read back by `parseWorkflow`. */
export const serializeWorkflow = (workflow: Workflow): string => JSON.stringify(workflow, null, 2);

export const deserializeWorkflow = (text: string): BuiltWorkflow => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, issues: [{ message: 'not valid JSON' }] };
  }
  const parsed = parseWorkflow(value);
  return parsed.ok ? { ok: true, workflow: parsed.workflow } : { ok: false, issues: parsed.issues };
};

export interface WorkflowRun {
  readonly workflow: Workflow;
  readonly issues: readonly WorkflowIssue[];
  /** Ready for `executePlan`; absent when the workflow or the new input was rejected. */
  readonly query?: QueryPlan;
}

/**
 * Runs a saved workflow again for a new input — the §46 case: same pipeline, tomorrow's username.
 *
 * The input is typed by the normal selector table, and the workflow's input node may pin the kind
 * it was designed for (`kind: 'username'`). Pinning is a refusal, not a coercion: a saved username
 * pipeline pointed at `example.com` reports the mismatch instead of running Sherlock on a domain.
 */
export const runWorkflow = (
  registry: TransformRegistry,
  workflow: Workflow,
  input: string,
  ctx: Omit<PlannerContext, 'budget'> & Partial<Pick<PlannerContext, 'budget'>>,
): WorkflowRun => {
  const compiled = compileWorkflow(registry, workflow, ctx);
  if (compiled.issues.length > 0 || compiled.plan === undefined) {
    return { workflow, issues: compiled.issues };
  }

  const expected = workflow.nodes.find((node) => node.stage === 'input')?.kind;
  const candidates = [...typeQuery(input)].sort((a, b) => b.confidence - a.confidence);
  const chosen =
    expected === undefined
      ? candidates[0]
      : candidates.find((candidate) => candidate.kind === expected);

  if (chosen === undefined) {
    const typed = candidates[0]?.kind;
    return {
      workflow,
      issues: [
        {
          node: 'input',
          message:
            expected === undefined
              ? `"${input}" does not look like anything this workflow can start from`
              : `this workflow expects a ${expected}; "${input}" types as ${typed ?? 'nothing'}`,
        },
      ],
    };
  }

  const budget = ctx.budget ?? DEFAULT_BUDGET;
  const plan = {
    ...compiled.plan,
    estimate: {
      ...compiled.plan.estimate,
      maxEntities: Math.min(compiled.plan.estimate.maxEntities, budget.maxNewNodes),
    },
  };

  return {
    workflow,
    issues: [],
    query: {
      input: input.trim(),
      candidates,
      chosen,
      ambiguous: false,
      plan,
      hidden: groupExclusions(plan),
    },
  };
};

/** The kinds an input node may be pinned to, for the editor's dropdown. */
export const inputKindOptions = (registry: TransformRegistry): readonly EntityKind[] =>
  [...new Set(registry.transforms.flatMap((manifest) => manifest.inputs))].sort();
