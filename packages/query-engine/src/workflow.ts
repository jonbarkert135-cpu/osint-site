/**
 * Saved workflows (Part 2 §44).
 *
 * The brief's example is the whole shape of the feature:
 *
 *   Input → Normalize → Sherlock → SpiderFoot → GitHub → Entity Resolution → Graph → AI Summary
 *
 * A workflow is a **saved, ordered pipeline** an analyst assembled once and can run again. It is
 * declarative data: stages in a fixed vocabulary, transform steps referenced by manifest id, and
 * dependencies between them. Nothing here executes — `compileWorkflow` turns a workflow into the
 * same `TransformPlan` the planner produces, which the existing DAG scheduler and executor run,
 * so a workflow gets budgets, cost gating, provenance and partial results for free.
 *
 * Two deliberate rules:
 *  - **Stage order is a fact, not a suggestion.** Resolution cannot precede the transforms it
 *    resolves and a summary cannot precede the graph it summarizes, so a workflow that says
 *    otherwise is rejected with a message instead of silently reordered.
 *  - **An unknown transform is an error, not a skip.** A pipeline that quietly drops the step the
 *    analyst cared about is the failure mode this layer exists to avoid.
 */

import {
  DEFAULT_BUDGET,
  costProfile,
  costVerdict,
  routeTransform,
  type PlanExclusion,
  type PlanStep,
  type PlannerContext,
  type TransformId,
  type TransformPlan,
  type TransformRegistry,
} from '@nexus/transforms';

/** Pipeline stages, in the only order they may appear. */
export const WORKFLOW_STAGES = [
  'input',
  'normalize',
  'transform',
  'entity-resolution',
  'graph',
  'ai-summary',
] as const;
export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

const stageRank = (stage: WorkflowStage): number => WORKFLOW_STAGES.indexOf(stage);

export interface WorkflowNode {
  readonly id: string;
  readonly stage: WorkflowStage;
  /** Required for `transform` nodes, forbidden everywhere else. */
  readonly transform?: TransformId;
  readonly label?: string;
  /** Node ids this one consumes; empty for the input node. */
  readonly after: readonly string[];
}

export interface Workflow {
  readonly id: string;
  readonly name: string;
  readonly version: 1;
  readonly description?: string;
  readonly nodes: readonly WorkflowNode[];
}

export interface WorkflowIssue {
  readonly node?: string;
  readonly message: string;
}

/** Structural and semantic validation. An empty array means the workflow is runnable. */
export const validateWorkflow = (
  registry: TransformRegistry,
  workflow: Workflow,
): readonly WorkflowIssue[] => {
  const issues: WorkflowIssue[] = [];
  const seen = new Set<string>();
  const inputs = workflow.nodes.filter((node) => node.stage === 'input');

  if (workflow.nodes.length === 0) issues.push({ message: 'a workflow needs at least one node' });
  if (inputs.length !== 1) {
    issues.push({
      message: `a workflow needs exactly one input node, found ${String(inputs.length)}`,
    });
  }
  if (!workflow.nodes.some((node) => node.stage === 'transform')) {
    issues.push({ message: 'a workflow with no transform step would collect nothing' });
  }

  for (const node of workflow.nodes) {
    if (seen.has(node.id)) issues.push({ node: node.id, message: 'duplicate node id' });
    seen.add(node.id);

    if (node.stage === 'transform') {
      if (node.transform === undefined) {
        issues.push({ node: node.id, message: 'a transform node must name a transform' });
      } else if (!registry.transform(node.transform)) {
        issues.push({ node: node.id, message: `unknown transform: ${node.transform}` });
      }
    } else if (node.transform !== undefined) {
      issues.push({ node: node.id, message: `a ${node.stage} node cannot name a transform` });
    }

    if (node.stage === 'input' && node.after.length > 0) {
      issues.push({ node: node.id, message: 'the input node cannot depend on anything' });
    }
    if (node.stage !== 'input' && node.after.length === 0) {
      issues.push({ node: node.id, message: 'every node except the input needs an upstream node' });
    }

    for (const parent of node.after) {
      if (!seen.has(parent)) {
        // Declaration order is the topological order: a forward reference is either a cycle or
        // an unknown id, and both are the same mistake from the analyst's point of view.
        issues.push({
          node: node.id,
          message: `upstream node must be declared earlier: ${parent}`,
        });
        continue;
      }
      const upstream = workflow.nodes.find((candidate) => candidate.id === parent);
      if (upstream && stageRank(upstream.stage) > stageRank(node.stage)) {
        issues.push({
          node: node.id,
          message: `a ${node.stage} node cannot come after a ${upstream.stage} node`,
        });
      }
    }
  }

  return issues;
};

export interface CompiledWorkflow {
  readonly workflow: Workflow;
  /** Empty only when the workflow is valid; a compile with issues carries no plan. */
  readonly issues: readonly WorkflowIssue[];
  readonly plan?: TransformPlan;
}

/**
 * Compiles a saved workflow into an executable plan. The transform nodes become plan steps in
 * declaration order, each depending on the transform nodes upstream of it (through any number of
 * non-transform stages), which is what makes the scheduler run independent branches in parallel.
 * The non-transform stages — normalize, entity resolution, graph, AI summary — are the executor's
 * own pipeline and need no steps of their own; they are validated, not compiled.
 */
export const compileWorkflow = (
  registry: TransformRegistry,
  workflow: Workflow,
  ctx: Omit<PlannerContext, 'budget'> & Partial<Pick<PlannerContext, 'budget'>>,
): CompiledWorkflow => {
  const issues = validateWorkflow(registry, workflow);
  if (issues.length > 0) return { workflow, issues };

  const budget = ctx.budget ?? DEFAULT_BUDGET;
  const byId = new Map(workflow.nodes.map((node) => [node.id, node] as const));
  const steps: PlanStep[] = [];
  const excluded: PlanExclusion[] = [];
  const providersUsed = new Set<string>();
  const credentialsNeeded = new Set<string>();
  let requiresNetwork = false;

  /** Nearest transform ancestors: non-transform stages are transparent to the dependency edge. */
  const transformAncestors = (id: string, seen = new Set<string>()): readonly TransformId[] => {
    const node = byId.get(id);
    if (!node || seen.has(id)) return [];
    seen.add(id);
    return node.after.flatMap((parent) => {
      const upstream = byId.get(parent);
      if (upstream?.stage === 'transform' && upstream.transform !== undefined) {
        return [upstream.transform];
      }
      return transformAncestors(parent, seen);
    });
  };

  const depthOf = new Map<TransformId, number>();
  for (const node of workflow.nodes) {
    if (node.stage !== 'transform' || node.transform === undefined) continue;
    const manifest = registry.transform(node.transform);
    if (!manifest) continue; // validateWorkflow already rejected this

    const routed = routeTransform(registry, manifest, ctx);
    if (routed.reason) {
      excluded.push({ transform: manifest.id, reason: routed.reason });
      continue;
    }
    const primary = routed.chain.find((entry) => !entry.engine.terminal);
    if (!primary) {
      excluded.push({ transform: manifest.id, reason: 'no-engine' });
      continue;
    }
    if (ctx.costCeiling) {
      const verdict = costVerdict(
        costProfile(manifest, primary.engine, primary.provider),
        routed.score,
        ctx.costCeiling,
      );
      if (!verdict.ok) {
        excluded.push({ transform: manifest.id, reason: verdict.reason, note: verdict.note });
        continue;
      }
    }

    const dependsOn = [...new Set(transformAncestors(node.id))].filter((id) =>
      steps.some((step) => step.transform === id),
    );
    const depth =
      dependsOn.length === 0 ? 1 : Math.max(...dependsOn.map((id) => depthOf.get(id) ?? 1)) + 1;
    depthOf.set(manifest.id, depth);
    steps.push({
      transform: manifest.id,
      inputKind: manifest.inputs[0] ?? 'note',
      dependsOn,
      depth,
      chain: routed.chain.map((entry) => entry.engine.id),
      estimatedRuntimeMs: manifest.limits.expectedRuntimeMs,
      maxResults: Math.min(manifest.limits.maxResults, budget.maxNewNodes),
    });
    providersUsed.add(primary.provider.id);
    if (primary.engine.dataFlow !== 'local') requiresNetwork = true;
    if (primary.provider.credentials === 'required') credentialsNeeded.add(primary.provider.id);
  }

  const runtimeMs = steps.reduce((total, step) => total + step.estimatedRuntimeMs, 0);
  return {
    workflow,
    issues,
    plan: {
      steps,
      estimate: {
        runtimeMs,
        minEntities: steps.length,
        maxEntities: Math.min(
          steps.reduce((total, step) => total + step.maxResults, 0),
          budget.maxNewNodes,
        ),
      },
      requiresNetwork,
      providersUsed: [...providersUsed],
      credentialsNeeded: [...credentialsNeeded],
      excluded,
    },
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStage = (value: unknown): value is WorkflowStage =>
  WORKFLOW_STAGES.includes(value as WorkflowStage);

/**
 * Parses a saved workflow (a file, a board attachment, a paste). Shape errors come back as issues
 * so the UI can show them; a saved workflow is user input and never trusted.
 */
export type ParsedWorkflow =
  | { readonly ok: true; readonly workflow: Workflow }
  | { readonly ok: false; readonly issues: readonly WorkflowIssue[] };

export const parseWorkflow = (value: unknown): ParsedWorkflow => {
  if (!isRecord(value)) return { ok: false, issues: [{ message: 'a workflow must be an object' }] };
  const { id, name, version, description, nodes } = value;
  const issues: WorkflowIssue[] = [];
  if (typeof id !== 'string' || id.length === 0) issues.push({ message: 'id must be a string' });
  if (typeof name !== 'string' || name.length === 0) {
    issues.push({ message: 'name must be a string' });
  }
  if (version !== 1) issues.push({ message: 'version must be 1' });
  if (description !== undefined && typeof description !== 'string') {
    issues.push({ message: 'description must be a string when present' });
  }
  if (!Array.isArray(nodes)) issues.push({ message: 'nodes must be an array' });

  const parsed: WorkflowNode[] = [];
  if (Array.isArray(nodes)) {
    for (const [index, raw] of nodes.entries()) {
      if (!isRecord(raw) || typeof raw.id !== 'string' || !isStage(raw.stage)) {
        issues.push({ message: `node ${String(index)} needs an id and a known stage` });
        continue;
      }
      const after = Array.isArray(raw.after) ? raw.after.filter((x) => typeof x === 'string') : [];
      if (Array.isArray(raw.after) && after.length !== raw.after.length) {
        issues.push({ node: raw.id, message: 'after must contain node ids' });
      }
      parsed.push({
        id: raw.id,
        stage: raw.stage,
        ...(typeof raw.transform === 'string' ? { transform: raw.transform } : {}),
        ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
        after,
      });
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    workflow: {
      id: id as string,
      name: name as string,
      version: 1,
      ...(typeof description === 'string' ? { description } : {}),
      nodes: parsed,
    },
  };
};

/**
 * The brief's pipeline, shipped as a template so the builder starts from something real.
 *
 * Honest substitution: there is no SpiderFoot engine in the catalog yet (12_SPIDERFOOT.md is spec,
 * not code), so the broad-sweep slot is filled by the shipped equivalent — web mentions for the
 * selector. The step is a manifest id like any other, so swapping it for `spiderfoot` is a one-line
 * edit the day that engine lands.
 */
export const WORKFLOW_TEMPLATES: readonly Workflow[] = [
  {
    id: 'handle-to-summary',
    name: 'Handle → profiles → repos → summary',
    version: 1,
    description:
      'The Part 2 §44 pipeline: normalize a handle, sweep profiles and mentions, pull repositories, resolve entities, build the graph, summarize.',
    nodes: [
      { id: 'input', stage: 'input', label: 'Username', after: [] },
      { id: 'normalize', stage: 'normalize', label: 'Normalize', after: ['input'] },
      {
        id: 'profiles',
        stage: 'transform',
        transform: 'username-to-profiles',
        label: 'Sherlock',
        after: ['normalize'],
      },
      {
        id: 'mentions',
        stage: 'transform',
        transform: 'selector-to-web-mentions',
        label: 'Broad sweep (SpiderFoot slot)',
        after: ['normalize'],
      },
      {
        id: 'repos',
        stage: 'transform',
        transform: 'username-to-repositories',
        label: 'GitHub',
        after: ['profiles'],
      },
      {
        id: 'resolve',
        stage: 'entity-resolution',
        label: 'Entity resolution',
        after: ['mentions', 'repos'],
      },
      { id: 'graph', stage: 'graph', label: 'Graph', after: ['resolve'] },
      { id: 'summary', stage: 'ai-summary', label: 'AI summary', after: ['graph'] },
    ],
  },
];
