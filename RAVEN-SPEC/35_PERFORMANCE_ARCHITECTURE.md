# Raven — 35 — PERFORMANCE ARCHITECTURE (§65)

## Scope

How a query stays fast when the catalogue grows: which engines a run actually starts, how many of
them run at once, who waits for whom, what is cached, and what happens when a consumer reads events
slower than the run produces them.

This is the **backend/orchestration** half of performance. The canvas half — frame budgets, the
`bench/` harness, the ±5 % CI regression gate — is `16_PERFORMANCE.md` and is not restated here.
Admission control (host CPU/RAM/process ceilings) is `resources.ts`, specified in Part 2 §32;
metrics that measure any of this are `34_OBSERVABILITY.md`.

**The principle** (§65): _do not start a hundred engines because a hundred engines exist._ A plan is
a decision about where the next sixty seconds go.

---

## 1. The pipeline, and where each control sits

| Stage              | File                             | Control                                                         |
| ------------------ | -------------------------------- | --------------------------------------------------------------- |
| Type the input     | `query-engine/src/selectors.ts`  | one entity kind → only transforms that accept it                |
| Plan capabilities  | `transforms/src/plan.ts`         | mode, credentials, permissions, `Budget`, cost gate             |
| **Select engines** | `query-engine/src/prioritise.ts` | **§65 — price each step, keep what earns its slot**             |
| Order the work     | `query-engine/src/schedule.ts`   | DAG, not stage barriers: a step starts when its own deps settle |
| Admit the work     | `query-engine/src/resources.ts`  | host CPU / RAM / disk / process ceilings (Part 2 §32)           |
| **Pace providers** | `query-engine/src/pace.ts`       | **§65 — per-provider interval and daily quota**                 |
| Execute            | `query-engine/src/executor.ts`   | `maxParallel` slots, per-step deadline, cache, backpressure     |
| Queue across runs  | `apps/worker`, BullMQ            | concurrency per queue, retries, queue-depth metric              |

## 2. Engine selection (`prioritise.ts`)

Each planned step is priced:

```
score = maxResults × priorityWeight(transform.priority) × (1 / depth) ÷ estimatedSeconds
```

- `priorityWeight`: core 1.0, recommended 0.8, optional 0.5, experimental/external 0.3, deprecated 0.
- `1 / depth` damps steps that fire on entities an earlier step may never produce.
- Steps are admitted best-first under three ceilings: `maxSteps` (12), `maxRuntimeMs` (60 s,
  projected layer by layer at `maxParallel`), and a `minScore` floor (0.05 results/s).
- A step is admitted **together with the ancestors it consumes**; if the bundle does not fit, the
  step waits for another run. A plan never contains a step whose dependency will not run.
- Every drop is reported as a normal `PlanExclusion` — `cost-not-justified` or
  `over-resource-budget`, with a note — so the existing "12 hidden: 7 need a key" UI renders it
  without changes. Nothing is dropped silently.

Selection is pure: no clock, no network, no execution. `prioritise(registry, plannedQuery)` returns
a narrowed `QueryPlan` that the executor takes unchanged.

## 3. Provider pacing (`pace.ts`)

`maxParallel` bounds our box; it knows nothing about the provider's limit. The pacer reads
`ProviderManifest.limits`:

- `requestsPerMinute` → a minimum interval between two calls to that provider, shared by every step
  in the process. A single wait is capped (default 30 s) so one strict provider cannot stall a run;
  the run's own wall-clock budget is what ends a run that has waited too long.
- `requestsPerDay` → a refusal, not a queue. The step is skipped with `provider-rate-limited` and a
  warning an analyst can read (U5); it never becomes a mystery failure.

The pacer is injected (`ExecuteDeps.pacer`), like `resources`: a host that runs one query at a time
can omit it. `apps/runner` installs one per process.

## 4. Parallelism, caching, streaming, backpressure

- **Parallelism**: `Budget.maxParallel` (default 4) slots, filled from the DAG ready-queue, not from
  a stage barrier. Wider plans do not get faster than the box; they get more evenly loaded.
- **Caching**: `ResultCache` (transform layer §10) is consulted per (transform, engine, provider,
  canonical input); a hit is labelled `cached` in provenance and costs no slot and no quota.
- **Streaming**: results reach the UI as `QueryEvent`s while the run continues; nothing waits for
  the last engine.
- **Backpressure**: the executor's event channel has a high-water mark (256 events, overridable via
  `ExecuteDeps.eventHighWater`). Above it the driver stops scheduling new steps until the consumer
  catches up. The wait happens **before** scheduling, never between checking in-flight work and
  racing it — an empty `Promise.race` never settles, which is exactly how this was got wrong first.

## 5. What is not built (honest gaps)

- **No cross-run scheduler.** Selection ceilings are per run. Ten concurrent runs can each admit 12
  steps; only `resources.ts` and BullMQ concurrency stand between that and the box.
- **No adaptive scoring.** Weights are static: the pricing does not learn from how much a transform
  actually yielded last week. `health.ts` tracks failures but does not feed selection yet.
- **No pacer persistence.** Intervals and daily counters live in process memory, so two runner
  processes each keep their own budget for the same provider.
- **No benchmark for the orchestration path.** `16_PERFORMANCE.md` §4 gates canvas frames; there is
  no equivalent harness asserting plan-throughput at 10/100/1000 concurrent runs (§74 asks for it).
- **`resources.ts` measures nothing.** Its ceilings are declared, not read from the host
  (`scripts/survey-host.sh` still unwritten — `HIDDEN_CLOUD_DEPLOYMENT.md` §16).
