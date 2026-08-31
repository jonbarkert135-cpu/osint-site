# Raven — 28 — PART 2 COVERAGE MAP (§1–§10)

## Scope

Part 2 of the owner's master prompt ("ДОПОЛНЕНИЕ К MASTER PROMPT") is delivered in batches. This
file is the answer to one question only: **for each Part 2 section, where does it live and what is
still missing?** It carries no design of its own — it points at the document that owns each
requirement, and states honestly whether that document has been backed by verified research or is
still a hypothesis.

Non-goals: the designs themselves (`22`, `23`, `24`, `26`, `10_INTEGRATIONS.md`), and the roadmap
tracker (`25_IMPLEMENTATION_STATUS.md`), which stays the single source of truth for shipped code.

Batch 1 = §1–§10, closed on **2026-08-24**.

---

## 1. Coverage table

| §   | Requirement                                      | Owner document                                                                                                                               | State                                                                                                                             |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Ecosystem audit, 18 audit questions              | `22_ECOSYSTEM_AUDIT.md` §1–§9 + **§10** (verified)                                                                                           | **done** — 2026-08-24 pass covers discovery, documents/media/code, search/graph/AI                                                |
| 2   | Look beyond GitHub                               | `22` §10.1–§10.3, `26` §5.1                                                                                                                  | **done** — PyPI, npm, crates.io, Docker Hub, vendor sites and registry APIs are named sources; watchers query registries directly |
| 3   | Research beyond OSINT (11 categories)            | `22` §2–§6 (A–E) + §10.2/§10.3                                                                                                               | **done** — discovery, search, metadata, graph, documents, images, code, web research, automation, AI, visualization all covered   |
| 4   | Competitor audit                                 | `23_COMPETITOR_MATRIX.md` §8.1–§8.3                                                                                                          | **done** — 27 products checked against vendor pages on 2026-08-24                                                                 |
| 5   | Competitor matrix + adopt/improve/reject/build   | `23` §3–§6 and §8.1, §8.3–§8.5                                                                                                               | **done**                                                                                                                          |
| 6   | No obsolete projects, tiers A–E                  | `22` §1 (tier rules), §10.1 (tiers), `26` §3.2                                                                                               | **done** — rejection log now carries the 2026-08-24 demotions                                                                     |
| 7   | Automated open-source discovery engine           | `26` §3 (pipeline) + **§5** (watchers, intake, scoring, refusals)                                                                            | **built** — all six watchers run in `apps/worker/src/watchers/` on BullMQ schedules; intake and scoring remain manual             |
| 8   | Every service is a module (adapter architecture) | `10_INTEGRATIONS.md` §3 (InputAdapter → Execution → Parser → Normalizer → EntityExtractor → RelationshipExtractor → graph), §8 (normalizers) | **specified and partly built** — two registered engines (`expand-url`, `github`)                                                  |
| 9   | One unified query engine / query bar             | `24_UNIFIED_QUERY.md` §3, §10, §11                                                                                                           | **specified; UI partly built** — global search shipped (PR #51), the query bar over the engine is not                             |
| 10  | Intelligent query planner                        | `24` §4 (router: 8 filter stages) and §5 (plan, stages, budget, approval)                                                                    | **specified, not executed end-to-end** — `QueryPlan` has no scheduler behind it                                                   |

## 2. Real gaps after batch 1

Ordered by what blocks the most downstream work. These are engineering items, not documentation
items — each needs a roadmap entry, not another spec.

1. **Query executor** (§9, §10). `QueryPlan` is fully specified and nothing runs it. Until the
   executor exists, the router, the budget model and the plan-review UI are theory.
2. **Discovery watchers** (§7). **Done** — all six shipped on 2026-08-31: `release-watch`,
   `liveness-watch`, `license-watch`, `vuln-watch` (OSV), `definition-watch` and `endpoint-watch` in
   `apps/worker/src/watchers/`, scheduled and writing dated drift findings. `endpoint-watch` hashes
   the normalised vendor page rather than parsing prose: a changed hash is a `review` finding for a
   human to read, and a page with no recorded baseline reports its hash as `unverified`.
3. **More adapters** (§8). Two engines is not an ecosystem. The next ones follow the verified Tier-A
   list: subfinder, dnsx, httpx, Sherlock (already passported), then the free public APIs (RDAP,
   DoH, GLEIF, crt.sh) which need no credentials and no container.
4. **`packages/transforms` is still unimported** by any app — dead code that overlaps §8's pipeline.
   Either wire it into the adapter chain or delete it; carrying both is the worst option.
5. **Hidden Cloud survey** (`26` §4, reserved as `27_HIDDEN_CLOUD_ARCHITECTURE.md`) — every
   passport's environment field stays `unverified` until it exists.

## 3. Standing rules this batch established

- A licence and an execution mode are **veto gates**, never score weights (`26` §5.3).
- GPL/AGPL engines run as a separate process; BUSL/source-available components are pointed at as a
  user-operated service; **model weights carry their own licence**, checked separately (`22` §1).
- Only DoH JSON, RDAP, GLEIF and Wikidata are reliably callable from the browser. Anything else
  needs the runner or the API process — no UI may assume otherwise (`22` §10.1).
- Every hard fact in these documents carries `[source, YYYY-MM-DD]` or is written `unverified`.
  Re-verify anything older than 90 days before a decision rests on it.

## 4. Next batches

The owner supplies Part 2 sections in batches. When the next batch arrives, extend the table in §1
with the same three columns and update §2 rather than starting a new coverage document.

## 5. Batch §11–§14 — orchestration (2026-08-24)

| §   | Requirement                        | Where it now lives                                              | State   |
| --- | ---------------------------------- | --------------------------------------------------------------- | ------- |
| 11  | Universal Service Orchestrator     | `29_ORCHESTRATION.md` §11, `packages/query-engine/executor.ts`  | ✅ code |
| 12  | Parallel execution of independents | `schedule.ts` ready-queue + `budget.maxParallel`                | ✅ code |
| 13  | Dependency-aware DAG execution     | `buildDag` / `createScheduler`, `plan.graph` event              | ✅ code |
| 14  | Single streaming result channel    | `step.progress` / `run.progress` events, `useQueryRun` snapshot | ✅ code |

Correction to §2 above: the plan executor **does** exist (`executePlan`, shipped 2026-08-24); the
gap that remains is engine coverage and the server-side egress proxy, not execution itself.

Open after this batch: heartbeat progress from inside a single long engine (needs a runner protocol
change), cross-run queueing in `apps/worker`, circuit breaker and retries (`24` §6.1).

## 6. Batch §15–§19 — one result format, one entity, one source of truth (2026-08-24)

| §   | Requirement                      | Where it now lives                                                                                                                                                            | State                                                                                                              |
| --- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 15  | Universal result schemas         | `packages/transforms/sdk/types.ts` (Entity/Relationship/Evidence/RawChunk/EngineOutput), `query-engine/resolve.ts` (Provenance, ResolvedEntity/Relation, InvestigationResult) | ✅ code — the five schemas already existed as one shared contract; this batch added the source URL and raw pointer |
| 16  | Entity-resolution pipeline       | `normalize.ts` (canonicalization + identityKey) → `resolve.ts` (dedup, corroboration) → `dedupe.ts` (loose matching)                                                          | ✅ code                                                                                                            |
| 17  | No duplicate dump                | `dedupe.ts` `possibleDuplicates`, surfaced as "Possible duplicate" in `AskPanel`                                                                                              | ✅ code — flagged, never merged automatically                                                                      |
| 18  | Evidence system                  | `EvidenceRef` on every `Provenance`: excerpt, source URL, raw payload, timestamp, plus service/provider/run already carried                                                   | ✅ code                                                                                                            |
| 19  | Source-first ("Open / View raw") | `AskPanel` result list: `Open source` link and `View raw result`                                                                                                              | ✅ code                                                                                                            |

Deliberately not built (§17 boundary): an automatic merge action. The analyst merges; the system
only points. Auto-merging on a loose key is how two people with one nickname become one suspect.

Loose matching covers what the owner's example asks for — `example.com`, `https://example.com/`
and `www.example.com` are one hint — and nothing else: scheme, `www.`, a trailing slash and case.
Fuzzy name matching (edit distance on people or companies) is out of scope until it can be scored.

Still open after this batch: raw chunks live only for the lifetime of the run (nothing persists
them to `packages/db`), so "View raw result" works inside the session and not on a reopened board.

## 7. Batch §20–§23 — the dashboard the run builds for itself (2026-08-25)

| §   | Requirement                     | Where it now lives                                                                         | State   |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------ | ------- |
| 20  | Dynamic dashboard from services | `apps/web/src/query/dashboard.ts` (`buildDashboard`) + `ResultsDashboard.tsx`              | ✅ code |
| 21  | Per-service panels, one design  | `ServicePanel` per provider, rendered with the shared tokens — no per-tool styling         | ✅ code |
| 22  | Result-card interaction         | Open source · Expand · Copy · Mark as evidence · Dismiss on every card                     | ✅ code |
| 23  | Build Graph                     | `ResultsDashboard` → `AskPanel.buildGraph` → `applyProposal` (nodes, edges, radial layout) | ✅ code |

The overview is assembled from the run, never declared: a counter exists because the run produced
that kind, and a service panel exists because that provider was asked. A provider that returned
nothing keeps its panel and says "no results" — an empty answer from Sherlock is a finding, and
hiding it would make the dashboard lie by omission.

Deliberately **not** built from the §22 list: `add to canvas` per card, `connect`, `bookmark`,
`tag`, `inspect source` as a separate view, `export`. Per-card `add to canvas` would be a second
write path next to Build Graph (one way to do one thing); `connect`, `tag` and `bookmark` already
exist on the node once it is on the canvas, and duplicating them here would mean two places to
maintain and two places to be inconsistent. `export` is gap item 7 and belongs to the board, not to
one run. `inspect source` and `inspect raw` are the same click here: `Expand` → `View raw result`.

Build Graph is a filter plus the existing commit: the analyst dismisses what is noise, and the kept
entities become nodes, their relations become edges (only when both endpoints survive), the radial
layout places them, and the whole thing lands as **one** undo step through `applyProposal` — the
same write path an integration import uses, with the same provenance (U7/N4).

The alternate views the batch lists next to the graph — timeline, entities, evidence, service
results, raw data, recommendations — ship as sections of this dashboard. The standalone
Graph/Timeline/Table/Map views over a whole board are still gap item 6 and unaffected by this batch.

Recommendations are computed, not written: duplicates to review, failed services, findings under
0.5 confidence, findings with no source URL, and findings with no relations yet.

## 8. Batch §24–§26 — no black box: control, fact vs inference, confidence (2026-08-25)

| §   | Requirement                     | Where it now lives                                                                      | State   |
| --- | ------------------------------- | --------------------------------------------------------------------------------------- | ------- |
| 24  | User control / run console      | `apps/web/src/query/RunConsole.tsx` + `log` in `useQueryRun.ts`, folded into `AskPanel` | ✅ code |
| 25  | Observed vs Derived vs AI       | `packages/query-engine/src/assurance.ts` (`assessEntity`, `assessRelation`)             | ✅ code |
| 26  | Confidence + sources + evidence | `Assessment.band / sourceCount / evidenceCount / why`, shown on every card and edge     | ✅ code |

§24 asks the app to answer four questions at any moment: what is running, why, on what data, and
what came back. The run already emits exactly those facts as events, so the console is a projection
of the event stream, not a second source of truth: `reduceEvent` appends one line per event
(`run <transform> via <engine> on <kind> <value>`, `found …`, `done … · N result(s)`, `skip …`,
`fail …`) and the drawer renders them. It is a **log, not a control** — nothing in it writes, so it
cannot drift out of step with the run it describes. The handle sits at the foot of Ask Raven with an
arrow, closed by default, `aria-expanded` on the button, `role="log"` + `aria-live="polite"` on the
body, animation disabled under `prefers-reduced-motion`. The log is capped at 500 lines so a long
run cannot grow the tab without bound.

Results still land on the board through Build Graph (§23) rather than through the console: two write
paths for the same act would be two places to be inconsistent.

§25 is a single pure classifier, so the vocabulary cannot fork between screens:

- **Observed** — a provider stated it and left evidence (an excerpt, a URL or a raw payload).
- **Derived** — this layer worked it out by combining observations, or the resolver inferred the
  edge (`ResolvedRelation.derived`). Nothing pointed at it directly.
- **AI inference** — every source behind it came from a model engine (`ai*`, `llm*`, `infer*`).
  A hypothesis, and it says so in words as well as in colour.

The three never share a visual treatment: solid accent border, dashed neutral, dotted danger +
italics. Colour is never the only signal (the word is always present), which is also what keeps it
readable for colour-blind analysts.

§26 never shows a bare number. Every finding and every relationship carries `High / Medium / Low ·
0.NN · N source(s) · N evidence`, where the source count is _independent providers_ — the same
provider repeating itself is one observation, not corroboration (`corroborate`, §7.4) — and the
`why` sentence is available on hover and inside the expanded card.

Deliberately not built here: a per-finding "dispute/confirm" control that would let an analyst
overwrite a computed confidence. Confidence is evidence-derived; letting a click overwrite it would
make the number unfalsifiable. Marking a finding as evidence (§22) is the honest version of that.

## Batch: §27–§33 (2026-08-25)

| §   | Requirement           | Where it now lives                                                         | State                            |
| --- | --------------------- | -------------------------------------------------------------------------- | -------------------------------- |
| 27  | Service health center | `packages/query-engine/src/health.ts` + `/system` → Health                 | ✅ code                          |
| 28  | Engine registry       | `/system` → Engines, read from engine/transform manifests                  | ✅ code                          |
| 29  | Failure isolation     | `runIsUsable()`, per-engine rows; invariant U5                             | ✅ code + test                   |
| 30  | Retry system          | `applyAction()` + row menu (records intent, never executes — N5)           | ✅ code                          |
| 31  | Timeout management    | `deadlineFor()` in the executor + the `executionMs` ceiling                | ✅ enforced per run              |
| 32  | Resource manager      | `packages/query-engine/src/resources.ts`, wired as `ExecuteDeps.resources` | ✅ enforced per run              |
| 33  | Hidden Cloud          | `29_RUNTIME_ENVIRONMENT.md` §7 — VPS profile + `scripts/survey-host.sh`    | ✅ resolved, capacity unmeasured |

Design and the honest gap list: `29_RUNTIME_ENVIRONMENT.md`. §33 was closed on 2026-08-25 once the
owner confirmed the target: a self-managed Linux VPS (Ubuntu LTS, x86_64, root, Docker Engine,
systemd, persistent disk, nginx + Let's Encrypt) rather than a PaaS. Containerized engines are
therefore allowed with explicit per-container limits. What remains unverified is machine capacity —
RAM, cores, disk, Docker version — which `scripts/survey-host.sh` answers when run on the host; the
resource budget keeps its conservative defaults until that output is recorded.

§31 and §32 stopped being boundary-only on 2026-08-31: the executor now asks the injected
`ResourceManager` for a lease before every engine run (CPU and RAM from the engine passport,
`executionMs` from the transform deadline) and releases it in a `finally`. A refusal is a
`step.skipped` event with reason `over-capacity` plus the accountant's own message in the run
warnings — the query still returns everything it already produced (U5). `apps/web` holds one
manager per tab; a host that runs a single engine at a time omits the dependency.

## Batch: §34–§39 (2026-08-25)

| §   | Point                 | Where                                                            | State                    |
| --- | --------------------- | ---------------------------------------------------------------- | ------------------------ |
| 34  | Compatibility matrix  | `packages/transforms/src/runtime.ts`, `/system` → Runtime        | ✅ 4 classes, per-engine |
| 35  | No forced fits        | `FALLBACK_STRATEGIES` on the passport, surfaced as "Alternative" | ✅ data, not folklore    |
| 36  | Remote engine queue   | `packages/transforms/src/remote.ts`                              | ⚠️ queue only, no worker |
| 37  | Engine abstraction    | `packages/transforms/src/adapters.ts` (`EngineAdapter`)          | ✅ core is runtime-blind |
| 38  | Multi-runtime support | `ENGINE_RUNTIMES` + `ADAPTER_SUPPORT`                            | ⚠️ 5 of 8 implemented    |
| 39  | Engine manifest       | `EngineRuntimeSchema`, `resolveRuntime()`                        | ✅ validated, derivable  |

Design and gaps: `30_ENGINE_RUNTIME_ARCHITECTURE.md`. The cli/python adapters
(`packages/transforms/src/cliAdapter.ts`) and their host binding
(`apps/runner/src/executors/engineAdapters.ts`) shipped on 2026-08-31: an engine run now goes
through the same sandbox, egress proxy, limits and artifact collection as every other run. `sdk/adapterEngine.ts` then joins an adapter to the executor's `TransformEngine` contract, and
`sdk/engines/cli-engines.ts` ships subfinder, amass and sherlock on top of it, which moves §8
("every service is a module") from two engines to five. Two honest limits remain: the containerized
engines still need a pinned image digest before a host may run them, and no external worker ships
with the repo, so §36 is exercised by tests rather than in production.

## Batch: §39–§41 (2026-08-31)

| §   | Point                  | Where                                                    | State                   |
| --- | ---------------------- | -------------------------------------------------------- | ----------------------- |
| 39  | Engine manifest        | `packages/transforms/src/document.ts` (`engineDocument`) | ✅ joined, derived view |
| 40  | Plugin installation    | `packages/transforms/src/install.ts` (8 gates)           | ✅ pipeline, no UI      |
| 41  | Service recommendation | `packages/query-engine/src/recommend.ts`                 | ✅ model, no Run-all UI |

Design: `30_ENGINE_RUNTIME_ARCHITECTURE.md` §8–§9 and `24_UNIFIED_QUERY.md` (last section). §39 is
answered by joining the existing split manifests rather than adding a fourth file: a second copy of
`inputs`/`outputs`/`licence` on the engine is the copy that goes stale. §40 is pure and injectable —
it judges a fetched bundle and returns a new registry; fetching, unpacking and package-signature
verification are explicitly not built. §41 tiers Required / Recommended / Optional from the
`priority` already on each transform plus the router's verdict, and exposes `runAll` /
`defaultSelection`; the two buttons themselves are still to be drawn.

## Batch: §42–§44 (2026-08-31)

| §   | Point                    | Where                                                            | State                              |
| --- | ------------------------ | ---------------------------------------------------------------- | ---------------------------------- |
| 42  | Cost / resource planning | `packages/transforms/src/cost.ts`, gate inside `expand()`        | ✅ code + test, per-step           |
| 43  | Query presets            | `packages/query-engine/src/presets.ts` (7 presets)               | ✅ data + planning, no UI yet      |
| 44  | Workflow builder         | `packages/query-engine/src/workflow.ts` (+ `WORKFLOW_TEMPLATES`) | ⚠️ model + compiler, no builder UI |

**§42.** `costProfile()` prices one step off manifests that already exist — CPU and RAM from the
engine's runtime passport (§34/§39), execution time from the transform's limits, network requests
from the data flow plus a pagination estimate (`maxResults / maxInputBatch`, so a subdomain sweep is
not counted as one request), queue from an `external` deployment (§36), availability from provider
status, and API limits from the provider's stated quota. `costVerdict()` then refuses with
`over-resource-budget` or `cost-not-justified`, both carrying a sentence an analyst can read; the
planner records them in `plan.excluded` like every other drop, so an expensive engine is never
silently missing. "Expensive only where useful" is implemented as: a class above `standard` needs a
router score of at least `minValueForExpensive`, i.e. quality × priority, not a guess.

Two deliberate boundaries. **Rate limits are pacing, not refusals**: `paceMs` reports how long a
provider's quota would stretch a run (GitHub unauthenticated: four pages ≈ four minutes) and only
an impossible run — more requests than the provider's whole daily allowance — is refused;
throttling belongs to `EngineLimits` (§31). And **concurrency-wide accounting stays in the runtime
resource manager** (§32): the cost gate decides whether asking is reasonable, the manager decides
whether the box can take it right now. A plan that passes here can still be admission-refused
there, and that is correct, not a gap.

**§43.** Seven presets: Quick Scan (one hop, nothing above `standard`, no queued engines), Deep
Scan (every compatible engine, two hops, queue allowed, `minValueForExpensive: 0` because breadth
_is_ the value there), Repository / Username / Domain / Document investigations (each locks the
entity kind so a repo is never typed as a domain) and Custom (imposes nothing). CPU and RAM
ceilings do not vary between presets: the host is the binding limit, and raising them would only
plan steps §32 then refuses. Anything the caller passes explicitly wins over the preset. Document
Analysis is a node preset — no text types to `file`, so it is reached through
`applyPreset()` + `expand()` rather than the query bar.

**§44.** A workflow is saved, ordered, declarative data: stages
`input → normalize → transform* → entity-resolution → graph → ai-summary`, transform steps named by
manifest id, dependencies by node id. `validateWorkflow()` rejects rather than repairs — stage order
is a fact (a summary cannot precede its graph), an unknown transform is an error and not a skipped
step, and a forward reference (how a cycle looks in a declaration-ordered list) is refused.
`compileWorkflow()` emits the same `TransformPlan` the planner produces, so a workflow inherits the
DAG scheduler, budgets, the §42 cost gate, provenance and partial results instead of growing its own
runtime; non-transform stages need no steps because they _are_ the executor's pipeline.
`parseWorkflow()` treats a saved file as untrusted input.

Honest gaps: no builder UI and no persistence surface yet (a workflow is a value; storing it on a
board is the next batch), and there is no SpiderFoot engine in the catalogue — `12_SPIDERFOOT.md` is
spec, not code — so the brief's SpiderFoot slot in `WORKFLOW_TEMPLATES` is filled by the shipped
broad-sweep transform (`selector-to-web-mentions`) and swaps to `spiderfoot` in one line the day
that engine lands.

## Batch: §45–§50 (2026-08-31)

| §   | Point                  | Where                                                                          | State                               |
| --- | ---------------------- | ------------------------------------------------------------------------------ | ----------------------------------- |
| 45  | Visual workflow editor | `packages/query-engine/src/builder.ts`, `apps/web/src/query/WorkflowPanel.tsx` | ✅ canvas model + panel             |
| 46  | Research automation    | `runWorkflow()`, `apps/web/src/query/workflowStore.ts`                         | ✅ save, list, re-run for new input |
| 47  | Research agent         | `packages/query-engine/src/agent.ts` (`runAgent`)                              | ⚠️ engine-side, no model wired      |
| 48  | Agent boundaries       | `AgentGuardrails` + enforcement in `agent.ts`                                  | ✅ 8 limits, approval default no    |
| 49  | Agent loop             | `runAgent()` rounds: observe→plan→execute→collect→evaluate→decide              | ✅ stops on `no-new-value`          |
| 50  | Context memory         | `AgentMemory` (`createAgentMemory`)                                            | ✅ seeded from the board            |

Design and boundaries: `31_RESEARCH_AGENT.md`.

**§45.** The editor is the canvas, not a second graph engine: `layoutWorkflow()` positions a saved
workflow (rank = longest path from the input, so a step never sits left of what it consumes and
sibling branches share a column) and `graphToWorkflow()` compiles the drawing back. That inverse owns
exactly one decision the drawing forces — an `EditorGraph` is unordered while a `Workflow` is
declaration-ordered — so it topologically sorts and reports a cycle _as a cycle_ instead of leaking
§44's "upstream node must be declared earlier". Unknown transforms and illegal stage order stay
`validateWorkflow`'s job: one rule set, not two. The panel (palette: _Workflows…_) draws nodes as
buttons with an SVG arrow layer that is transparent to the pointer, and adds/removes steps by id.

**§46.** Saved workflows live in the browser (local-first, N2), upserted by id, each entry re-parsed
through `deserializeWorkflow` so a corrupted record is dropped rather than half-loaded. `runWorkflow()`
compiles a saved pipeline for a _new_ input and returns the ordinary `QueryPlan`, so re-running
inherits scheduling, budgets, the §42 cost gate, provenance and proposal review unchanged. New in the
model: the input node may pin the entity kind it was built for, and a mismatched re-run is refused —
a username pipeline pointed at `example.com` says so instead of running Sherlock on a domain. The pin
survives the canvas round trip (it is carried on the editor node, not only in the saved file).

**§47–§50.** `runAgent()` is the orchestrator: registry (engines + capabilities), memory (results so
far + the current graph), guardrails (budget, permissions) in; decisions out. Two structural choices
carry the safety. Execution is **injected** — the agent decides, `executePlan` runs — so it cannot
route around the host-proxied fetch, the cost gate or the resource manager, and the loop is testable
with no network. And a model may **narrow, never widen**: the `brain` hook is handed the candidate
steps the planner already allowed and returns a subset; invented ids are dropped and recorded as
`brain-declined`, so a hallucinating model costs speed, not safety — and with no model configured the
agent still works (the keyless constraint in `14_AI_AGENT.md`).

Guardrails are enforced in code, never in a prompt: depth (2), jobs (12), wall clock (120 s), resource
budget and optional cost ceiling, breadth per hop (4), approval above 100 new nodes or on any stored
credential, and the permission boundary already carried by `PlannerContext`. Approval is asked once per
round and **the default answer is no**: with no `approve` handler the session ends `awaiting-approval`
having run nothing it had to ask about. Parallelism has two axes — tasks within a round run together
(independent by construction), the DAG scheduler parallelizes inside a task — and rounds are the only
sequential axis. Stops are explicit and explained: `no-new-value`, `max-depth`, `max-jobs`, `timeout`,
`nothing-to-do`, `awaiting-approval`; `no-new-value` is a measurement, not a guess, because §50's
memory (entities known + `transform@input` pairs already run, seeded from the board) is what decides
whether a result is new. Each round also emits a one-line headline for the activity feed, which is the
§47 "what to show the user" requirement.

Honest gaps: no model is wired to `brain` yet, the agent has no UI of its own (a session view with
rounds, skips and approval prompts is next), approval is per transform per round with no "always
allow", and frontier selection is confidence-ordered rather than model-ranked.

## Batch: §36, §38 (2026-08-31)

| §   | Point                 | Where                                       | State                         |
| --- | --------------------- | ------------------------------------------- | ----------------------------- |
| 36  | Remote engine queue   | `packages/transforms/src/remoteWorker.ts`   | ✅ queue + worker loop        |
| 38  | Multi-runtime support | `ADAPTER_SUPPORT`, `createGoAdapter`/`Rust` | ✅ 7 of 8 (browser-worker ⚠️) |

**§36.** `createRemoteWorker()` closes the loop `Core → Queue → External Worker → Result API →
Core`. `claim`, `complete` and `execute` are all injected, so one loop serves the in-process queue
and a remote Result API without this file knowing which; it holds no transport, timer or process
API. A throw inside `execute` is recorded as a retryable `internal` failure rather than stopping the
drain, and `drain(maxJobs)` is bounded. What still does not ship: a deployment — nobody runs the
worker on a second machine and no HTTP transport is written, so §36 remains test-exercised.

**§38.** `go` and `rust` are now implemented adapters, not planned ones. They are `createCliAdapter`
with their own runtime label, because a Go binary and a Python image are the same act from the
core's side (render argv, run it somewhere, read stdout) and the difference is the host's business.
The runner registers all four (`createEngineAdapters`), routed through the same `ExecutionLayer`, so
a go/rust engine gets the identical sandbox, egress proxy and limits. `browser-worker` stays
`planned` on purpose: it needs no process at all and no engine in the registry asks for it.

Unchanged limit: containerized engines still need a pinned image digest before a host may run them.

## Batch: §36 core side, §37 dispatch (2026-08-31)

| §   | Point                 | Where                                     | State                      |
| --- | --------------------- | ----------------------------------------- | -------------------------- |
| 36  | Core → queue → worker | `packages/transforms/src/queueAdapter.ts` | ✅ loop closed both ways   |
| 37  | Plan step → adapter   | `registryEngines()` in `sdk/engines`      | ✅ registry-driven library |

**§36 (core side).** `createQueueAdapter()` makes the remote queue reachable from a plan without any
caller learning it exists: it is an `EngineAdapter` that enqueues, lets an attached worker settle,
and returns whatever came back. A worker's _failure_ is returned as the answer — running the tool
again locally after the worker already ran it would double the work and the cost. An unclaimed job
falls back to the local adapter (N2, local-first); with no local adapter the refusal is
`unavailable`/retryable, stated rather than hung. No timer and no fetch: the host injects `settle`.

**§37 (dispatch).** `registryEngines(adapters, catalog)` builds the executor's engine library from
an `AdapterRegistry`, filtered by `canDispatch()`. An engine whose runtime has no adapter on this
host is absent from the library, so the step is skipped as `engine-unavailable` with a reason —
never a pretend capability (U5).

Honest gaps unchanged: no process owns both an adapter registry and the plan executor yet (the
browser has no adapter by design, the runner does not execute plans), there is no HTTP transport or
worker deployment, and containerized engines still need pinned image digests.

## Batch: §37 host wiring (2026-08-31)

| §   | Point                    | Where                     | State                       |
| --- | ------------------------ | ------------------------- | --------------------------- |
| 37  | One process, both halves | `apps/runner/src/plan.ts` | ✅ registry + plan executor |

`createHostAdapters()` registers the runner's cli/python/go/rust adapters, `createHostEngines()`
merges `BUILTIN_ENGINES` with whatever `registryEngines()` says this host can dispatch, and
`runHostPlan()` drains `executePlan` and returns the investigation. That closes the gap the last two
batches kept naming: the adapter registry and the plan executor now live in the same process, and a
subfinder step in a plan really does reach the runner's `ExecutionLayer` — one confinement, no second
process door (N5). The network stays injected (`fetch`), because routing through the egress proxy is
the deployment's business, not this module's.

Still open, and stated rather than hidden: nothing _asks_ the runner for a plan yet — there is no
queue message for it, so the host is entered from tests or from an embedder. The browser keeps the
builtin-only library on purpose (N2). Containerized engines still need pinned image digests.

## Batch: §51–§56 (2026-08-31)

| §   | Point                | Where                                    | State                            |
| --- | -------------------- | ---------------------------------------- | -------------------------------- |
| 51  | Engine result cache  | `packages/transforms/src/cache.ts`       | ✅ record + version invalidation |
| 52  | Live update          | `liveCounters()` in `useQueryRun.ts`     | ✅ counters during the run       |
| 53  | Execution view       | `apps/web/src/query/ExecutionView.tsx`   | ✅ pipeline tree                 |
| 54  | Unified activity log | `apps/web/src/system/activityLog.ts`     | ✅ session-scoped                |
| 55  | Engine catalogue     | `packages/query-engine/src/catalog.ts`   | ✅ five states + tab             |
| 56  | Tool discovery       | `packages/query-engine/src/discovery.ts` | ⚠️ logic only, no scanner wired  |

**§51.** The cache already keyed on `transform+version | engine+version | provider | input`, so a new
engine version has always _missed_. What it did not do is remember what it was holding: an entry now
records the query, the input, the engine and its version, the provider, the timestamp and the expiry,
which makes a cached answer auditable and lets `invalidateEngineVersion(engine, version)` drop the
superseded entries instead of leaving them to age out. The query is recorded, never keyed — two
different questions that reach the same transform on the same input share the answer, as they should.
Storage stays in memory (ADR-001): a durable cache is the repository's job.

**§52.** The dashboard counted after the run; the tally now exists during it. `reduceEvent` keeps a
per-kind count and a relationship count as `entity.found` / `relation.found` stream in, and
`liveCounters()` renders "12 entities found · 3 repos found · 42 relationships discovered" from the
same events the finished dashboard counts — so the live number and the final number cannot disagree.

**§53.** _Execution View_ (a toggle in Ask Raven) draws the run as the pipeline it is: query →
planner → engines in parallel → aggregator → entity resolver → graph. It is a text tree with a state
mark per node, not a canvas: the shape is fixed, and a tree stays readable at twenty engines. Node
states are derived (`executionView.ts`) — a stage the run has not reached is `pending`, never an
optimistic tick — and the downstream stages only start once every engine has settled.

**§54.** One session history — queries, engine runs, entities, connections, errors, imports, exports —
fed from the run stream (`recordQueryEvent`) plus the import and export call sites, filterable by kind
on _System → Activity_. Deliberately not persisted, like `runtimeStore`: a log that survives a reload
belongs in `@nexus/db`, and a persisted-looking log that silently forgets is worse than none. The one
kind nothing writes yet is `ai`: the AI panel has its own review flow and was left alone this batch.

**§55.** `integrationCatalog()` puts every engine in exactly one of five states — installed,
recommended, available, deprecated, incompatible — with the reason in words and the action the row
offers (open / install / replace / none). Deprecated and incompatible are kept apart on purpose:
one means "do not start using this", the other means "no button will fix this host". There is no
marketplace, as §55 allows; the extension point is the input, which is a list of `EngineDocument`s,
so a remote index is one more source concatenated with the local registry's.

**§56.** `discoverTools()` judges candidates (new repositories, releases, alternatives) against the
catalogue: a newer release of an installed engine is an `update`, something covering a capability
whose engine is deprecated or incompatible is an `alternative` ("a supported alternative to X was
found"), an uncovered capability is a `new-tool`, and anything already covered by a working engine is
silence. Ignored ids never come back, and a candidate whose runtime this build has no adapter for is
offered as Review/Ignore without an Install it could not honour. **Honest gap:** nothing fetches
candidates — no release feed, no registry crawl, no model — so the Discovered section reads "no tool
scan has run in this build yet" rather than showing invented finds, and Install is disabled because
the app has no package fetcher (the §40 install pipeline judges manifests, it does not download them).

## Batch: §57–§62 (2026-08-31)

| §   | Point              | Where                                         | State                               |
| --- | ------------------ | --------------------------------------------- | ----------------------------------- |
| 57  | Deprecation system | `packages/transforms/src/deprecation.ts`      | ✅ verdict + replacement + warning  |
| 58  | No legacy build-up | `packages/transforms/src/governance.ts`       | ✅ seven requirements, debt list    |
| 59  | Security first     | `securityReview()` in `src/review.ts`         | ✅ gate in the §40 install pipeline |
| 60  | Legal / licence    | `licenceReview()` in `src/review.ts`          | ✅ gate in the §40 install pipeline |
| 61  | Safe defaults      | `installEngine()` + `integrationGovernance()` | ✅ installs land disabled           |
| 62  | Testing of engines | `src/sdk/conformance.ts`                      | ✅ eight kinds, coverage map        |

**§57.** `assessDeprecation()` judges an engine against signals the host collected — last release,
archived upstream, an upstream notice, unfixed advisories, the observed failure rate, a newer version
— and returns one of four verdicts. Hard facts (`archived`, an upstream notice, a `deprecated`
manifest, three years without a release) give `deprecated`; the soft ones accumulate into
`suspected`. An engine nobody has any signal for is **`unverified`, never `active`**: a clean bill of
health that nothing checked is the failure mode this section exists to prevent. When the verdict is
bad the registry is searched for a replacement covering the same capability, and the candidate is
only offered with a stated advantage from §57's own vocabulary (active maintenance / newer runtime /
better API / higher compatibility) — "use this other thing, no idea why" helps nobody. The catalogue
(§55) takes the verdicts as input, so an engine whose upstream died shows as deprecated even while
its manifest still says `stable`. **Gap:** nothing populates the signals yet; the release, liveness
and vuln watchers in `apps/worker/src/watchers/` write drift findings, and wiring those into
`DeprecationSignals` is the next step.

**§58.** Seven questions per integration — owner, adapter, compatibility, version, tests, health
check, deprecation policy. Four are derived from what the repo already knows; the other three
(owner, tests that really ran, deprecation policy) are statements a human makes, and arrive as an
`IntegrationRecord`. An engine with no record is not assumed to be fine: it appears in
`governanceReport().debt` with each missing requirement named, and in `unowned`. There is
deliberately no hand-written ledger for the 37 catalogue engines — inventing owners and test claims
for engines that have neither would defeat the point of the section.

**§59/§60.** `securityReview()` and `licenceReview()` are pure functions over a declaration the
caller assembled from a package manifest, an SBOM, an OSV query and a licence scan. Security checks
the execution model, third-party code execution, subprocess use, filesystem writes outside the
workdir, network egress, secrets, ungranted permissions and advisories; a project that runs foreign
code is refused unless it is containerized. Licence checks the SPDX id against the workspace policy,
commercial compatibility, attribution, redistribution and **every dependency licence**. Both treat
an absent fact as unverified, and unverified never resolves in the candidate's favour — an unlicensed
project is refused, because being public on GitHub grants no rights. Both are wired into the §40
install pipeline as its licence and security gates; without a declaration those gates fall back to
the manifest alone and say so in `pending`.

**§61.** `installEngine()` now returns `enabled: false` — always — plus a `pending` list. Compatibility,
security, licence and the health check are the gates the pipeline runs, and passing them makes an
engine _installable_, not _enabled_: `integrationGovernance()` flips the state only when the review
verdicts are `pass` and a health check passed inside the freshness window (30 days by default). The
runner enforces it at the dispatch seam — `createHostEngines(adapters, catalog, enabled)` hands the
executor only the enabled ids, so a disabled engine reports `engine-unavailable` exactly like a
missing adapter. Builtin SDK engines are part of this build, ship with their own tests and are not
gated.

**§62.** The conformance harness gained the three kinds it was missing: a **timeout** test (a deadline
shorter than the provider's answer must end as `timeout` with partial results kept), a **failure**
test (with nothing mocked every request rejects — the engine must report it, not throw, and must not
claim exhaustiveness) and a **duplicate-handling** test (the same chunks twice must not become the
same entity twice). `conformanceCoverage(report)` maps passed checks onto the eight §62 kinds —
unit, integration, adapter, health, timeout, failure, normalization, duplicates — so the governance
ledger's `tests` field is evidence from a run rather than a claim in a manifest. All three shipped SDK
engines (doh-resolver, rdap-lookup, ct-log-search) cover all eight.

---

## Batch: the queue speaks HTTP, and something finally asks for a plan (§36, §37)

Two gaps this file has been carrying since the remote-execution batch, both of the same shape: the
mechanism existed, nothing production called it.

**§36 over HTTP.** `packages/transforms/src/httpQueue.ts` gives the queue a transport, and it is the
smallest one that works: `createHttpWorkerTransport()` on the worker side (claim, post the result)
and `handleQueueRequest()` on the core side, a pure `(queue, request) → {status, body}` router a
host mounts on the server it already runs. No framework, no client library, `fetch` injected — the
file stays in the browser-safe bundle (N2) and the queue's own rules stay where they were: an empty
queue answers `200 null` (nothing to do is an answer), a job the queue no longer accepts answers
`409` so a worker is never told its result was recorded when it was not, and a refused or malformed
response makes the worker report "no work" rather than stop draining (U5). The two halves are tested
against each other over a loopback fetch, because a transport tested only against a stub is a
transport that agrees with itself.

**The plan trigger.** `PLAN_QUEUE` (`query.plan`) plus `zPlanJob` in the runner protocol, and
`runPlanJob()` in `apps/runner/src/plan.ts`: a queue message now asks the host to plan and execute a
query. The message carries the query, the mode and the granted permissions rather than a plan — there
is no plan table, and a plan derived at claim time cannot be one the previous release built. The
runner never widens permissions (N4), so an engine that needs `subprocess` is simply not planned when
the org did not grant it. `runPlanQueueJob()` in `main.ts` builds the host adapters over the same
container executor, sandbox flags and egress proxy every integration run gets (N5, one door), streams
`QueryEvent`s onto the existing run channel so a UI can follow a plan exactly like a run, and reads
engine stdout back through `s3Read()`. Engine network access goes through `nodeHostFetch`, i.e.
`safeFetch` — an engine cannot reach the metadata service any more than an integration can.

Still open, and stated rather than papered over: no deployment runs the external worker on a second
machine (the transport exists; the second machine does not), containerized engines still have no
pinned image digest, and nothing enqueues `query.plan` from the web app yet — the queue is the
contract, the caller is the next batch.

---

## Batch: something in the product finally asks the host to plan (§37)

The previous batch left the plan queue with no caller. It has one now, and it is deliberately thin.

**`queries.plan`.** `apps/api/src/trpc/routers/queries.ts` validates the query, the mode, the stated
permissions and the depth against the same shape `zPlanJob` accepts, mints a run id, enqueues
`query.plan` through `enqueuePlan()` (`apps/api/src/integrations/queue.ts`, second BullMQ queue on
the connection the run queue already opened) and audits `query.plan.requested`. It does not plan and
does not execute (N5): the plan is still derived by the runner at claim time, so a message that sat
in Redis over a deploy cannot carry a stale plan. Permissions are forwarded exactly as stated and
never widened (N4) — what the caller does not name, the runner does not get. The audit entry records
the mode, the number of permissions and the query's length, not the query: the string is user input
about a third party.

**"Run on the host".** `apps/web/src/query/HostRunButton.tsx` is one button next to "Run plan" in the
Ask panel, mounted only when the build has a backend (`localOnly` from the mode registry), so a
local-first tab is unchanged and never shows an action it cannot perform. It sends the raw query —
not a plan — and reports the run id the runner publishes progress under. "Queued" is all it claims,
because that is all that happened; a refusal prints the API's own sentence instead of a spinner that
never ends (U5).

Still open: no deployment runs the external worker on a second machine, and containerized engines
still have no pinned image digest, so a host plan today runs the same native engines the tab does —
the difference is where, not yet what.
