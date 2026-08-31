# 31 — Workflow editor and the Research Orchestrator Agent (Part 2 §45–§50)

Status: implemented 2026-08-31 in `packages/query-engine` (`builder.ts`, `agent.ts`) and
`apps/web/src/query` (`WorkflowPanel.tsx`, `workflowStore.ts`). This document states the contract and
the boundaries; the code is the source of truth, and where they disagree the code wins and this file
gets corrected in the same PR.

## §45 The workflow editor is the canvas, not a second engine

A workflow is assembled visually, with the same architecture as the board: nodes, arrows, hit-testing
in one place. So the editor ships as two pure functions plus a panel that draws them:

```
saved workflow ──layoutWorkflow()──►  positioned nodes + arrows  ──► the canvas draws it
                                              │ analyst edits
saved workflow ◄─graphToWorkflow()──  positioned nodes + arrows
```

`layoutWorkflow()` ranks each node by the longest path from the input, so a step never sits left of
something it consumes and independent branches share a column — the same reading the DAG scheduler
acts on (`schedule.ts`). `graphToWorkflow()` is the inverse and owns exactly one decision the drawing
forces: an `EditorGraph` is unordered (arrows are drawn in any order) while a `Workflow` is
declaration-ordered, so it topologically sorts and reports a cycle **as a cycle**. Everything else —
unknown transforms, illegal stage order, a missing input — stays `validateWorkflow`'s business, so
there is one rule set, not two.

The panel (`WorkflowPanel.tsx`, palette command _Workflows…_) draws nodes as buttons and arrows as an
SVG layer that is transparent to the pointer, selects a node, adds a transform step after it, removes
a node, names and saves. It contains no graph logic of its own.

## §46 Save and re-run

Saved workflows are local-first: `workflowStore.ts` keeps them in the browser, upserted by id, and
every entry is read back through `deserializeWorkflow` — a hand-edited or corrupted record is dropped
with the list intact, never loaded half-parsed. No account, no server (N2).

Re-running for a new input is `runWorkflow(registry, workflow, input, ctx)`. It compiles the saved
pipeline (§44) and produces the ordinary `QueryPlan`, so a workflow run **is** an ordinary orchestrated
run: DAG scheduling, budgets, the §42 cost gate, provenance, partial results, proposal review. The one
addition is a pin: the input node may declare the entity kind the pipeline was designed for
(`kind: 'username'`), and a re-run with something else is **refused, not coerced** — a saved username
pipeline pointed at `example.com` says so instead of running Sherlock on a domain.

## §47 The Research Orchestrator Agent

`runAgent()` receives the question, the available engines and their capabilities (the registry), the
results so far and the current graph (`AgentMemory`), the resource budget and the permission boundary
(`AgentGuardrails` + `PlannerContext`), and it decides what runs, in what order, what runs in
parallel, what deserves another hop, where to stop and what to show.

Two structural choices make that safe rather than impressive:

- **Execution is injected.** The agent decides; `executePlan` runs. That is why the whole loop is
  testable with no network, and why the agent cannot invent a call path around the host-proxied fetch,
  the cost gate or the resource manager.
- **A model may narrow, never widen.** The optional `brain` hook receives the observation — round,
  frontier, candidate steps the _planner_ already allowed, remaining jobs and time — and returns a
  subset. Ids it invents are dropped (`brain-declined` is recorded for what it dropped). The
  difference between a good model and a hallucinating one is therefore speed, not safety, and the
  agent works with no model configured at all (`14_AI_AGENT.md`'s keyless constraint).

Parallelism has two axes: tasks inside a round are independent by construction (one seed entity each)
and run together; inside a task the existing DAG scheduler runs what it can. Rounds are the only
sequential axis, because a second hop needs the first hop's results.

## §48 The agent is never unbounded

`AgentGuardrails`, declared before the session and enforced in `agent.ts` — not in a prompt:

| Guardrail           | Field                                                   | Default                    |
| ------------------- | ------------------------------------------------------- | -------------------------- |
| Max execution depth | `maxDepth`                                              | 2 hops                     |
| Max jobs            | `maxJobs`                                               | 12 steps                   |
| Timeout             | `maxRuntimeMs`                                          | 120 s                      |
| Resource budget     | `budget` (+ optional `costCeiling`)                     | `DEFAULT_BUDGET`           |
| Breadth per hop     | `maxEntitiesPerRound`                                   | 4 entities                 |
| Approval threshold  | `approveAboveNewNodes`                                  | > 100 new nodes            |
| Approval threshold  | `approveCredentialed`                                   | any stored credential      |
| Value floor         | `minNewEntities`                                        | 1 new entity               |
| Permission boundary | `ctx.mode`, `grantedPermissions`, `configuredProviders` | zero-credential in the app |

Approval is asked **once per round** for everything that crossed a threshold, and the default answer
is no: with no `approve` handler the session ends `awaiting-approval` having run nothing it had to ask
about. An unattended agent therefore cannot spend a credential or flood a board.

## §49 The loop

```
Observe   frontier entities + candidate steps + what is left of the budget
   ↓
Plan      drop what memory already answered, what the brain declined, what exceeds jobs;
          hold what crosses an approval threshold
   ↓
Execute   independent tasks in parallel, each through the normal executor
   ↓
Collect   merge into memory; entities are deduped by the resolver's identity key
   ↓
Evaluate  how many entities were genuinely new
   ↓
Decide    another round only if it is worth it
   ↓
Stop / Continue
```

Stop reasons are explicit and each carries a sentence for the analyst: `no-new-value` (the round
added nothing the graph did not already have), `max-depth`, `max-jobs`, `timeout`, `nothing-to-do`,
`awaiting-approval`. The interesting one is the first: an agent that keeps running tools because it
can is the failure mode this design exists to prevent.

Every round also produces a `headline` for the activity feed ("3 steps on 1 entity, 7 new of 9
found"), which is the §47 "what to show the user" requirement: the user sees decisions and their
yield, not a transcript.

## §50 Context memory

`AgentMemory` holds two sets: entities known (`kind:value`, case- and space-normalized) and
transform runs already made (`transform@kind:value`). It is seeded from the board, so what is already
on the canvas counts as known: if `example.com` is already linked to repository X, the agent does not
re-collect it, and a transform that already answered for an input is skipped with
`already-known` rather than re-run. Memory also decides _value_: only entities the memory had not
seen count as new in the evaluate step, which is what makes `no-new-value` a real measurement instead
of a guess.

## Boundaries and honest gaps

- **N4 holds.** The agent produces `InvestigationResult`s; nothing reaches the board except through
  the proposal review the analyst accepts.
- **No model is wired to `brain` yet.** The hook, the observation and the narrowing rule exist and
  are tested; connecting `packages/ai`'s provider to it is a separate, small step.
- **The agent has no UI yet.** `WorkflowPanel` covers §45/§46; the agent is engine-side and reachable
  by callers (and tests). A session view showing rounds, skips and approval prompts is the next batch.
- **Approval is per transform id, per round.** Approving `username-to-profiles` once does not approve
  it forever; a session-scoped "always allow" list is deliberately not implemented.
- **Frontier selection is confidence-ordered**, not model-ranked. It is a defensible default, and it
  is the first thing `brain` should improve once a model is connected.
