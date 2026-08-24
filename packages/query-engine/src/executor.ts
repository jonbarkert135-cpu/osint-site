/**
 * Plan execution (24_UNIFIED_QUERY.md §6). The planner says what would run; this runs it.
 *
 * Contracts it keeps, because each one is a promise the product makes to an analyst:
 *  - **U5 partial beats perfect** — a dead engine degrades the answer, it never fails the query.
 *  - **U4 nothing runs without a budget** — node, transform and wall-clock ceilings are enforced
 *    here, and exhausting one ends the run as `partial` with everything already produced kept.
 *  - **U6 provenance is mandatory** — every entity carries the run, engine, provider and input it
 *    came from, and a cached answer is labelled as cached.
 *  - **U7 propose, never commit** — the result is a graph object. Landing it on a board is the
 *    caller's decision, made through the normal proposal path.
 *
 * Engines are injected (`EngineLibrary`), never imported: this package must not depend on adapters.
 */

import {
  runEngine,
  type EngineId,
  type EntityKind,
  type ExecutionMode,
  type HostFetch,
  type PlanStep,
  type ProviderId,
  type ResultCache,
  type RunEntity,
  type RunRecord,
  type RunStatus,
  type TransformEngine,
  type TransformManifest,
  type TransformRegistry,
  type Budget,
  type RunOutcome,
} from '@nexus/transforms';

import type {
  InvestigationResult,
  QueryEvent,
  RunOutcomeStatus,
  RunSummary,
  StepRef,
} from './events.ts';
import type { QueryPlan } from './plan.ts';
import { canonicalValue } from './normalize.ts';
import { createGraphBuilder, type Provenance, type ResolvedEntity } from './resolve.ts';
import { buildDag, createScheduler } from './schedule.ts';

export interface EngineLibrary {
  get(id: EngineId): TransformEngine | undefined;
}

export const createEngineLibrary = (
  factories: Readonly<Record<EngineId, () => TransformEngine>>,
): EngineLibrary => ({
  get: (id) => factories[id]?.(),
});

export interface ExecuteDeps {
  readonly registry: TransformRegistry;
  readonly engines: EngineLibrary;
  readonly mode: ExecutionMode;
  /** Host-proxied fetch (SSRF guard, size cap). Engines never open a socket themselves. */
  readonly fetch: HostFetch;
  /** Vault lookup. Secrets never enter plans, events, run history or cache keys (§9). */
  readonly credential?: (provider: ProviderId, key: string) => string | undefined;
  readonly cache?: ResultCache;
  readonly now?: () => number;
  /** The analyst pressed Stop. Cancellation is cooperative and immediate (§6.3). */
  readonly signal?: AbortSignal;
  readonly runId?: () => string;
  /** Overrides the plan's budget; the plan's own budget is used otherwise. */
  readonly budget?: Budget;
}

const DEFAULT_BUDGET: Budget = {
  maxNewNodes: 250,
  maxDepth: 2,
  maxRuntimeMs: 60_000,
  maxParallel: 4,
  maxTransforms: 12,
};

/** An engine that overruns its own estimate this far is stuck, not slow. */
const DEADLINE_SLACK = 3;
const MIN_DEADLINE_MS = 5_000;

const deadlineFor = (transform: TransformManifest): number =>
  Math.max(MIN_DEADLINE_MS, transform.limits.expectedRuntimeMs * DEADLINE_SLACK);

interface StepInput {
  readonly kind: EntityKind;
  readonly value: string;
  readonly entityId: string;
}

/** A queue one producer writes and one consumer drains — the seam between concurrency and a generator. */
const createChannel = <T>() => {
  const buffer: T[] = [];
  let notify: (() => void) | undefined;
  let closed = false;
  return {
    push: (item: T): void => {
      buffer.push(item);
      notify?.();
    },
    close: (): void => {
      closed = true;
      notify?.();
    },
    async *drain(): AsyncGenerator<T> {
      for (;;) {
        while (buffer.length > 0) yield buffer.shift() as T;
        if (closed) return;
        await new Promise<void>((resolve) => {
          notify = () => {
            notify = undefined;
            resolve();
          };
        });
      }
    },
  };
};

const runEntities = (entities: readonly ResolvedEntity[]): readonly RunEntity[] =>
  entities.map((entity) => ({
    kind: entity.kind,
    value: entity.value,
    confidence: entity.confidence,
    evidence: entity.sources.flatMap((source) => source.evidence),
  }));

const statusOf = (outcome: RunOutcome): RunStatus => {
  switch (outcome.status) {
    case 'completed':
      return outcome.truncated ? 'partial' : 'completed';
    case 'partial':
      return 'partial';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'failed';
  }
};

/**
 * Runs one plan and streams what happens. The generator yields `QueryEvent`s as they occur and
 * returns the investigation graph; a caller that only wants the graph can `for await` and keep the
 * return value.
 */
export async function* executePlan(
  query: QueryPlan,
  deps: ExecuteDeps,
): AsyncGenerator<QueryEvent, InvestigationResult> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const budget = deps.budget ?? DEFAULT_BUDGET;
  const builder = createGraphBuilder();
  const runs: RunRecord[] = [];
  const provenance: Provenance[] = [];
  const warnings: string[] = [];
  let sequence = 0;
  const nextRunId = deps.runId ?? (() => `run-${String(++sequence)}`);

  let completed = 0;
  let failed = 0;
  let skipped = 0;
  let cacheHits = 0;
  let cancelled = deps.signal?.aborted === true;
  let budgetExhausted = false;

  const stages = [...new Set((query.plan?.steps ?? []).map((step) => step.depth))].sort(
    (a, b) => a - b,
  );
  const plannedSteps = query.plan?.steps.length ?? 0;

  const summarize = (): RunSummary => {
    const entities = builder.entities;
    const status: RunOutcomeStatus = cancelled
      ? 'cancelled'
      : budgetExhausted
        ? 'partial'
        : completed === 0 && failed > 0
          ? 'degraded'
          : plannedSteps === 0
            ? 'failed'
            : failed > 0
              ? 'degraded'
              : 'completed';
    return {
      status,
      startedAt,
      finishedAt: now(),
      stepsPlanned: plannedSteps,
      stepsCompleted: completed,
      stepsFailed: failed,
      stepsSkipped: skipped,
      cacheHits,
      entities: entities.length,
      relations: builder.relations.length,
      warnings,
    };
  };

  const result = (): InvestigationResult => ({
    summary: summarize(),
    entities: builder.entities,
    relations: builder.relations,
    runs,
    provenance,
  });

  if (query.chosen === undefined || query.plan === undefined || plannedSteps === 0) {
    warnings.push(
      query.chosen === undefined
        ? 'the input did not type to anything routable'
        : 'the plan has no executable step under the current mode',
    );
    const summary = summarize();
    yield { type: 'plan.done', result: summary };
    return result();
  }

  const seedProvenance: Provenance = {
    runId: 'seed',
    transform: 'query.intake',
    engine: 'intake',
    provider: 'local-runtime',
    input: { kind: query.chosen.kind, value: query.chosen.value },
    observedAt: new Date(startedAt).toISOString(),
    cached: false,
    confidence: query.chosen.confidence,
    evidence: [query.chosen.why],
  };
  provenance.push(seedProvenance);
  const seedId = builder.seed(query.chosen.kind, query.chosen.value, seedProvenance);

  yield { type: 'plan.started', stages: stages.length, steps: plannedSteps };

  /** Which entity ids a transform has already consumed: a re-run on the same input is waste. */
  const consumed = new Map<string, Set<string>>();

  const inputsFor = (step: PlanStep, transform: TransformManifest): readonly StepInput[] => {
    if (step.depth <= 1) {
      return [{ kind: query.chosen!.kind, value: query.chosen!.value, entityId: seedId }];
    }
    const used = consumed.get(step.transform) ?? new Set<string>();
    const capacity = Math.max(1, Math.min(transform.limits.maxInputBatch, budget.maxParallel));
    return builder
      .byKind(step.inputKind)
      .filter((entity) => !entity.seed && !used.has(entity.id))
      .slice(0, capacity)
      .map((entity) => ({ kind: entity.kind, value: entity.value, entityId: entity.id }));
  };

  const executableChain = (step: PlanStep): readonly EngineId[] =>
    step.chain.filter((engineId) => deps.registry.engine(engineId)?.terminal === false);

  const runOneStep = async (
    step: PlanStep,
    transform: TransformManifest,
    input: StepInput,
    emit: (event: QueryEvent) => void,
  ): Promise<void> => {
    const ref: StepRef = {
      transform: step.transform,
      stage: step.depth,
      input: { kind: input.kind, value: input.value },
    };
    const chain = executableChain(step);
    if (chain.length === 0) {
      skipped += 1;
      emit({ type: 'step.skipped', step: ref, reason: 'no-engine' });
      return;
    }

    for (const [index, engineId] of chain.entries()) {
      if (deps.signal?.aborted === true) {
        cancelled = true;
        return;
      }
      const manifest = deps.registry.engine(engineId);
      const engine = deps.engines.get(engineId);
      const provider = manifest ? deps.registry.provider(manifest.provider) : undefined;
      if (!manifest || !provider || !engine) {
        // Declared in the catalogue but not installed in this build: try the next link.
        if (index === chain.length - 1) {
          skipped += 1;
          emit({ type: 'step.skipped', step: ref, reason: 'engine-unavailable' });
        }
        continue;
      }

      emit({ type: 'step.started', step: ref, engine: engineId });
      const runId = nextRunId();
      const runInput = { kind: input.kind, value: canonicalValue(input.kind, input.value) };
      const subject = { transform, engine: manifest, provider, input: runInput };
      const startedStep = now();

      const hit = deps.cache?.get(subject, startedStep);
      if (hit) {
        cacheHits += 1;
        const source: Provenance = {
          runId,
          transform: transform.id,
          engine: engineId,
          provider: provider.id,
          input: runInput,
          observedAt: new Date(hit.entry.storedAt).toISOString(),
          cached: true,
          confidence: 0,
          evidence: [`cached ${hit.ageLabel}`],
        };
        for (const cachedEntity of hit.entry.results) {
          const created = builder.absorb(
            input.entityId,
            {
              entities: [
                {
                  key: `${cachedEntity.kind}:${cachedEntity.value}`,
                  kind: cachedEntity.kind,
                  value: cachedEntity.value,
                  confidence: cachedEntity.confidence,
                },
              ],
              relationships: [],
              evidence: [],
            },
            { ...source, confidence: cachedEntity.confidence, evidence: cachedEntity.evidence },
          );
          for (const entity of created) emit({ type: 'entity.found', step: ref, entity });
        }
        provenance.push(source);
        const record: RunRecord = {
          id: runId,
          transform: transform.id,
          transformVersion: transform.version,
          input: runInput,
          engine: engineId,
          engineVersion: manifest.version,
          provider: provider.id,
          mode: deps.mode,
          startedAt: startedStep,
          finishedAt: now(),
          status: 'completed',
          results: hit.entry.results,
          errors: [],
        };
        runs.push(record);
        completed += 1;
        emit({
          type: 'step.done',
          step: ref,
          engine: engineId,
          status: 'completed',
          produced: hit.entry.results.length,
          cached: true,
          run: record,
        });
        return;
      }

      const outcome = await runEngine(engine, {
        input: { kind: input.kind, value: runInput.value, entityId: input.entityId },
        mode: deps.mode,
        maxResults: Math.min(
          step.maxResults,
          Math.max(0, budget.maxNewNodes - builder.entities.length),
        ),
        deadlineMs: deadlineFor(transform),
        fetch: deps.fetch,
        ...(deps.credential
          ? { credential: (key: string) => deps.credential?.(provider.id, key) }
          : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
        now,
      });

      const status = statusOf(outcome);
      const source: Provenance = {
        runId,
        transform: transform.id,
        engine: engineId,
        provider: provider.id,
        input: runInput,
        observedAt: new Date(startedStep).toISOString(),
        cached: false,
        confidence: 0,
        evidence: [],
      };
      const created = builder.absorb(
        input.entityId,
        {
          entities: outcome.entities,
          relationships: outcome.relationships,
          evidence: outcome.evidence,
        },
        source,
      );
      provenance.push(source);
      for (const entity of created) emit({ type: 'entity.found', step: ref, entity });
      for (const relation of builder.relations) {
        if (relation.sources.some((item) => item.runId === runId)) {
          emit({ type: 'relation.found', step: ref, relation });
        }
      }

      const record: RunRecord = {
        id: runId,
        transform: transform.id,
        transformVersion: transform.version,
        input: runInput,
        engine: engineId,
        engineVersion: manifest.version,
        provider: provider.id,
        mode: deps.mode,
        startedAt: startedStep,
        finishedAt: now(),
        status,
        results: runEntities(created),
        errors: outcome.failure ? [outcome.failure.message] : [...outcome.violations],
      };
      runs.push(record);

      if (outcome.status === 'cancelled') {
        cancelled = true;
        emit({
          type: 'step.done',
          step: ref,
          engine: engineId,
          status,
          produced: created.length,
          cached: false,
          run: record,
        });
        return;
      }

      if (status === 'failed') {
        failed += 1;
        const fallback = index < chain.length - 1;
        emit({
          type: 'step.failed',
          step: ref,
          engine: engineId,
          message:
            outcome.failure?.message ??
            outcome.violations[0] ??
            'the engine produced nothing usable',
          fallback,
        });
        if (fallback) continue;
        warnings.push(`${transform.id}: ${outcome.failure?.message ?? 'failed'}`);
        return;
      }

      completed += 1;
      deps.cache?.set(subject, runEntities(created), runId, now());
      emit({
        type: 'step.done',
        step: ref,
        engine: engineId,
        status,
        produced: created.length,
        cached: false,
        run: record,
      });

      // An empty answer from a source that admits it may not have seen everything is a reason to
      // ask the next source, not a result (21_TRANSFORM_SYSTEM.md §5).
      if (outcome.entities.length === 0 && !outcome.exhaustive && index < chain.length - 1)
        continue;
      return;
    }
  };

  const dag = buildDag(query.plan.steps);
  warnings.push(...dag.warnings);
  yield {
    type: 'plan.graph',
    nodes: [...dag.nodes.values()].map((node) => ({
      transform: node.step.transform,
      dependsOn: node.dependsOn,
      rank: node.rank,
    })),
    depth: dag.depth,
    width: dag.width,
    warnings: dag.warnings,
  };

  const scheduler = createScheduler(dag);
  const channel = createChannel<QueryEvent>();
  const emit = (event: QueryEvent): void => channel.push(event);
  const announcedRanks = new Set<number>();
  let settledNodes = 0;

  const emitRunProgress = (): void => {
    const planned = dag.nodes.size;
    emit({
      type: 'run.progress',
      fraction: planned === 0 ? 1 : Math.min(1, settledNodes / planned),
      settled: settledNodes,
      planned,
      inFlight: scheduler.inFlight(),
      entities: builder.entities.length,
    });
  };

  const overBudget = (): boolean => {
    if (builder.entities.length >= budget.maxNewNodes || now() - startedAt > budget.maxRuntimeMs) {
      budgetExhausted = true;
      return true;
    }
    return false;
  };

  /** Runs one DAG node: its inputs share the node, so they are executed in order inside it. */
  const runNode = async (id: string): Promise<void> => {
    const node = dag.nodes.get(id);
    if (!node) return;
    const step = node.step;
    const ranked = node.rank;
    if (!announcedRanks.has(ranked)) {
      announcedRanks.add(ranked);
      const peers = [...dag.nodes.values()].filter((other) => other.rank === ranked).length;
      emit({ type: 'stage.started', stage: step.depth, steps: peers });
    }

    const transform = deps.registry.transform(step.transform);
    if (!transform) return;
    const inputs = inputsFor(step, transform);
    const ref = (value: string): StepRef => ({
      transform: step.transform,
      stage: step.depth,
      input: { kind: step.inputKind, value },
    });
    if (inputs.length === 0) {
      skipped += 1;
      emit({ type: 'step.skipped', step: ref(''), reason: 'already-covered' });
      return;
    }

    const used = consumed.get(step.transform) ?? new Set<string>();
    for (const input of inputs) used.add(input.entityId);
    consumed.set(step.transform, used);

    emit({ type: 'step.progress', step: ref(inputs[0]?.value ?? ''), fraction: 0, produced: 0 });
    const before = builder.entities.length;
    for (const [index, input] of inputs.entries()) {
      if (cancelled || overBudget()) return;
      await runOneStep(step, transform, input, emit);
      emit({
        type: 'step.progress',
        step: ref(input.value),
        fraction: (index + 1) / inputs.length,
        produced: builder.entities.length - before,
      });
    }
  };

  // Dependency-aware, not stage-gated: a node starts the moment its own predecessors settle, so
  // independent branches never wait behind a slow neighbour (Part 2 §12–§13).
  const drive = async (): Promise<void> => {
    const inFlight = new Set<Promise<void>>();
    const ceiling = Math.max(1, budget.maxParallel);
    for (;;) {
      if (cancelled || deps.signal?.aborted === true) {
        cancelled = true;
        break;
      }
      if (budgetExhausted) break;
      const batch = scheduler.take(ceiling - inFlight.size);
      for (const id of batch) {
        const task = runNode(id)
          .catch((cause: unknown) => {
            failed += 1;
            warnings.push(`${id}: ${cause instanceof Error ? cause.message : 'step crashed'}`);
          })
          .finally(() => {
            scheduler.settle(id);
            settledNodes += 1;
            emitRunProgress();
            inFlight.delete(task);
          });
        inFlight.add(task);
      }
      if (inFlight.size === 0) {
        if (scheduler.finished() || scheduler.pending() === 0) break;
        continue;
      }
      await Promise.race(inFlight);
    }
    await Promise.allSettled([...inFlight]);
  };

  void drive().then(
    () => channel.close(),
    () => channel.close(),
  );

  for await (const event of channel.drain()) yield event;

  const stranded = scheduler.blocked();
  if (stranded.length > 0 && !cancelled && !budgetExhausted) {
    skipped += stranded.length;
    warnings.push(`never reached: ${stranded.join(', ')}`);
  }

  if (budgetExhausted)
    warnings.push('budget exhausted: the run stopped early and kept what it had');
  if (cancelled) warnings.push('cancelled by the analyst');

  const summary = summarize();
  yield { type: 'plan.done', result: summary };
  return { ...result(), summary };
}

/** Convenience for callers that do not stream: runs the plan and returns only the graph. */
export const runPlan = async (
  query: QueryPlan,
  deps: ExecuteDeps,
): Promise<InvestigationResult> => {
  const iterator = executePlan(query, deps);
  for (;;) {
    const step = await iterator.next();
    if (step.done === true) return step.value;
  }
};
