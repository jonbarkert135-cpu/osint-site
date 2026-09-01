# HIDDEN CLOUD — DEPLOYMENT PLAN (§66)

**Read this first.** Nothing here is invented. Every line is either taken from a file in this
repository (path given) or from the owner's decision recorded in
`RAVEN-SPEC/29_RUNTIME_ENVIRONMENT.md` §7. Anything that depends on the actual machine, on a
provider feature, or on a service that is not in the stack yet is marked **UNVERIFIED** — that
marking is the point of this document. A plan that guesses is worse than a plan with holes in it.

Target, per owner decision 2026-08-25: **Hidden Cloud is an ordinary self-managed Linux VPS**
(Ubuntu LTS, x86_64, root, Docker Engine + Compose, no Kubernetes, no managed queue, no provider
secret manager, no autoscaling).

---

## 1. Architecture on the host

```
                internet :80 :443
                       │
                    caddy  (TLS, Let's Encrypt)          edge network
                   ┌───┴────┐
                 web        api ──────────┐               core network (internal)
                                          ├── postgres (pgvector/pgvector:pg16)
                 sync ────────────────────┤── redis    (redis:7-alpine)
               worker ────────────────────┤── minio    (S3 API)
               runner ──┐                 │
                        └── egress-proxy (envoy) ─────► internet   egress network
                              ▲
                   engine containers (sherlock, spiderfoot) — no direct egress
```

Sources: `infra/docker-compose.yml` (networks `edge` / `core` internal / `egress`,
`infra/caddy/Caddyfile`, `infra/egress/envoy.yaml`), `RAVEN-SPEC/19_DEPLOYMENT.md` §3.

**Gap, not a plan:** `infra/docker-compose.yml` currently defines
`postgres, redis, minio, api, web, egress-proxy, caddy` only. `sync`, `worker` and `runner` are
declared as "arrive with P8 / P9" in the file header and have **no compose service yet**. Their
runtime contract is known (below), the compose entries are not written. **UNVERIFIED** until they
exist and are started once on the box.

## 2. Processes

| Process        | Entry point                              | Compose service | Concurrency                                   |
| -------------- | ---------------------------------------- | --------------- | --------------------------------------------- |
| api            | `apps/api` (Fastify, port 3001)          | yes             | one container                                 |
| web            | static build behind Caddy                | yes             | one container                                 |
| sync           | `apps/sync` (Hocuspocus, 3002)           | **missing**     | one container (single writer per room)        |
| worker         | `apps/worker/src/main.ts`                | **missing**     | parse 4, github max spec, embed 4, watchers 1 |
| runner         | `apps/runner/src/main.ts`                | **missing**     | `RUNNER_CONCURRENCY` (default 2)              |
| egress-proxy   | envoy, `infra/egress/envoy.yaml`         | yes             | one container                                 |
| engine sandbox | one container per run, spawned by runner | n/a             | bounded by runner concurrency                 |

Queues consumed by `apps/worker`: `integration.parse`, `github`, `watchers`, `ai.embed`.
Queues consumed by `apps/runner`: `integration.run`, `query.plan` (`apps/runner/src/protocol.ts`).

## 3. Ports

| Port           | Who                  | Exposure                                   |
| -------------- | -------------------- | ------------------------------------------ |
| 80 / 443       | caddy                | public (only ports published in compose)   |
| 3001           | api                  | internal (`core`/`edge` networks)          |
| 3002           | sync                 | internal, proxied by Caddy for WebSockets  |
| 3003           | runner HTTP queue    | internal (`RUNNER_URL`)                    |
| 3128           | egress-proxy         | internal (`egress` network) only           |
| 5432/6379/9000 | postgres/redis/minio | internal network only                      |
| 9464           | api metrics          | internal, never through the ingress        |
| 9465           | sync metrics         | internal                                   |
| 9466           | runner metrics       | internal, binds only if `METRICS_PORT` set |
| 9467           | worker metrics       | internal, binds only if `METRICS_PORT` set |

## 4. Runtime

Node 22 (pinned in root `package.json` `engines`), pnpm 9.15.9, production images built from
`infra/docker/api.Dockerfile` and `infra/docker/web.Dockerfile`. Engine containers run with
`--memory`, `--cpus`, `--pids-limit`, read-only rootfs, seccomp + AppArmor profiles
(`apps/runner/src/sandbox/flags.ts`); `runsc` (gVisor) is selected when `NODE_ENV=production`,
`runc` otherwise — **UNVERIFIED**: gVisor is not installed by anything in this repo, so on a fresh
VPS the runner asks for a runtime the daemon does not have. Either install gVisor on the host or
change that selection before the first container run.

## 5. Storage

| Data                | Where                                                                       | Survives restart |
| ------------------- | --------------------------------------------------------------------------- | ---------------- |
| Postgres            | volume `pgdata`                                                             | yes              |
| Redis (AOF on)      | volume `redisdata`                                                          | yes              |
| Artifacts (`runs/`) | MinIO volume `miniodata`                                                    | yes              |
| TLS certs           | volumes `caddydata` / `caddyconfig`                                         | yes              |
| Backups             | bind mount `./backups` in postgres                                          | yes              |
| Run secrets         | tmpfs mount inside the run container (`apps/runner/src/sandbox/secrets.ts`) | no, by design    |

Disk sizing: **UNVERIFIED** — `RAVEN-SPEC/29_RUNTIME_ENVIRONMENT.md` §7.2 requires
`scripts/survey-host.sh` output pasted with a date before any sizing decision.

## 6. Environment variables

Full schema and validation: `packages/config/src/env.ts` (`loadServerEnvFromProcess()` fails fast).
Required in production: `NODE_ENV`, `NEXUS_ENV`, `DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`,
`S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `AUTH_SECRET` (≥32),
`AUTH_TRUSTED_ORIGINS`, `PUBLIC_APP_URL`, `SYNC_URL`, `SYNC_SHARED_SECRET`, `RUNNER_URL`,
`RUNNER_SHARED_SECRET`, `EGRESS_PROXY_URL`.
Optional / operational: `DATABASE_POOL_MAX`, `EGRESS_ALLOWLIST`, `LOG_LEVEL`, `FEATURE_FLAGS`,
`AI_PROVIDER`, `AI_BASE_URL`, `AI_API_KEY`, `AI_MONTHLY_BUDGET_USD`, `CREDENTIALS_MASTER_KEY`,
`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `RUNNER_CONCURRENCY`, `WORKER_CONCURRENCY`,
`METRICS_PORT`, `NEXUS_VERSION`.
Compose reads them from `.env` next to `infra/docker-compose.yml`; on the host that file is
root-owned `0600` (owner decision — no provider secret manager exists here).

## 7. Build

1. CI (`.github/workflows/ci.yml`) runs lint, typecheck, unit tests, coverage gate, migrate-check,
   CodeQL, Trivy, `docker (api)` and `docker (web)` image builds.
2. Images are tagged `ghcr.io/nexus/{api,web}:${NEXUS_VERSION}` (compose `image:` keys).
3. Base and tool images are pinned by digest — `scripts/pin-images.mjs` and
   `.github/workflows/pin-images.yml` verify the pins.
4. **UNVERIFIED:** nothing in this repo pushes those images to a registry the VPS can pull from, and
   no deploy workflow exists. Today the honest path is `docker compose build` **on the host**; a
   push/pull pipeline is a decision to make, not a fact to record.

## 8. Startup order

`docker compose up -d` respects the declared dependencies: postgres/redis/minio become healthy
(`pg_isready`, `redis-cli ping`, `mc ready local`) → api (healthcheck `GET /healthz`) → web → caddy.
Migrations run **before** api starts serving (§10). sync/worker/runner start after api; both worker
and runner only need Redis, Postgres and MinIO, so they can start in parallel with web.

## 9. Restart policy

`restart: unless-stopped` on every compose service (already in the file). No systemd unit is
required for the containers; a single systemd unit for `docker compose up -d` at boot is optional
because Docker restores `unless-stopped` containers itself. Host cron jobs (backups) use systemd
timers per owner decision. **UNVERIFIED:** no unit file or timer exists in this repo yet.

## 10. Migrations

- Apply: `pnpm db:migrate` (`prisma migrate deploy`) — run once per release, before the new api
  container takes traffic.
- Safety: every migration must be additive-safe; `scripts/check-migration-safety.mjs` fails CI on a
  destructive statement unless the file carries an explicit `-- safe: <reason>` line.
- Expansion/contraction: `RAVEN-SPEC/19_DEPLOYMENT.md` §8 — add column → backfill → switch reads →
  drop in a later release, so an old container and a new schema can overlap during a deploy.
- Repair path for projections: `pnpm db:reproject`.

## 11. Worker and runner startup

Both are plain Node processes: `node apps/worker/src/main.ts`, `node apps/runner/src/main.ts` (the
files start the service only when executed directly, so importing them in tests does not).
The runner additionally starts its egress proxy on 3128 and a reaper sweep every 30 s that kills
containers whose run row is no longer active. Set `METRICS_PORT` on each to expose `/metrics`.
**UNVERIFIED:** no container image is defined for either service — `infra/docker/` has api and web
Dockerfiles only.

## 12. Monitoring

Prometheus metric names are fixed by `RAVEN-SPEC/19_DEPLOYMENT.md` §10.2. Implemented today:

| Area       | Metrics                                                                                                                                             | Source                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| HTTP / API | `raven_http_requests_total`, `raven_http_request_duration_seconds`                                                                                  | `apps/api/src/plugins/metrics.ts` |
| Sync       | connections, rooms, update bytes, broadcast latency, projection duration/failures, doc memory                                                       | `apps/sync/src/metrics.ts`        |
| Jobs       | `raven_queue_depth`, `raven_job_duration_seconds`, `raven_job_failures_total`, `raven_job_retries_total`                                            | `apps/worker/src/metrics.ts`      |
| Runner     | `raven_runs_total`, `raven_run_duration_seconds`, `raven_run_output_bytes`, `raven_runner_concurrent_runs`, `raven_runner_sandbox_violations_total` | `apps/runner/src/metrics.ts`      |

Not implemented (do not put them on a dashboard and expect data): auth counters, document metrics,
egress/SSRF counters, file and AI metrics, client RUM, database pool/query metrics, OpenTelemetry
traces from §10.1, and the Sentry/GlitchTip error sink from §10.4.
No Prometheus or Grafana container exists in the stack — `infra/alerts/sync.rules.yml` holds rules
for a server that is not deployed here. **UNVERIFIED** until a scrape target is actually running.
Runbooks that exist: `runbooks/projection.md`, `runbooks/sync.md`, `runbooks/sync-memory.md`.

## 13. Logs

Pino JSON, one line per event, mandatory fields and the redaction list in
`packages/config/src/log.ts` (`ts, level, service, env, version, trace_id, span_id, req_id, org_id,
user_id, msg, event`). Container logs use the json-file driver capped at 10 MB × 5 files per service
(compose `logging:` block) — that is the whole retention story on this box. The 30-day hot / 12-month
audit retention in §10.3 needs a log shipper that does not exist here: **UNVERIFIED**.

## 14. Backup

- Postgres: `pg_dump` into the `./backups` bind mount, then off-host copy. Command and schedule are
  **UNVERIFIED** — no backup script, unit or timer exists in this repo.
- MinIO artifacts: mirror the bucket off-host (`mc mirror`). Also **UNVERIFIED** — not scripted.
- Redis: AOF on the volume; a lost Redis costs queued jobs, not board data, so it is not backed up.
- The `BackupMissing` alert in §10.5 expects `raven_backup_last_success_timestamp`; nothing emits
  that metric today.

**This is the single largest hole in the deployment story. It is a data-loss risk, not a polish
item.**

## 15. Rollback

1. Keep the previous image tag; deploys are `NEXUS_VERSION=<old> docker compose up -d api web`.
2. Schema: never roll a migration back — additive-safe migrations mean the previous image runs
   against the newer schema (§10). A destructive change requires a forward fix, not a down-migration.
3. Volumes are untouched by a rollback; a restore is a separate, manual `pg_restore` from §14.
4. **UNVERIFIED:** no rollback has been rehearsed on the box, and §7.2's restore drill has never run.

---

## 16. Summary of UNVERIFIED items

1. sync / worker / runner have no compose services and no images.
2. No image registry push and no deploy workflow — build happens on the host today.
3. gVisor (`runsc`) is selected in production but never installed.
4. Host capacity (RAM, cores, disk, kernel, Docker version) unmeasured — `scripts/survey-host.sh`.
5. No Prometheus/Grafana scrape target; most §10.2 metric families are not emitted, no traces, no
   error tracking sink.
6. No log shipper, so retention is whatever the json-file driver holds.
7. No backup script, schedule, off-host copy, restore drill, or backup metric.
8. No systemd units or timers.
9. Rollback and restore are documented but unrehearsed.
