/**
 * The Research Orchestrator Agent (Part 2 §47–§50).
 *
 * §47 turns the AI from a chatbot into the thing that decides *what research to run*: it sees the
 * question, the available engines, their capabilities, the results so far, the current graph, the
 * resource budget and the granted permissions, and it decides what to run, in which order, what
 * deserves a second hop, where to stop and what to show.
 *
 * The shape of that answer here is deliberate and boring, because an autonomous tool-runner is a
 * safety problem before it is a feature:
 *
 *  - **§48 the agent is never unbounded.** Depth, jobs, wall clock, resource budget, permission
 *    boundary and an approval threshold are declared up front (`AgentGuardrails`) and enforced in
 *    this file, not in a prompt. A model cannot raise them, because a model is never asked.
 *  - **A model may narrow, never widen.** The optional `choose` hook is handed the candidate steps
 *    the *planner* already allowed and returns a subset. Anything it invents is ignored — so the
 *    difference between a good and a hallucinating model is speed, not safety.
 *  - **§49 the loop is observe → plan → execute → collect → evaluate → decide**, and the decision
 *    is allowed to be "stop": a round that adds nothing new ends the session (`no-new-value`)
 *    instead of paying for another hop.
 *  - **§50 the agent remembers the graph.** `AgentMemory` is seeded from what the board already
 *    knows, so an entity that is already on the canvas is not re-collected and a transform that
 *    already ran against an input is not run again.
 *  - **N4 still holds**: the agent produces investigation results, never board writes. Landing
 *    anything is the analyst's decision, through the normal proposal path.
 *
 * Execution is injected (`execute`), like engines are injected into the executor: this file decides,
 * `executePlan` runs. That is also why the whole loop is testable without a network.
 */

import {
  DEFAULT_BUDGET,
  expand,
  routeTransform,
  type Budget,
  type CostCeiling,
  type EntityKind,
  type PlanStep,
  type PlannerContext,
  type TransformId,
  type TransformRegistry,
} from '@nexus/transforms';

import type { InvestigationResult } from './events.ts';
import { groupExclusions, type QueryPlan } from './plan.ts';
import type { ResolvedEntity } from './resolve.ts';
import { typeQuery, type EntityCandidate } from './selectors.ts';

/** §48: the boundaries of one session. Nothing in this file can raise them. */
export interface AgentGuardrails {
  /** How many hops of derived work the agent may take. 1 = run the seed's transforms and stop. */
  readonly maxDepth: number;
  /** Total steps (jobs) the whole session may execute. */
  readonly maxJobs: number;
  /** Wall-clock ceiling for the session, checked before every round. */
  readonly maxRuntimeMs: number;
  /** Resource budget handed to the planner and the executor for every task. */
  readonly budget: Budget;
  /** Optional cost gate (§42); absent means the planner prices nothing. */
  readonly costCeiling?: CostCeiling;
  /** How many entities one round may follow up on, best-first. */
  readonly maxEntitiesPerRound: number;
  /** A step that could add more nodes than this needs a human yes first. */
  readonly approveAboveNewNodes: number;
  /** Spending a stored credential always asks, unless the caller turns this off. */
  readonly approveCredentialed: boolean;
  /** A round producing fewer new entities than this is the last one. */
  readonly minNewEntities: number;
}

export const DEFAULT_GUARDRAILS: AgentGuardrails = {
  maxDepth: 2,
  maxJobs: 12,
  maxRuntimeMs: 120_000,
  budget: DEFAULT_BUDGET,
  maxEntitiesPerRound: 4,
  approveAboveNewNodes: 100,
  approveCredentialed: true,
  minNewEntities: 1,
};

/** §50: what the session already knows, seeded from the board. */
export interface AgentMemory {
  knows(kind: EntityKind, value: string): boolean;
  /** Has this transform already been run against this exact input, here or on the board? */
  didRun(transform: TransformId, kind: EntityKind, value: string): boolean;
  learn(entities: readonly { readonly kind: EntityKind; readonly value: string }[]): void;
  recordRun(transform: TransformId, kind: EntityKind, value: string): void;
  readonly known: number;
}

const entityKey = (kind: EntityKind, value: string): string =>
  `${kind}:${value.trim().toLowerCase()}`;

export const createAgentMemory = (
  seed: readonly { readonly kind: EntityKind; readonly value: string }[] = [],
  ranTransforms: readonly {
    readonly transform: TransformId;
    readonly kind: EntityKind;
    readonly value: string;
  }[] = [],
): AgentMemory => {
  const entities = new Set(seed.map((entity) => entityKey(entity.kind, entity.value)));
  const runs = new Set(
    ranTransforms.map((run) => `${run.transform}@${entityKey(run.kind, run.value)}`),
  );
  return {
    knows: (kind, value) => entities.has(entityKey(kind, value)),
    didRun: (transform, kind, value) => runs.has(`${transform}@${entityKey(kind, value)}`),
    learn: (found) => {
      for (const entity of found) entities.add(entityKey(entity.kind, entity.value));
    },
    recordRun: (transform, kind, value) => {
      runs.add(`${transform}@${entityKey(kind, value)}`);
    },
    get known() {
      return entities.size;
    },
  };
};

/** One unit of work the agent decided on: a seed entity and the steps to run against it. */
export interface AgentTask {
  readonly entity: EntityCandidate;
  readonly steps: readonly PlanStep[];
  /** Ready for `executePlan`, so a task inherits scheduling, budgets and provenance. */
  readonly query: QueryPlan;
}

export type AgentSkipReason =
  | 'already-known'
  | 'needs-approval'
  | 'max-jobs'
  | 'not-planned'
  | 'brain-declined';

export interface AgentSkip {
  readonly entity: EntityCandidate;
  readonly transform: TransformId;
  readonly reason: AgentSkipReason;
  readonly note: string;
}

/** What the agent saw before it planned a round — the "Observe" step, and the model's context. */
export interface AgentObservation {
  readonly round: number;
  readonly query: string;
  readonly frontier: readonly EntityCandidate[];
  /** Candidate steps per frontier entity, already filtered by mode, permissions and budget. */
  readonly candidates: readonly {
    readonly entity: EntityCandidate;
    readonly steps: readonly PlanStep[];
  }[];
  readonly known: number;
  readonly jobsLeft: number;
  readonly msLeft: number;
}

/**
 * The model's seat in the loop (§47). It receives the observation and returns the transforms it
 * wants, best first. It can only narrow: ids it did not see are dropped.
 */
export type AgentBrain = (
  observation: AgentObservation,
) => readonly TransformId[] | Promise<readonly TransformId[]>;

export interface AgentRound {
  readonly index: number;
  readonly observed: readonly EntityCandidate[];
  readonly tasks: readonly AgentTask[];
  readonly skipped: readonly AgentSkip[];
  /** Steps held back for the analyst's yes (§48 approval thresholds). */
  readonly awaitingApproval: readonly AgentSkip[];
  readonly jobs: number;
  readonly entitiesFound: number;
  readonly newEntities: number;
  /** One line for the activity feed: what this round did and whether it was worth it. */
  readonly headline: string;
}

export type AgentStopReason =
  | 'no-new-value'
  | 'max-depth'
  | 'max-jobs'
  | 'timeout'
  | 'nothing-to-do'
  | 'awaiting-approval';

export interface AgentSession {
  readonly query: string;
  readonly rounds: readonly AgentRound[];
  readonly stop: AgentStopReason;
  /** A sentence an analyst can read, always populated. */
  readonly note: string;
  readonly jobs: number;
  readonly elapsedMs: number;
  /** Everything collected this session, deduped by the resolver's identity key. */
  readonly entities: readonly ResolvedEntity[];
}

export interface AgentDeps {
  readonly registry: TransformRegistry;
  /** Mode, configured providers and granted permissions: the §48 permission boundary. */
  readonly ctx: Omit<PlannerContext, 'budget' | 'costCeiling'>;
  readonly seed: string;
  /** Runs one task. Normally `runPlan(query, deps)`; injected so the loop stays pure. */
  execute(task: AgentTask): Promise<InvestigationResult>;
  readonly guardrails?: Partial<AgentGuardrails>;
  readonly memory?: AgentMemory;
  readonly brain?: AgentBrain;
  /** Asked when a step crosses an approval threshold; the returned ids are the ones allowed. */
  approve?(requests: readonly AgentSkip[]): Promise<readonly TransformId[]>;
  readonly now?: () => number;
}

const needsApproval = (
  deps: AgentDeps,
  guardrails: AgentGuardrails,
  step: PlanStep,
): string | undefined => {
  if (step.maxResults > guardrails.approveAboveNewNodes) {
    return `could add up to ${String(step.maxResults)} nodes`;
  }
  if (!guardrails.approveCredentialed) return undefined;
  const manifest = deps.registry.transform(step.transform);
  if (!manifest) return undefined;
  const routed = routeTransform(deps.registry, manifest, deps.ctx);
  const provider = routed.chain[0]?.provider;
  return provider?.credentials === 'required' ? `spends the ${provider.id} credential` : undefined;
};

const candidateSteps = (
  deps: AgentDeps,
  guardrails: AgentGuardrails,
  entity: EntityCandidate,
): { readonly steps: readonly PlanStep[]; readonly hidden: QueryPlan['hidden'] } => {
  const plan = expand(
    deps.registry,
    entity.kind,
    {
      ...deps.ctx,
      budget: guardrails.budget,
      ...(guardrails.costCeiling === undefined ? {} : { costCeiling: guardrails.costCeiling }),
    },
    1,
  );
  return { steps: plan.steps, hidden: groupExclusions(plan) };
};

const asCandidate = (entity: ResolvedEntity): EntityCandidate => ({
  kind: entity.kind,
  value: entity.value,
  confidence: entity.confidence,
  why: 'found by an earlier step in this session',
});

/** Best-first: high-confidence entities are the ones worth another hop. */
const frontierOf = (
  entities: readonly ResolvedEntity[],
  limit: number,
): readonly EntityCandidate[] =>
  entities
    .filter((entity) => !entity.seed)
    .map(asCandidate)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);

const headlineFor = (round: Omit<AgentRound, 'headline'>): string => {
  if (round.tasks.length === 0) return 'nothing left to run';
  const parts = [
    `${String(round.jobs)} step${round.jobs === 1 ? '' : 's'} on ${String(round.observed.length)} entit${round.observed.length === 1 ? 'y' : 'ies'}`,
    `${String(round.newEntities)} new of ${String(round.entitiesFound)} found`,
  ];
  if (round.awaitingApproval.length > 0) {
    parts.push(`${String(round.awaitingApproval.length)} waiting for approval`);
  }
  return parts.join(', ');
};

const STOP_NOTES: Readonly<Record<AgentStopReason, string>> = {
  'no-new-value': 'stopped because the last round added nothing the graph did not already have',
  'max-depth': 'stopped at the depth limit',
  'max-jobs': 'stopped at the job limit',
  timeout: 'stopped at the time limit',
  'nothing-to-do': 'stopped because there was nothing left to run',
  'awaiting-approval': 'paused: every remaining step needs your approval',
};

/**
 * §49: the loop. Each round observes the frontier, plans within the guardrails, executes the tasks
 * in parallel (they are independent by construction — one seed entity each), collects into memory,
 * evaluates what was actually new and decides whether another round is worth it.
 */
export const runAgent = async (deps: AgentDeps): Promise<AgentSession> => {
  const guardrails: AgentGuardrails = { ...DEFAULT_GUARDRAILS, ...deps.guardrails };
  const memory = deps.memory ?? createAgentMemory();
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const rounds: AgentRound[] = [];
  const collected = new Map<string, ResolvedEntity>();
  let jobs = 0;

  const seedCandidate = [...typeQuery(deps.seed)].sort((a, b) => b.confidence - a.confidence)[0];
  let frontier: readonly EntityCandidate[] =
    seedCandidate === undefined ? [] : [seedCandidate].slice(0, guardrails.maxEntitiesPerRound);

  const finish = (stop: AgentStopReason): AgentSession => ({
    query: deps.seed,
    rounds,
    stop,
    note: STOP_NOTES[stop],
    jobs,
    elapsedMs: now() - startedAt,
    entities: [...collected.values()],
  });

  for (let index = 1; ; index += 1) {
    if (frontier.length === 0) return finish('nothing-to-do');
    if (index > guardrails.maxDepth) return finish('max-depth');
    if (now() - startedAt >= guardrails.maxRuntimeMs) return finish('timeout');
    if (jobs >= guardrails.maxJobs) return finish('max-jobs');

    // ── Observe ──────────────────────────────────────────────────────────────────────────────
    const candidates = frontier.map((entity) => ({
      entity,
      steps: candidateSteps(deps, guardrails, entity).steps,
    }));
    const observation: AgentObservation = {
      round: index,
      query: deps.seed,
      frontier,
      candidates,
      known: memory.known,
      jobsLeft: guardrails.maxJobs - jobs,
      msLeft: Math.max(0, guardrails.maxRuntimeMs - (now() - startedAt)),
    };

    // ── Plan ─────────────────────────────────────────────────────────────────────────────────
    const offered = new Set(
      candidates.flatMap((entry) => entry.steps.map((step) => step.transform)),
    );
    const wanted = deps.brain
      ? new Set((await deps.brain(observation)).filter((id) => offered.has(id)))
      : offered;

    const skipped: AgentSkip[] = [];
    const pending: AgentSkip[] = [];
    const chosenPerEntity = new Map<EntityCandidate, PlanStep[]>();
    let budgetedJobs = jobs;

    const take = (entity: EntityCandidate, step: PlanStep): void => {
      const chosen = chosenPerEntity.get(entity) ?? [];
      chosen.push(step);
      chosenPerEntity.set(entity, chosen);
      budgetedJobs += 1;
    };

    for (const { entity, steps } of candidates) {
      for (const step of steps) {
        const skip = (reason: AgentSkipReason, note: string): void => {
          skipped.push({ entity, transform: step.transform, reason, note });
        };
        if (!wanted.has(step.transform)) {
          skip('brain-declined', 'the orchestrator did not pick this step for this round');
          continue;
        }
        if (memory.didRun(step.transform, entity.kind, entity.value)) {
          skip('already-known', `${step.transform} already ran against ${entity.value}`);
          continue;
        }
        if (budgetedJobs >= guardrails.maxJobs) {
          skip('max-jobs', `the session's job limit (${String(guardrails.maxJobs)}) is reached`);
          continue;
        }
        const approval = needsApproval(deps, guardrails, step);
        if (approval !== undefined) {
          pending.push({
            entity,
            transform: step.transform,
            reason: 'needs-approval',
            note: approval,
          });
          continue;
        }
        take(entity, step);
      }
    }

    // One approval question per round, for everything that crossed a threshold (§48). Without an
    // `approve` handler the answer is no: an unattended agent never spends what it must ask about.
    const granted =
      pending.length > 0 && deps.approve ? new Set(await deps.approve(pending)) : new Set<string>();
    const awaitingApproval = pending.filter((request) => !granted.has(request.transform));
    for (const request of pending.filter((entry) => granted.has(entry.transform))) {
      if (budgetedJobs >= guardrails.maxJobs) {
        skipped.push({
          ...request,
          reason: 'max-jobs',
          note: "the session's job limit is reached",
        });
        continue;
      }
      const step = candidates
        .find((entry) => entry.entity === request.entity)
        ?.steps.find((entry) => entry.transform === request.transform);
      if (step) take(request.entity, step);
    }

    const tasks: AgentTask[] = [...chosenPerEntity].map(([entity, steps]) => {
      const plan = {
        steps,
        estimate: {
          runtimeMs: steps.reduce((total, step) => total + step.estimatedRuntimeMs, 0),
          minEntities: steps.length,
          maxEntities: Math.min(
            steps.reduce((total, step) => total + step.maxResults, 0),
            guardrails.budget.maxNewNodes,
          ),
        },
        requiresNetwork: true,
        providersUsed: [] as readonly string[],
        credentialsNeeded: [] as readonly string[],
        excluded: [],
      };
      return {
        entity,
        steps,
        query: {
          input: entity.value,
          candidates: [entity],
          chosen: entity,
          ambiguous: false,
          plan,
          hidden: groupExclusions(plan),
        },
      };
    });

    if (tasks.length === 0) {
      const stop: AgentStopReason =
        awaitingApproval.length > 0 ? 'awaiting-approval' : 'nothing-to-do';
      rounds.push({
        index,
        observed: frontier,
        tasks: [],
        skipped,
        awaitingApproval,
        jobs: 0,
        entitiesFound: 0,
        newEntities: 0,
        headline: awaitingApproval.length > 0 ? 'waiting for your approval' : 'nothing left to run',
      });
      return finish(stop);
    }

    // ── Execute (independent tasks in parallel) ──────────────────────────────────────────────
    for (const task of tasks) {
      for (const step of task.steps) {
        memory.recordRun(step.transform, task.entity.kind, task.entity.value);
      }
    }
    const results = await Promise.all(tasks.map(async (task) => deps.execute(task)));
    jobs = budgetedJobs;

    // ── Collect + Evaluate ───────────────────────────────────────────────────────────────────
    const found = results.flatMap((result) => result.entities);
    const fresh = found.filter((entity) => !memory.knows(entity.kind, entity.value));
    for (const entity of found) collected.set(entityKey(entity.kind, entity.value), entity);
    memory.learn(found);

    const round: Omit<AgentRound, 'headline'> = {
      index,
      observed: frontier,
      tasks,
      skipped,
      awaitingApproval,
      jobs: tasks.reduce((total, task) => total + task.steps.length, 0),
      entitiesFound: found.length,
      newEntities: fresh.length,
    };
    rounds.push({ ...round, headline: headlineFor(round) });

    // ── Decide ───────────────────────────────────────────────────────────────────────────────
    if (fresh.length < guardrails.minNewEntities) return finish('no-new-value');
    frontier = frontierOf(fresh, guardrails.maxEntitiesPerRound);
  }
};
