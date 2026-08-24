# 29 — Service Orchestration (Part 2 §11–§14)

Status: implemented in `packages/query-engine` (`schedule.ts`, `executor.ts`) and surfaced in
`apps/web/src/query`. This document states the contract; the code is the source of truth.

## §11 Universal Orchestrator

One question produces one plan, and the plan is executed by a single orchestrator that owns every
service call in the run:

```
query
  ↓ typing + routing (selectors.ts, plan.ts)
Universal Orchestrator (executor.ts)
  ↓ ↓ ↓        services run as adapters, never as imports
engine A   engine B   engine C
  ↓ ↓ ↓
Result Normalizer  (normalize.ts — canonical values per entity kind)
  ↓
Entity Resolver    (resolve.ts — dedupe by kind+value, merge provenance)
  ↓
Relationship Engine(resolve.ts — typed edges with evidence)
  ↓
Investigation graph → proposal (never written to the board automatically, invariant N4/U7)
```

Rules that do not bend:

- Services are injected through `EngineLibrary`; the orchestrator has no adapter imports (R1).
- Every service call is host-proxied (`HostFetch`): SSRF guard, size cap, no socket in an engine.
- A dead service degrades the answer; it never fails the run (U5).
- Every produced entity carries run, engine, provider, input and observation time (U6).

## §12 Parallel execution

Independent nodes start together, bounded only by `budget.maxParallel`. There is no stage barrier:
the previous depth-layer scheduler made a fast branch wait for the slowest step of the layer above
it, which is exactly the `A → wait → B → wait → C` shape Part 2 forbids.

```
A ─┐
B ─┼→ aggregator (single graph builder, single event stream)
C ─┘
```

## §13 Dependency-aware execution (DAG)

`buildDag(steps)` converts `PlanStep.dependsOn` into an execution graph:

- roots = steps with no in-plan dependency → runnable at t0;
- `rank` = longest dependency chain ending at the node (reporting only, never a gate);
- `depth` = sequential hops the plan forces; `width` = best available parallelism;
- edges to absent steps are dropped with a warning, cycles are broken with a warning — a planner
  bug must never produce a run that hangs.

`createScheduler(dag)` is the ready-queue: a node unlocks the instant **its own** predecessors
settle. A failed predecessor also unlocks its dependents — a downstream step with no usable input
skips itself cheaply and visibly instead of vanishing from the plan. Nodes that never became
runnable are reported as `never reached: …` in the run warnings.

## §14 Single result stream

`executePlan` is one async generator for the whole run. Events:

| event                                        | meaning                                                  |
| -------------------------------------------- | -------------------------------------------------------- |
| `plan.started`                               | run accepted, counts announced                           |
| `plan.graph`                                 | the scheduled DAG (nodes, dependsOn, rank, depth, width) |
| `stage.started`                              | first node of a rank began                               |
| `step.started`                               | a service started, with the engine actually chosen       |
| `step.progress`                              | 0..1 inside one step, plus results produced so far       |
| `entity.found` / `relation.found`            | streamed as they resolve                                 |
| `step.done` / `step.failed` / `step.skipped` | terminal per step, with the run record                   |
| `run.progress`                               | whole-run fraction, settled/planned, in-flight count     |
| `plan.done`                                  | run summary (status, counts, warnings)                   |

The analyst does not wait for the run to finish: entities land on the panel as they resolve, and
each service shows its own bar.

```
Sherlock       ██████████ 100%
Certificates   ███████░░░  72%
GitHub         ██████████ 100%
Web research   █████░░░░░  52%
```

`useQueryRun` folds the stream into a render snapshot: per-step state (`queued → running →
done|failed|skipped`), a monotonic per-step fraction, whole-run `progress`, and `inFlight` — the
visible proof that independent services really are running at the same time.

## Not yet done

- Progress is step-granular; a long-running single engine reports 0 → 1 with nothing in between
  until adapters emit their own heartbeats (`runner` protocol change).
- Cross-run orchestration (queueing several investigations) lives in `apps/worker` and is unbuilt.
