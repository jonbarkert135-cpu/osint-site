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
| 7   | Automated open-source discovery engine           | `26` §3 (pipeline) + **§5** (watchers, intake, scoring, refusals)                                                                            | **specified, not built** — the watcher jobs do not exist in `apps/worker` yet                                                     |
| 8   | Every service is a module (adapter architecture) | `10_INTEGRATIONS.md` §3 (InputAdapter → Execution → Parser → Normalizer → EntityExtractor → RelationshipExtractor → graph), §8 (normalizers) | **specified and partly built** — two registered engines (`expand-url`, `github`)                                                  |
| 9   | One unified query engine / query bar             | `24_UNIFIED_QUERY.md` §3, §10, §11                                                                                                           | **specified; UI partly built** — global search shipped (PR #51), the query bar over the engine is not                             |
| 10  | Intelligent query planner                        | `24` §4 (router: 8 filter stages) and §5 (plan, stages, budget, approval)                                                                    | **specified, not executed end-to-end** — `QueryPlan` has no scheduler behind it                                                   |

## 2. Real gaps after batch 1

Ordered by what blocks the most downstream work. These are engineering items, not documentation
items — each needs a roadmap entry, not another spec.

1. **Query executor** (§9, §10). `QueryPlan` is fully specified and nothing runs it. Until the
   executor exists, the router, the budget model and the plan-review UI are theory.
2. **Discovery watchers** (§7). Six read-only jobs (`release`, `liveness`, `licence`, `definition`,
   `vuln`, `endpoint`) in `apps/worker` with a drift-finding record. Without them the registry
   decays exactly the way SpiderFoot did, silently.
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

| §   | Requirement           | Where it now lives                                                      | State                            |
| --- | --------------------- | ----------------------------------------------------------------------- | -------------------------------- |
| 27  | Service health center | `packages/query-engine/src/health.ts` + `/system` → Health              | ✅ code                          |
| 28  | Engine registry       | `/system` → Engines, read from engine/transform manifests               | ✅ code                          |
| 29  | Failure isolation     | `runIsUsable()`, per-engine rows; invariant U5                          | ✅ code + test                   |
| 30  | Retry system          | `applyAction()` + row menu (records intent, never executes — N5)        | ✅ code                          |
| 31  | Timeout management    | `EngineLimits` / `DEFAULT_LIMITS`                                       | ⚠️ boundary only                 |
| 32  | Resource manager      | `packages/query-engine/src/resources.ts` (fair share 60 %)              | ⚠️ boundary only                 |
| 33  | Hidden Cloud          | `29_RUNTIME_ENVIRONMENT.md` §7 — VPS profile + `scripts/survey-host.sh` | ✅ resolved, capacity unmeasured |

Design and the honest gap list: `29_RUNTIME_ENVIRONMENT.md`. §33 was closed on 2026-08-25 once the
owner confirmed the target: a self-managed Linux VPS (Ubuntu LTS, x86_64, root, Docker Engine,
systemd, persistent disk, nginx + Let's Encrypt) rather than a PaaS. Containerized engines are
therefore allowed with explicit per-container limits. What remains unverified is machine capacity —
RAM, cores, disk, Docker version — which `scripts/survey-host.sh` answers when run on the host; the
resource budget keeps its conservative defaults until that output is recorded.

## Batch: §34–§39 (2026-08-25)

| §   | Point                 | Where                                                            | State                    |
| --- | --------------------- | ---------------------------------------------------------------- | ------------------------ |
| 34  | Compatibility matrix  | `packages/transforms/src/runtime.ts`, `/system` → Runtime        | ✅ 4 classes, per-engine |
| 35  | No forced fits        | `FALLBACK_STRATEGIES` on the passport, surfaced as "Alternative" | ✅ data, not folklore    |
| 36  | Remote engine queue   | `packages/transforms/src/remote.ts`                              | ⚠️ queue only, no worker |
| 37  | Engine abstraction    | `packages/transforms/src/adapters.ts` (`EngineAdapter`)          | ✅ core is runtime-blind |
| 38  | Multi-runtime support | `ENGINE_RUNTIMES` + `ADAPTER_SUPPORT`                            | ⚠️ 3 of 8 implemented    |
| 39  | Engine manifest       | `EngineRuntimeSchema`, `resolveRuntime()`                        | ✅ validated, derivable  |

Design and gaps: `30_ENGINE_RUNTIME_ARCHITECTURE.md`. Two honest limits: the cli/python adapters do
not exist yet, so the three containerized engines (amass, sherlock, subfinder) are classified and
limited but not runnable; and no external worker ships with the repo, so §36 is exercised by tests
rather than in production.

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
