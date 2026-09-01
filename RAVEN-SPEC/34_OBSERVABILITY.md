# Raven — 34 — OBSERVABILITY (§64)

## Scope

What an operator can actually see while engines run: structured logs, the Prometheus metrics that
exist, engine latency, failure classes, queue depth and resource usage. Metric names are **not**
invented here — `19_DEPLOYMENT.md` §10.2 fixes them and says implementations must use exactly those.
This document records which of them are emitted, by which file, and which are still absent.

Non-goals: dashboards and alert delivery (no Prometheus server is deployed — see
`HIDDEN_CLOUD_DEPLOYMENT.md` §12), tracing (§10.1, not built), error tracking (§10.4, not built).

---

## 1. Logs

`packages/config/src/log.ts` is the only logger factory. Pino, JSON, one line per event, with
`service` / `env` / `version` as bindings and a redaction list covering secret field names and
secret-shaped values. Every service builds its logger from it (`raven-api`, `raven-sync`,
`raven-worker`, `raven-runner`). Log lines carry a stable `event` enum (`run.claimed`,
`parse.finished`, `plan.finished`, `watch.finished`, `embed.finished`, `metrics.depth_failed`, …)
so a query can group them without parsing prose.

## 2. Metrics that exist

| Family                                  | Labels                         | Emitted by                        |
| --------------------------------------- | ------------------------------ | --------------------------------- |
| `raven_http_requests_total`             | service, method, route, status | `apps/api/src/plugins/metrics.ts` |
| `raven_http_request_duration_seconds`   | service, route                 | same                              |
| `raven_sync_*` (8 families)             | see §10.2                      | `apps/sync/src/metrics.ts`        |
| `raven_queue_depth`                     | queue                          | `apps/worker/src/metrics.ts`      |
| `raven_job_duration_seconds`            | queue, job                     | same                              |
| `raven_job_failures_total`              | queue, job, reason             | same                              |
| `raven_job_retries_total`               | queue, job                     | same                              |
| `raven_runs_total`                      | tool, status                   | `apps/runner/src/metrics.ts`      |
| `raven_run_duration_seconds`            | tool                           | same                              |
| `raven_run_output_bytes`                | tool                           | same                              |
| `raven_runner_concurrent_runs`          | —                              | same                              |
| `raven_runner_sandbox_violations_total` | kind                           | same                              |

### 2.1 Engine latency and failure class (runner)

`observeRun(tool, result)` runs for every finished execution, including the ones that failed before
the executor produced output. `outcomeOf()` maps the run's terminal status and error code onto the
five classes §10.2 requires:

| Class            | Sources                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `success`        | `succeeded`, `partial` (U5 — partial beats perfect, it produced entities)                                   |
| `timeout`        | `timed_out`, `TIMEOUT`, `START_TIMEOUT`, `QUEUE_TIMEOUT`, `IMAGE_PULL_TIMEOUT`, `PARSE_TIMEOUT`             |
| `resource_limit` | `OOM_KILLED`, `QUOTA_EXCEEDED`, `RATE_LIMITED`, `CONCURRENCY_LIMIT`, `OUTPUT_TOO_LARGE`, `EGRESS_THROTTLED` |
| `blocked`        | egress / consent / permission / approval / registry / sandbox denials                                       |
| `failed`         | everything else, plus `cancelled`                                                                           |

Cancellation counts as `failed` deliberately: the `RunFailureRate` alert is a ratio of non-success
runs and a killed run delivered nothing. Sandbox violations are counted from `stats.egressDenied`
(kind `network`) and from a `SANDBOX_VIOLATION` payload whose `detail.kind` is one of
`network|filesystem|caps|pids`; an unknown kind is dropped rather than passed through, so the label
set cannot be widened by a tool's output.

### 2.2 Queue depth and job latency (worker)

`measureJob(queue, job, handler)` wraps every handler the worker registers
(`integration.parse`, `github`, `watchers`, `ai.embed`): duration always, `jobRetries` when
`attemptsMade > 0`, `jobFailures` with a low-cardinality `reason` (an error `code` if the thrower
supplied one, else the error class name), then re-throws so BullMQ's retry policy stays the single
source of truth. Depth cannot be derived from a handler, so `pollQueueDepth()` reads
`getJobCounts('waiting', 'delayed')` every 15 s; a failing poll is logged, never fatal.

### 2.3 Resource usage

`RunStats` already carries `bytesOut`, `egressRequests`, `egressDenied`, `peakMemMiB` per run and is
persisted on the run row. `peakMemMiB` is **not** exported as a metric yet — §10.2 defines no family
for it, and inventing one would break the "exactly these names" rule.

## 3. Scrape endpoints

| Service | Port | Notes                                 |
| ------- | ---- | ------------------------------------- |
| api     | 9464 | always started                        |
| sync    | 9465 | always started                        |
| runner  | 9466 | binds only when `METRICS_PORT` is set |
| worker  | 9467 | binds only when `METRICS_PORT` is set |

Runner and worker use `node:http` rather than Fastify — neither service has an HTTP framework in
its dependency tree, and a scrape endpoint is not a reason to add one. They bind on demand so that
tests and `pnpm dev` never hold a listener.

## 4. Gaps

1. No Prometheus, Grafana or alertmanager runs anywhere — the rules in `infra/alerts/` and the alert
   table in §10.5 have no evaluator (`HIDDEN_CLOUD_DEPLOYMENT.md` §12).
2. Missing metric families from §10.2: auth, documents, egress/SSRF, files, AI, client RUM, database
   pool and query duration, `raven_migration_pending`, `raven_backup_last_success_timestamp`.
3. OpenTelemetry traces (§10.1) and the Sentry/GlitchTip sink (§10.4) are not wired.
4. `trace_id` / `span_id` are declared mandatory log fields but nothing populates them, because there
   is no tracer.
5. Log retention is whatever Docker's json-file driver holds (10 MB × 5 per service); the 30-day hot
   and 12-month audit retention in §10.3 needs a shipper that is not deployed.
