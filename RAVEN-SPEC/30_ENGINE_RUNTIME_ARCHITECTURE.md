# Raven — 30 — ENGINE RUNTIME ARCHITECTURE (Part 2 §34–§39)

## Scope

How an engine actually gets executed, and what the core is allowed to know about it. Compatibility
matrix (§34), the rule against bending the architecture (§35), remote execution (§36), the adapter
boundary (§37), multi-runtime support (§38) and the engine manifest (§39).

Host it is judged against: `29_RUNTIME_ENVIRONMENT.md` §7 — a self-managed Linux VPS with root,
Docker Engine and a persistent disk.

---

## 1. The runtime passport (§39)

`EngineRuntimeSpec` in `packages/transforms/src/types.ts`, validated by `EngineRuntimeSchema`:

```jsonc
{
  "runtime": "python", // node | python | go | rust | cli | http | external-api | browser-worker
  "deployment": "containerized", // native | containerized | external | unsupported
  "requirements": {
    "image": "sherlock/sherlock:latest",
    "memoryMb": 512,
    "cpu": 1,
    "persistent": false,
  },
  "hostCompatible": true,
  "fallback": { "strategy": "external-worker", "target": "worker-eu-1" },
}
```

Two refusals are built into the schema, because both failures are silent otherwise:

- a `containerized` engine **must** name an image;
- an `unsupported` engine **must** name a fallback strategy (§35).

The field is optional on `EngineManifest`. `resolveRuntime()` fills it — declared passport first,
then a small explicit override table, then derivation from what the manifest already says
(`terminal` → native/no-op, `browser` permission → browser worker, `subprocess` → containerized
CLI, `external-api` → HTTP caller). All 38 catalogue engines therefore have a passport today
without 38 hand-written blocks that would rot.

## 2. Compatibility matrix (§34)

`compatibilityMatrix()` groups every engine into the four classes and the UI renders them as four
separate tables at `/system` → _Runtime_:

| Column          | Meaning                                                        |
| --------------- | -------------------------------------------------------------- |
| Engine          | manifest id                                                    |
| Runtime         | execution runtime, plus "(adapter planned)" when not yet wired |
| Docker          | true only for `containerized`                                  |
| RAM / CPU       | declared footprint, used to size container flags               |
| Persistent      | needs a writable path across runs                              |
| Host compatible | can it run on the profile in `29` §7                           |
| Alternative     | §35 strategy when it does not fit                              |

Current shipped catalogue: **35 native, 3 containerized** (`amass`, `sherlock`, `subfinder`),
0 external, 0 unsupported. Empty classes still render, with "None." — an empty class is an answer,
not a missing measurement.

`containerArgs()` produces the flags a containerized engine must run with:
`--memory`, `--cpus`, `--pids-limit=128`, `--read-only`, `--cap-drop=ALL`. Root on the box is not a
licence to skip limits.

## 3. Incompatible projects (§35)

An open-source tool that does not fit is never accommodated by reshaping the core. It gets one of
five recorded strategies: `native-adapter`, `external-worker`, `remote-execution`,
`optional-integration`, `replacement`. The strategy is data on the manifest, so it shows up in the
matrix and in the UI instead of living in someone's head.

## 4. Remote execution (§36)

```
Core → Remote Execution Queue → External Worker → Result API → Core
```

`packages/transforms/src/remote.ts`. The queue is the _option_, never the dependency: with no
worker attached, `shouldFallBackLocally()` returns true after `claimTimeoutMs` (10 s default) and
the run continues on the box. This preserves invariant **N2 — local-first**: Raven stays fully
usable on one machine. The queue is bounded (500 jobs) because an unbounded queue on a single VPS
is a memory leak with a nice name.

The worker half is `packages/transforms/src/remoteWorker.ts`: `createRemoteWorker()` claims a job,
runs it through an injected `execute`, and posts the result back. `claim`/`complete` are injected
too, so the same loop drives the in-process queue on one box or an HTTP Result API on a second
machine — the file holds no transport, no timer and no process API, which keeps it inside the
browser-safe bundle (N2) and the single process door in the runner (N5). A throw inside `execute`
becomes a retryable `internal` failure instead of a stopped drain (U5), and `drain(maxJobs)` is
bounded so one worker cannot hog the box. Scheduling — how often to call `drain()` — stays the
operator's decision.

The core half is `packages/transforms/src/queueAdapter.ts`: `createQueueAdapter()` is an ordinary
`EngineAdapter` that enqueues instead of executing, so a plan step reaches the queue without knowing
it exists. When a worker answered, its result is returned as-is — including a failure, which is the
worker's answer and not a reason to quietly run the tool twice. When nobody claimed the job, the
call falls back to the configured local adapter, and with no local adapter it reports
`unavailable`/retryable rather than hanging. _When_ a worker gets its turn is injected as `settle`,
so the file holds no timer and stays browser-safe (N2).

## 5. Adapter boundary (§37)

The core knows exactly five things: **input, execution, progress, output, error**. It never learns
that an engine is Python, Docker or a CLI — `AdapterRegistry.for(engine)` resolves an adapter by
the passport's runtime and hands back an `EngineAdapter`. This is invariant **R1** (core stays
tool-agnostic) expressed in types.

`AdapterProgress.fraction` is `number | null`: an adapter that cannot measure progress reports
`null` rather than an invented percentage.

`canDispatch()` returns a typed refusal — `host-incompatible`, `adapter-planned`, `no-adapter` —
so a skipped engine always states why (invariant U5, partial beats perfect).

`registryEngines(adapters, catalog)` (`sdk/engines/cli-engines.ts`) turns a registry into the engine
library the executor consumes: every shipped adapter-backed engine that `canDispatch` accepts on
this host, and nothing else. A host wires it with
`createEngineLibrary({ ...BUILTIN_ENGINES, ...registryEngines(adapters, catalog) })`; an engine
whose runtime has no adapter here is simply absent, and the executor skips its step as
`engine-unavailable` instead of the host pretending the tool is installed.

## 6. Multi-runtime support (§38)

`ENGINE_RUNTIMES` accepts node, python, go, rust, cli, http, external-api and browser-worker. What
is actually wired is a separate, honest table — `ADAPTER_SUPPORT`:

| Runtime                                         | Adapter     |
| ----------------------------------------------- | ----------- |
| node, http, external-api, cli, python, go, rust | implemented |
| browser-worker                                  | planned     |

The architecture is ready for all eight; the UI says "adapter planned" for the one that is not,
rather than failing at run time.

`go` and `rust` are compiled binaries the host invokes exactly like any other CLI, so they are
`createCliAdapter` with their own runtime label (`createGoAdapter`, `createRustAdapter`) rather than
new code: relabelling them `cli` would make the matrix lie about what an engine is. `browser-worker`
stays planned because it is genuinely different — it needs no process at all, and no engine in the
registry asks for it yet.

`cli` and `python` are one implementation (`src/cliAdapter.ts`): from the core's side both are
"render argv, run it somewhere, read stdout", and the difference between a Go binary and a Python
image is the host's business, not the core's. The adapter therefore imports no process API at all —
the host injects `spawn`. That is what keeps `@nexus/transforms` importable from the browser bundle
(N2) and keeps the single sanctioned process door inside the runner's container executor (N5).

The host half renders the command from the integration manifest and runs it through the runner's
`ExecutionLayer` — the caller's `timeoutMs` is a _ceiling_ on the manifest's wall clock, never an
extension of it. stdout is parsed as JSON lines, one JSON document, or plain lines — the three shapes that cover
subfinder/httpx/dnsx, API-style tools and Sherlock. Failures are typed rather than swallowed:
`timeout`, `unavailable`, `invalid-input` (the payload could not be rendered as argv), `upstream`
(non-zero exit; retryable only when the process was killed) and `internal`. Progress is reported as
`fraction: null` — a CLI does not know its own percentage and inventing one would put a lie into the
run console (§24).

## 7. Gaps

1. Adapter-backed engines (`packages/transforms/src/sdk/adapterEngine.ts`) join the adapters to the
   executor, and `sdk/engines/cli-engines.ts` ships subfinder, amass and sherlock as data-thin
   engine definitions. What is still missing is the last mile: the containerized engines have no
   pinned image digest, so they stay disabled-not-`:latest` until an operator pins one, and the web
   app deliberately does not offer them (a browser has no adapter — invariant N2).
2. Both halves now live in one process: `apps/runner/src/plan.ts` registers the host's four
   adapters, builds the engine library with `registryEngines()` and runs a plan through
   `executePlan`. The browser keeps its builtin-only library by design (N2). What is still missing
   is a caller: the runner now consumes `query.plan` (`zPlanJob`, `runPlanJob`/`runPlanQueueJob`),
   so a queue message asks this host for a plan and the events land on the run channel — but nothing
   in the web app enqueues one yet. The containerized engines also still have no pinned image digest
   (`13_SHERLOCK.md` §1.2).
3. The external worker loop ships (`packages/transforms/src/remoteWorker.ts`) and now has a
   transport — `httpQueue.ts`: `createHttpWorkerTransport()` for the worker, `handleQueueRequest()`
   as the Result API the core mounts. What is still missing is a deployment: nothing in the repo
   runs a worker on a second machine, so §36 is wired end to end in tests but not in production.
4. Footprints for derived passports are conservative defaults, not measurements. Real numbers come
   from running the engines under the resource manager (`29` §6) and recording what they use.

## 8. The manifest as one document (§39)

The engine manifest is stored split — engine / provider / transform (21_TRANSFORM_SYSTEM.md §3) —
because one engine serves several transforms and one provider several engines. Copying `inputs`,
`outputs` or `licence` onto the engine would create a second version of a fact that already exists,
and the copy is the one that goes stale.

`engineDocument()` (`packages/transforms/src/document.ts`) is therefore the _joined view_, not a
new file format: name, version, runtime, deployment, inputs, outputs, capabilities, transforms,
requirements, permissions, `execution` (cost, data flow, terminal, adapter state, host
compatibility, expected runtime, max results, docker flags) and the provider facts an installer
needs (credentials, pricing, licence, attribution). It is what `/system` → Engines and the install
pipeline read.

Two deliberate choices:

- **derived, never authored**: `inputs`/`outputs`/`capabilities` come from the transforms that route
  to the engine, so a manifest cannot advertise an input nothing accepts;
- **an unknown provider is never permissive**: the document reports `licence: "unknown"` and
  `credentials: "required"`, which makes the install gates refuse it instead of waving it through.

## 9. Installing an integration (§40)

`installEngine()` (`packages/transforms/src/install.ts`) is "Install Integration" as eight ordered
gates. It is pure: it takes an already-fetched bundle of manifests plus the checks it must not
invent, and returns a report — plus a **new** registry only when every gate passed. Downloading and
unpacking belong to the caller; judging belongs here.

| #   | Gate          | Refuses when                                                                      |
| --- | ------------- | --------------------------------------------------------------------------------- |
| 1   | manifest      | schema invalid, package does not compose, engine id already installed             |
| 2   | compatibility | the passport does not run on this host profile (`29` §7)                          |
| 3   | licence       | the provider is missing (no licence is stated) or its licence is not allow-listed |
| 4   | dependencies  | container image not pinned by digest, or registry validation reports an issue     |
| 5   | security      | it asks for a permission the workspace has not granted                            |
| 6   | adapter       | no adapter is implemented for its runtime (§37/§38)                               |
| 7   | health check  | the injected probe fails, returns a reason, or throws                             |
| 8   | register      | — records the resulting registry                                                  |

Rules that follow from the invariants: gates after the failing one report `not-run`, so the report
shows exactly where it stopped; the health probe is **required** in the context — an install nobody
probed is an install nobody can trust, and an unverifiable gate fails rather than being skipped
(N4/U5); nothing is mutated in place, so a failed install cannot leave a half-registered engine.

Known consequence, stated rather than papered over: an engine whose passport is _derived_ as
containerized (a `subprocess` permission with no declared runtime) carries no image, so gate 4
refuses it. Containerized engines must declare `runtime.requirements.image` with a `@sha256:` digest
to be installable. Not built here: fetching and signature verification of the package itself.
