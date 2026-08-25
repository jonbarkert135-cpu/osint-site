# Raven — 29 — RUNTIME: HEALTH, ISOLATION, LIMITS, ENVIRONMENT (Part 2 §27–§33)

## Scope

One question: **what does the app know about the machinery that runs an engine, and what does it
refuse to assume?** Health surface (§27), engine passports (§28), partial failure (§29), operator
actions (§30), timeouts (§31), the resource manager (§32) and the Hidden Cloud constraint (§33).

Non-goals: engine selection (`26`), the run pipeline itself (`24`), deployment topology
(`19_DEPLOYMENT.md`, which describes a _target_, not a verified environment).

---

## 1. Health is derived, never declared (§27)

`packages/query-engine/src/health.ts` computes health from run records only. Nothing anywhere sets
a status by hand, because a hand-set status is a status that can lie.

| Field               | Source                                                 |
| ------------------- | ------------------------------------------------------ |
| service / runtime   | engine manifest (`provider`, `capability`)             |
| version             | `engineVersion` on the last run, else manifest version |
| health              | derived (below)                                        |
| queue               | runs still `running`                                   |
| response time       | median of `finishedAt - startedAt` over completed runs |
| failures            | `failed` runs / total runs                             |
| last successful run | newest `completed`/`partial` run timestamp             |

States: `online`, `degraded` (`partial`, or any failure in the window), `offline` (>3 consecutive
failures), `disabled` / `ignored` (operator policy, §30), `unknown` — **the honest default**. An
engine that has not run in this session says _Not run yet_; it does not say Online.

The store (`apps/web/src/system/runtimeStore.ts`) is in-memory and session-scoped by design.
Persisted run history belongs in `@nexus/db`; until it lands, a reload resets to `unknown` rather
than showing yesterday's green dot. Marked as a gap below, not hidden.

## 2. Engine registry (§28)

`/system` → _Engines_ renders one passport per manifest: name, version, category, status, supported
inputs, outputs, permissions (`network|filesystem|subprocess|credentials|browser`), resource
budget and compatibility. All of it is read out of the manifests the run actually uses — the page
is a view, not a second list that can drift.

## 3. One dead service never kills the query (§29)

`runIsUsable()` and the results dashboard treat runs independently: a `failed` engine renders its
own error row while every other engine's results stay on screen. This is invariant **U5 — partial
beats perfect**, enforced in code and covered by a test that asserts healthy rows survive a failed
neighbour.

## 4. Operator actions (§30)

Per engine: `Retry`, `Retry failed only`, `Restart`, `Disable`, `Enable`, `Ignore`.
`applyAction()` is a pure policy transition; the System page **records intent** and never executes
(invariant N5). Retries are consumed by the run layer, so the button cannot become a second,
uncontrolled execution path.

## 5. Timeouts and limits (§31)

`EngineLimits`: `startupTimeoutMs` (5 000), `executionTimeoutMs` (30 000), `memoryLimitMb` (256),
`concurrency` (2) — defaults, overridable per engine. A run past its budget ends as **Timed out**,
which is a `failed` run with a stated reason, and the rest of the query continues (§29).

## 6. Resource manager (§32)

`packages/query-engine/src/resources.ts`. Every engine acquires before it runs; nothing bypasses it.
Budget: CPU cores, RAM, disk, process count, global concurrency, network requests, total execution
time. A single engine may take at most **60 %** of any dimension (fair share), so one heavy tool
cannot starve the others. Refusals are typed (`cpu|memory|disk|processes|concurrency|engine-concurrency|network|execution-time`)
and surfaced as a reason, never as a silent hang.

## 7. Hidden Cloud (§33) — **unverified, and treated as hostile**

**Status: the survey has NOT been done.** "Hidden Cloud" is not a vendor whose documentation this
project has read, and no capability below has been confirmed. Until each line is answered with a
citation and a date, the working assumption is the most restrictive one:

> No Docker. No Kubernetes. No root. No privileged containers. No systemd. No arbitrary binaries.
> No GPU. No background daemons. No custom kernel modules. No unrestricted subprocesses.

Consequence, already binding on `26` §4: prefer `http` and `builtin` execution kinds; any engine
needing a container (Sherlock today) is **blocked** until a container runtime is confirmed.

### 7.1 Survey checklist — every line `unverified` until sourced

| Capability              | Answer     | Source / date |
| ----------------------- | ---------- | ------------- |
| operating system        | unverified | —             |
| CPU architecture        | unverified | —             |
| RAM                     | unverified | —             |
| storage                 | unverified | —             |
| networking (egress)     | unverified | —             |
| open ports              | unverified | —             |
| process model           | unverified | —             |
| Docker support          | unverified | —             |
| other container runtime | unverified | —             |
| language runtimes       | unverified | —             |
| background workers      | unverified | —             |
| cron                    | unverified | —             |
| WebSockets              | unverified | —             |
| long-running processes  | unverified | —             |
| filesystem persistence  | unverified | —             |
| environment variables   | unverified | —             |
| secrets storage         | unverified | —             |
| reverse proxy           | unverified | —             |
| deployment mechanism    | unverified | —             |
| build pipeline          | unverified | —             |
| process manager         | unverified | —             |

Filling this table needs one fact from the owner: **which provider "Hidden Cloud" actually is.**
Guessing it would be the exact failure §33 was written to prevent.

## 8. Gaps

1. Run history is session-scoped; persistence in `@nexus/db` is not built.
2. Limits are enforced at the boundary (`acquire`) — there is no in-process kill switch for an
   engine that ignores its own timeout; that needs the runner, not the browser.
3. Heartbeat progress for long engines is not emitted, so `queue` is coarse.
4. The §33 table above is empty on purpose.
