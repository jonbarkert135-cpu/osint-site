# Raven — 24 — UNIFIED QUERY & ORCHESTRATION LAYER

## Scope

The layer that turns **one question from the analyst** into **one answer on the canvas**. It owns:
query intake and entity typing, the capability router (which engines can help), planning and budget
setting, concurrent execution with partial results, normalization into the canonical domain model,
deduplication and entity resolution, link derivation, provenance, and the query's own lifecycle
(saved, re-runnable, diffable).

It does **not** own: individual engine adapters and their manifests (`10_INTEGRATIONS.md`), the
Maltego-style transform/provider registry and its low-level transform DAG (see §12 — that is
`21_TRANSFORM_SYSTEM.md`, `docs/ecosystem/**` and `packages/transforms`, delivered as layer L4), the
canvas rendering of results (`05_CANVAS_ENGINE.md`, `06_NODE_SYSTEM.md`, `07_EDGE_SYSTEM.md`), or
the choice of any specific external engine (`22_ECOSYSTEM_AUDIT.md`).

Requirement source: `prompts/PROMPT_2_UNIFIED_INTELLIGENCE_PLATFORM_RU.md`. Implementation phase:
`20_ROADMAP.md` → **P17**. `00_MASTER.md` wins on any conflict.

---

## 1. Principles

| #   | Principle                               | Consequence                                                                                                                    |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| U1  | One input, many engines                 | the analyst never picks an engine to get a first answer; picking is an override, not a step                                    |
| U2  | The router is declarative               | routing is computed from capability descriptors, never from `if (engine === 'shodan')`                                         |
| U3  | Local-first by default                  | in `APP_MODE=local` only offline/keyless capabilities run unless the user opts in per query                                    |
| U4  | Nothing runs without a budget           | every query carries time, request, cost and node-count ceilings, enforced by the executor                                      |
| U5  | Partial beats perfect                   | results stream in; one dead engine degrades the answer, never fails the query                                                  |
| U6  | Every node knows where it came from     | provenance (engine, run, input, timestamp, legal posture, licence) is mandatory, not optional                                  |
| U7  | The layer proposes, the analyst commits | results land in a review surface; nothing mutates the board graph without an explicit accept (`17_PLUGIN_SDK.md` P1)           |
| U8  | Deterministic replay                    | a query + a plan + a seed is reproducible; a re-run produces a diff, not a duplicate cloud                                     |
| U9  | Active tooling is gated                 | anything that touches a third party's infrastructure (nuclei, httpx, crawling) needs an explicit authorization acknowledgement |
| U10 | Cost is visible before it is spent      | a plan shows estimated credits/requests per paid engine and asks before crossing a threshold                                   |

---

## 2. The capability model

A **capability** is the routable unit. It is what an engine promises to do, expressed only in domain
terms, so the router can reason without knowing what an engine is.

```ts
// packages/domain/src/query/capability.ts
export interface CapabilityDescriptor {
  id: string; // 'domain.subdomains.passive'
  title: string; // shown in the plan UI
  inputs: EntityTypeSelector; // { type: 'domain' } | { type: 'email' } | union
  outputs: EntityTypeRef[]; // what may appear on the canvas
  relations: RelationTypeRef[]; // what edges it may derive
  kind: 'passive' | 'active' | 'derive' | 'enrich' | 'archive' | 'analyze';
  execution: 'local-process' | 'container' | 'remote-api' | 'in-browser' | 'transform';
  offline: boolean; // may run with no network at all
  credential: 'none' | 'optional' | 'required';
  cost: CostModel; // { unit: 'request'|'credit'|'page'|'second', estimate, currency? }
  latency: { p50Ms: number; p95Ms: number; timeoutMs: number };
  legalPosture: LegalPosture; // §9
  licence: LicenceRef; // from 22_ECOSYSTEM_AUDIT.md; drives bundling checks
  quality: { precision: 'high' | 'medium' | 'low'; freshness: 'live' | 'cached' | 'historical' };
  rateLimit?: { perMinute?: number; concurrent?: number };
  dependsOn?: string[]; // capability ids that must run first (soft hint, not a DAG)
}
```

Rules:

- A capability descriptor is derived from an engine's manifest at registration time; adapters do not
  write descriptors by hand twice.
- `outputs`/`relations` must reference types that exist in `packages/domain`. An engine that wants a
  new entity type ships it as a domain change first — the router refuses unknown types.
- `offline: true` is a hard claim: if the adapter opens a socket during a local-mode run, the
  sandbox blocks it and the run is marked `contract-violation` (`15_SECURITY.md`).

---

## 3. Query intake and entity typing

One input. The analyst pastes `example.com`, `john.doe@example.com`, `+15551234567`,
`8.8.8.8`, `@handle`, a bitcoin address, a company name, a URL, or free text.

Pipeline: `raw string → normalize → selector match → candidate entity types (ranked) → disambiguation`.

1. **Selectors** are pure, tested functions in `packages/domain/src/query/selectors.ts` (regex +
   validation: IDN/punycode for domains, RFC-5322-lite for e-mail, E.164 for phone, IPv4/IPv6/CIDR,
   base58/bech32 checksums for wallets, `@handle` for usernames). No LLM in this path — it must work
   offline, deterministically, in under 1 ms.
2. **Ambiguity is normal.** `raven.io` is a domain and possibly a company name; `alice` is a
   username and a person name. The intake returns a ranked list; if the top two are within a
   confidence delta, the UI asks once, and remembers the answer for the session.
3. **Free text** falls through to a `text.query` entity type, whose capabilities are search
   aggregation and (opt-in) LLM-assisted entity extraction — never a silent guess about what the
   analyst meant.
4. **Context matters.** A query launched from a selected node inherits it as context: the same
   string typed on an empty canvas and typed while a `Person` node is selected produce different
   plans (`relatedTo` seeds), and the plan UI says so.

---

## 4. The capability router

Input: `(entities[], mode, credentials, budget, policy, userOverrides)`.
Output: an ordered, scored, filtered set of capability invocations.

Filter chain, in this order (each stage records why something was dropped, and the plan UI can show
"12 capabilities hidden: 7 need a key, 3 need network, 2 exceed budget"):

1. **Type match** — `inputs` accepts at least one entity in the query.
2. **Mode gate** — §8. In `local`, `offline === false` is dropped unless the query is explicitly
   marked online.
3. **Credential gate** — `credential: 'required'` without a stored key is dropped (and surfaced as a
   one-click "connect" affordance, never as a silent absence).
4. **Policy gate** — workspace policy may forbid `kind: 'active'`, a legal posture, or a named
   vendor outright.
5. **Budget gate** — estimated cost/latency must fit the remaining budget.
6. **Health gate** — an engine with an open circuit breaker (§6.4) is skipped, with its cooldown
   shown.
7. **Value scoring** — remaining capabilities are ranked by
   `expectedYield × precision × freshness ÷ (normalizedCost + normalizedLatency)`, where
   `expectedYield` is a decayed historical average of accepted (not merely produced) nodes per run
   for that capability on that entity type. Cold start uses the descriptor's declared `quality`.
8. **Redundancy pruning** — capabilities producing the same `(input, output)` pair are grouped;
   the top-scored one runs, the rest become one-click "also try" options. Exception: capabilities
   flagged `corroborating: true` (independent sources of the same fact) — for those, running two is
   the point, and agreement raises confidence (§7.4).

The router is a pure function over descriptors and state. It is unit-tested with a fixture registry
and has no I/O — this is what makes routing behaviour reviewable rather than emergent.

---

## 5. Planning

The plan is the reviewable artifact between intent and execution.

```ts
export interface QueryPlan {
  id: string;
  query: { raw: string; entities: EntityRef[]; context?: EntityRef[] };
  mode: RunMode;
  stages: PlanStage[]; // sequential; steps inside a stage are concurrent
  budget: Budget; // { wallMs, requests, credits, maxNodes, maxDepth }
  estimates: { wallMs: number; credits: number; nodesLow: number; nodesHigh: number };
  hidden: HiddenCapability[]; // dropped by the router, with the reason
  seed: string; // deterministic replay
  createdAt: string;
}
```

- **Stage 0** is always local and free: cache lookup, existing-board matches, offline enrichment.
  The analyst sees something within ~200 ms even when every network engine is slow.
- **Later stages** are formed by dependency: a capability whose input is produced by an earlier
  capability (subdomain → HTTP probe → tech fingerprint) sits in a later stage. Depth is capped by
  `budget.maxDepth` (default 2 for an interactive query, configurable up to 4 for a deep run).
- **Fan-out control.** A stage that would emit more than `maxNodes / stages.length` inputs to the
  next stage is truncated by score, and the truncation is a visible fact in the run report — never a
  silent cut.
- **Approval.** In default mode a plan with zero paid steps auto-runs; any paid step, any `active`
  step, or any step whose posture is riskier than `public-api` requires an explicit run click.
  This threshold is a workspace setting, not a hard-coded constant.

---

## 6. Execution

### 6.1 Executor

A stage runs its steps concurrently under a global semaphore (default 6, per-engine limits from
`rateLimit`). Every step is wrapped in: timeout → retry (only for idempotent, retriable failures,
exponential backoff with jitter, max 2) → circuit breaker → per-engine token bucket.

### 6.2 Streaming

Steps emit `QueryEvent`s (`step.started`, `entity.found`, `relation.found`, `step.progress`,
`step.failed`, `step.done`, `plan.done`) over the same transport the rest of the app uses. The UI
renders entities as they arrive; the canvas never waits for the slowest engine.

### 6.3 Cancellation and budget exhaustion

Cancellation is cooperative and immediate at the executor, with kill signals to child processes and
`AbortController` to HTTP clients. Budget exhaustion is a **normal** outcome: the run finishes as
`partial`, keeps everything already produced, and offers "continue with +N requests / +M credits".

### 6.4 Failure semantics

| Failure                      | Behaviour                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| Timeout                      | step `failed`, plan continues, engine's failure counter increments                  |
| HTTP 429 / quota             | back off, mark engine `throttled`, requeue once if budget allows, else skip         |
| Auth failure                 | engine marked `credential-invalid`, disabled for the session, one clear UI prompt   |
| Adapter contract violation   | quarantine the engine for the session, log to run history, never surface its output |
| 3 consecutive failures       | circuit opens for 5 min (exponential to 1 h), visible in the plan's health column   |
| Every step in a stage failed | run is `degraded`, not `failed`, provided any earlier stage produced results        |

### 6.5 Caching

Cache key: `capabilityId + normalized input + descriptor version + engine version`. TTL comes from
`quality.freshness` (`live` 5 min, `cached` 24 h, `historical` 30 days), overridable per engine, and
bypassable with an explicit "force refresh". Cached hits are marked as such in provenance — a
cached answer must never masquerade as a live one.

---

## 7. Normalization, deduplication, linking

### 7.1 Normalization

Each adapter returns its native shape; a per-capability **mapper** converts it into
`ProposedEntity` / `ProposedRelation` in the canonical domain model. Mappers are pure, versioned,
and unit-tested against recorded fixtures of real engine output (`18_TESTING.md`). Canonicalization
rules live in the domain package, not in mappers: lower-cased and punycode-normalized domains, E.164
phones, RFC-normalized e-mail (without over-normalizing `+` tags — they are evidence), IPv6
compressed form, URLs normalized with tracking-parameter stripping recorded as a transformation.

### 7.2 Identity and blocking

Every entity gets a deterministic `identityKey` per type (e.g. domain: the punycode string; person:
nothing — persons are never auto-merged on name alone). Exact `identityKey` matches merge silently.
Everything else goes through probabilistic resolution: blocking keys (name trigram, e-mail local
part, phone last 7, handle) generate candidate pairs; a Splink-style Fellegi–Sunter model
(`22_ECOSYSTEM_AUDIT.md` §4) scores them.

### 7.3 Merge policy

| Score       | Action                                                                |
| ----------- | --------------------------------------------------------------------- |
| ≥ 0.95      | auto-merge, recorded in the merge audit log, one-click un-merge       |
| 0.70 – 0.95 | queued in the review surface as "possible duplicate", both nodes stay |
| < 0.70      | separate entities; a weak `possiblySameAs` edge only if ≥ 0.50        |

Merging is never destructive: a merge is an event with both source records retained, and un-merge
restores the exact prior state (this is a CRDT-safe operation, see `08_DATA_MODEL.md`).

### 7.4 Confidence and corroboration

Every entity and relation carries `confidence ∈ [0,1]` = engine-declared precision × source
agreement × age decay. Two independent engines producing the same fact raise confidence
(noisy-OR, capped at 0.99); two engines that share an upstream source (a SERP reseller and the
underlying engine) do **not** — descriptors declare `upstream` so the layer can tell genuine
corroboration from an echo.

### 7.5 Link derivation

Beyond edges an engine states explicitly, the layer derives edges from co-occurring attributes
(shared registrant e-mail, shared certificate SAN, shared analytics ID, shared password-reset
signature). Derived edges are typed, always carry `derivedBy` + the evidence attribute, are
rendered distinctly (`07_EDGE_SYSTEM.md`), and are individually rejectable — a derived link is a
hypothesis, and an OSINT product that hides that distinction is a liability.

---

## 8. Run modes

| Mode                | What runs                                                                          | Guarantee                                                     |
| ------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Local-only**      | `offline: true` capabilities only                                                  | no socket is opened; verified by the sandbox, not by trust    |
| **Zero-credential** | + keyless network capabilities (crt.sh, RDAP, Wayback, GLEIF, self-hosted SearXNG) | no account, no key, no spend                                  |
| **Free-tier**       | + capabilities whose free tier covers this query                                   | spend stays at zero; quota burn is tracked and warned         |
| **Full**            | + BYOK paid capabilities within budget                                             | cost estimated before the run, tracked during, reported after |

`APP_MODE=local` defaults to **Zero-credential** with a first-run choice to drop to Local-only.
Mode is per query, remembered per project, and always visible on the query bar — an analyst must
never wonder whether the last search touched the network.

---

## 9. Safety, legality, provenance

`LegalPosture` is a required descriptor field with a fixed vocabulary, and it propagates onto every
node and edge produced:

| Posture            | Meaning                                         | Example                               |
| ------------------ | ----------------------------------------------- | ------------------------------------- |
| `local-only`       | no third party involved                         | file parsing, local models            |
| `open-data`        | published open dataset or public-domain source  | Common Crawl, GLEIF, CT logs          |
| `public-api`       | documented API used as intended                 | Brave Search, RDAP, Shodan with a key |
| `courtesy-service` | free public service without a contract          | crt.sh, Wayback                       |
| `scraping`         | site content fetched outside a documented API   | username checks, metasearch           |
| `active-probe`     | traffic sent to the target's own infrastructure | httpx, nuclei, port checks            |
| `licensed-data`    | paid data with redistribution limits            | OpenSanctions, OpenCorporates, IntelX |

Rules: `active-probe` capabilities require a per-target authorization acknowledgement, recorded with
the run. `licensed-data` output is flagged `redistribution: restricted` and excluded from exports
unless explicitly overridden. `scraping` output is labelled in the inspector so an analyst can judge
evidentiary weight. LLM-driven browsing agents run only inside the sandbox described in
`15_SECURITY.md` (egress allow-list, no ambient credentials, pinned dependencies) — untrusted page
content is treated as hostile input, never as instructions. All outbound fetches go through
`safeFetch` (SSRF guard, private-range block, redirect pinning, size cap). Credentials never enter
plans, events, run history, exports or logs.

---

## 10. The query as a first-class object

A run is stored (`08_DATA_MODEL.md`) as a `QueryRun`: plan, seed, mode, budget, per-step outcomes,
raw-response digests, produced/accepted/rejected counts, cost actually spent. Consequences:

- **A saved query is a canvas node.** It can sit on the board, be re-run, and be scheduled.
- **Re-run produces a diff** — new, changed, disappeared — never a second copy of the same graph.
  "What changed since Tuesday" is the answer OSINT work actually needs.
- **Audit.** Every node's inspector answers "which run, which engine, which input, when, under which
  posture, at what confidence" in one click.
- **Reproducibility.** Same plan + same seed + cached responses reproduce the same graph, which is
  what makes the acceptance tests in P17 possible at all.

---

## 11. Interface contracts (package layout)

```text
packages/domain/src/query/        capability.ts, selectors.ts, plan.ts, provenance.ts, confidence.ts
packages/query-engine/            router.ts, planner.ts, executor.ts, budget.ts, cache.ts,
                                  normalize/, resolve/ (blocking, scoring, merge), derive/
apps/web/src/features/query/      query bar, plan review, streaming results, review queue
apps/api/src/routes/query/        server-mode execution (same planner, remote executor)
```

`packages/query-engine` depends on `packages/domain` and `@nexus/transforms` only. It must not
import from `apps/*`, from `packages/canvas-engine`, or from any adapter package — adapters are
injected as a registry at construction, and `@nexus/transforms` must never import back.
dependency-cruiser enforces both directions.

---

## 12. Seam with the transform layer (L4)

L4.1 already shipped `packages/transforms` (`@nexus/transforms`): frozen transform/engine/provider
manifests, a validating registry, mode filtering, explainable scoring, a capability router with
fallback chains, and an expand planner with budgets and mandatory exclusion reasons — all pure, with
nothing executing. This layer **builds on that package; it does not re-implement it.**

| Concern                                                                                                                                                                     | Owner                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Transform/engine/provider manifests and catalogue, registry validation, mode gating, scoring, transform-level routing and the expand planner                                | `@nexus/transforms` (`21_TRANSFORM_SYSTEM.md`) |
| Query intake and entity typing, non-transform capability sources, execution, budgets at run time, normalization, entity resolution, confidence, provenance, query lifecycle | `packages/query-engine` (this document)        |

Concretely:

1. `CapabilityDescriptor` (§2) is the **union view**. For transforms it is projected from
   `TransformManifest` + `EngineManifest` by one adapter (`adapters/transform-registry.ts`); for
   direct integrations it is projected from the P9/P10 integration manifest. No metadata is
   hand-written twice, and both projections are contract-tested against their source.
2. Routing and scoring for transform capabilities delegate to `routeForInput` / `routeTransform`
   and the L4 scorer rather than duplicating them; §4's filter chain wraps that result and applies
   only the stages L4 does not own (credentials, health, redundancy, cross-source value scoring).
3. `planExpand` from L4 produces the transform sub-plan; §5's staged `QueryPlan` embeds it as one
   step with its own internal fan-out, and reconciles budgets by handing the sub-planner a slice of
   the global `Budget` (the L4 `Budget` shape is reused, not redefined).
4. Execution, normalization, dedupe, confidence, provenance and merge are applied uniformly to
   transform output and direct-adapter output, so both look identical on the canvas. L4.4 is where
   transforms actually execute; until then this layer's transform steps are plan-only.
5. Dependency direction is one-way: `packages/query-engine` imports `@nexus/transforms`; the
   transform package must never import the query engine. If the registry is empty or the package is
   disabled, the router simply sees no transform capabilities and everything else still works.
6. Exclusion reasons are a shared vocabulary: L4's `PlanExclusion` values surface unchanged in
   §5's `hidden` list, so "why did this not run" reads the same wherever the answer came from.

## 13. Performance targets

| Metric                                                | Target                   |
| ----------------------------------------------------- | ------------------------ |
| Intake → typed entity + ranked candidates             | ≤ 1 ms (pure functions)  |
| Plan produced for a 40-capability registry            | ≤ 15 ms                  |
| First result visible (stage 0, cache/local)           | ≤ 200 ms p95             |
| Router + planner overhead as a share of a network run | ≤ 2 %                    |
| Normalization + dedupe of 1,000 produced entities     | ≤ 400 ms                 |
| Streaming 1,000 entities into the review surface      | no dropped frame > 16 ms |
| Memory for a 10,000-entity run                        | ≤ 150 MB in the worker   |

Benchmarks live in `bench/query/` and are part of the ≤ 5 % regression gate.

---

## 14. Observability

Emitted per run: `raven_query_runs_total{mode,status}`,
`raven_query_step_duration_seconds{capability}`, `raven_query_step_failures_total{capability,reason}`,
`raven_query_entities_total{capability,accepted}`, `raven_query_cost_units_total{engine}`,
`raven_query_cache_hit_ratio`, `raven_query_dedupe_merges_total{auto,reviewed}`. In local mode these
stay on-device and feed the run report; nothing is sent anywhere.

---

## 14a. Presets, workflows and cost gating (Part 2 §42–§44)

Shipped 2026-08-31: `presets.ts` (seven named bundles of depth, budget and cost ceiling),
`workflow.ts` (saved pipelines, validated and compiled into a normal `TransformPlan`) and the
per-step cost gate in `packages/transforms/src/cost.ts`. Design, boundaries and the honest gap list
live in `28_PART2_COVERAGE.md`, batch §42–§44. Open question 3 below is now partly answered in
data: Deep Scan is the preset that admits minute-scale runs, and its budget states the ceiling.

---

## 15. Open questions (to resolve inside P17, not before)

1. Whether the value-scoring model's historical yield is per workspace or per user — privacy vs
   quality; default per workspace, opt-out available.
2. Whether entity resolution runs in the browser (wasm Splink-equivalent) or only in the worker for
   large runs; the interface is written so either can be true.
3. How deep a "deep run" may go before it becomes a scheduled background job rather than an
   interactive query — current guess is `maxDepth > 2` or estimated wall time > 60 s.

## Automatic service recommendation (Part 2 §41)

A query does not fire every engine in the catalogue. `recommendServices()`
(`packages/query-engine/src/recommend.ts`) types the input, routes it once, and returns three tiers
the analyst can act on without reading a catalogue:

- **Required** — the core coverage for this entity kind (`priority: core`, and something usable can
  run it). For `example_user`: profile discovery → Sherlock.
- **Recommended** — broadens coverage (`priority: recommended`), e.g. web mentions.
- **Optional** — everything else, _plus_ anything the router refused, carrying the reason
  ("needs credentials", "blocked by the current execution mode") instead of silently vanishing.

The tiering is data-driven: it reads the `priority` each transform manifest already declares and the
router's verdict, so no second ranking heuristic can drift away from `21_TRANSFORM_SYSTEM.md §6`.
Deprecated transforms are not offered at all; each capability appears once, represented by its
best-scoring transform.

Two selections come out of it: `runAll` — every offer that can actually run (never one that cannot,
so **Run all** never means "fail nine times") — and `defaultSelection`, required + recommended, which
is where **Customize** starts. The layer proposes; execution still needs the analyst's commit (N4).
UI for the two buttons is not built yet; this is the model behind them.
