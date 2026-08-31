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

## 5. Adapter boundary (§37)

The core knows exactly five things: **input, execution, progress, output, error**. It never learns
that an engine is Python, Docker or a CLI — `AdapterRegistry.for(engine)` resolves an adapter by
the passport's runtime and hands back an `EngineAdapter`. This is invariant **R1** (core stays
tool-agnostic) expressed in types.

`AdapterProgress.fraction` is `number | null`: an adapter that cannot measure progress reports
`null` rather than an invented percentage.

`canDispatch()` returns a typed refusal — `host-incompatible`, `adapter-planned`, `no-adapter` —
so a skipped engine always states why (invariant U5, partial beats perfect).

## 6. Multi-runtime support (§38)

`ENGINE_RUNTIMES` accepts node, python, go, rust, cli, http, external-api and browser-worker. What
is actually wired is a separate, honest table — `ADAPTER_SUPPORT`:

| Runtime                               | Adapter     |
| ------------------------------------- | ----------- |
| node, http, external-api, cli, python | implemented |
| go, rust, browser-worker              | planned     |

The architecture is ready for all eight; the UI says "adapter planned" for the three that are not,
rather than failing at run time.

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
2. The `cli` / `python` adapters and their host binding exist
   (`apps/runner/src/executors/engineAdapters.ts`, routed through the existing `ExecutionLayer`, so
   an engine run is confined exactly like every other run). What is still missing is upstream of
   them: the query executor does not yet dispatch a plan step through `AdapterRegistry`, and the
   containerized engines have no pinned image digest (`13_SHERLOCK.md` §1.2).
3. No external worker implementation ships with the repo; the queue is exercised by tests only.
4. Footprints for derived passports are conservative defaults, not measurements. Real numbers come
   from running the engines under the resource manager (`29` §6) and recording what they use.
