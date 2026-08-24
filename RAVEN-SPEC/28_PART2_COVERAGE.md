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
