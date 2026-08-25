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

## 7. Hidden Cloud (§33) — resolved: a self-managed Linux VPS

**Decision (owner, 2026-08-25):** "Hidden Cloud" is **not** a PaaS. It is an ordinary self-managed
Linux VPS from a mainstream provider — the same class of box most self-hosted sites run on: a full
VM with root, a normal kernel, and no platform sandbox above it.

That answers §33's question, and it flips the assumption from "assume nothing" to "assume a plain
VM, and verify the numbers on the actual box before sizing anything." The rule §33 exists to
enforce still holds in a narrower form: **capacity is unverified until measured** (§7.2), and no
technology choice may depend on a managed-platform feature the VM does not have (no autoscaling,
no managed queue, no ephemeral-filesystem semantics, no provider secret store).

### 7.1 Baseline profile

| Capability              | Answer                                                              | Basis                      |
| ----------------------- | ------------------------------------------------------------------- | -------------------------- |
| operating system        | Ubuntu LTS (22.04 / 24.04), Debian-family userland                  | owner decision, 2026-08-25 |
| CPU architecture        | x86_64 (arm64 builds must stay possible — no x86-only binaries)     | owner decision, 2026-08-25 |
| RAM                     | VM-sized, **measure before sizing**                                 | unmeasured — §7.2          |
| storage                 | persistent block disk mounted on `/`; survives restart and redeploy | VM semantics               |
| networking (egress)     | unrestricted outbound                                               | VM semantics               |
| open ports              | full control; expose 80/443 only, everything else behind the proxy  | owner decision             |
| process model           | full multi-process, `fork`/`exec` allowed                           | VM semantics               |
| Docker support          | **yes** — Docker Engine + Compose                                   | owner decision, 2026-08-25 |
| other container runtime | Podman available if wanted; Kubernetes explicitly **not** used      | owner decision             |
| language runtimes       | Node 22 (pinned), plus whatever is installed in images              | repo toolchain             |
| background workers      | yes — `apps/worker`, `apps/runner` as long-lived services           | VM semantics               |
| cron                    | yes — systemd timers preferred over crontab (logging, dependencies) | owner decision             |
| WebSockets              | yes — proxied, `proxy_read_timeout` raised for long runs            | owner decision             |
| long-running processes  | yes — no platform request timeout                                   | VM semantics               |
| filesystem persistence  | yes — durable; local-first (N2) can hold real state on disk         | VM semantics               |
| environment variables   | yes — via systemd unit `EnvironmentFile=` / Compose `env_file`      | owner decision             |
| secrets storage         | root-owned `0600` env files on disk; **no provider secret manager** | owner decision             |
| reverse proxy           | nginx (or Caddy) terminating TLS, Let's Encrypt                     | owner decision             |
| deployment mechanism    | build image in CI → pull on host → `docker compose up -d`           | owner decision             |
| build pipeline          | GitHub Actions (already green: build, docker (api), docker (web))   | repo CI                    |
| process manager         | systemd for host units; Docker restart policies for containers      | owner decision             |

### 7.2 What is still unverified — and how it gets verified

Capacity and the exact OS build are properties of a specific machine, not of "a VPS". They are
filled by running `scripts/survey-host.sh` **on the host** and pasting its output here with a date.
Until then, sizing in `packages/query-engine/src/resources.ts` keeps its conservative defaults
(2 cores / 1 GB / 2 GB disk) rather than inventing a bigger budget.

Open lines: RAM, core count, disk size, kernel version, Docker version, arch confirmation.

### 7.3 Consequences for engine selection

Supersedes the restriction in `26` §4:

- Containerized engines (Sherlock, SpiderFoot) are **unblocked** — they run as containers with
  explicit `--memory`, `--cpus`, `--pids-limit` and a read-only rootfs, sized by §6's budget.
- `http` and `builtin` kinds stay preferred where an API exists: cheaper, faster, easier to audit.
- Root is available but is **not** a licence to skip limits. One tenant, one box: the resource
  manager (§6) is the only thing standing between a heavy engine and the whole server, and §32
  applies exactly as written.
- No Kubernetes, no GPU, no custom kernel modules — those remain out of scope by choice, not by
  ignorance.

## 8. Gaps

1. Run history is session-scoped; persistence in `@nexus/db` is not built.
2. Limits are enforced at the boundary (`acquire`) — there is no in-process kill switch for an
   engine that ignores its own timeout; that needs the runner, not the browser.
3. Heartbeat progress for long engines is not emitted, so `queue` is coarse.
4. §7.2 — host capacity (RAM, cores, disk, Docker version) is unmeasured; run
   `scripts/survey-host.sh` on the box and record the output with a date before raising the
   resource budget.
