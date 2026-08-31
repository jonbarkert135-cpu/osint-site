<p align="center">
  <img src="docs/brand/raven-mark.png" alt="Raven OSINT" width="160" />
</p>

<h1 align="center">Raven OSINT — Advanced Research &amp; Intelligence Canvas</h1>

> An infinite canvas over a typed knowledge graph, for authorized OSINT and research work.
> Collect anything, link everything, enrich it with open-source tooling, export a defensible report.

**Status: Phase 1 — foundation (monorepo, tokens, app shell, auth, database, CI, bench harness).**

---

## Quick start — local mode (clean machine → running app, ≤ 3 minutes)

Raven runs **local-first**. The default build needs no account, no server, no database and no
network: your boards, files and history live in your browser's storage on this device.

Prerequisites: **Node 22** (`nvm use`) and **pnpm 9** (`corepack enable`). That is all.

```bash
git clone <repo-url> raven && cd raven
pnpm install
pnpm dev:local                           # web on :5173 — nothing else starts
```

Open <http://localhost:5173> and start working. There is no sign-up step, because there are no
accounts in this mode. To serve it from your own VPS, build the same bundle and put any static file
server in front of it:

```bash
pnpm --filter @nexus/web build           # apps/web/dist — plain static files
```

What "local" means concretely: board documents are a Yjs CRDT persisted in IndexedDB, attachments go
to OPFS, and the project/board list is IndexedDB as well (`apps/web/src/data/workspace/local.ts`).
Nothing leaves the machine. The rationale and the upgrade path are in
[`docs/adr/ADR-001-local-first.md`](docs/adr/ADR-001-local-first.md) and
[`docs/adr/ADR-003-local-database.md`](docs/adr/ADR-003-local-database.md).

## Quick start — server mode (multi-user deployment)

Needed only when you want accounts, a shared database and (later) sync between devices. It is the
same code base with `APP_MODE=server`; see
[`docs/backend/BACKEND_SETUP.md`](docs/backend/BACKEND_SETUP.md) for the full path.

Prerequisites: the above plus **Docker** with Compose.

```bash
cp .env.example .env                     # set APP_MODE=server and VITE_APP_MODE=server
pnpm install
docker compose -f infra/docker-compose.yml up -d postgres redis minio
pnpm db:migrate                          # apply Prisma migrations
pnpm db:seed                             # dev org, 4 users, 3 projects, 8 boards
pnpm dev                                 # api on :3001, web on :5173
```

Seeded logins use the password `dev-only`. The full self-host path (Caddy TLS termination, built
images, egress proxy) is `docker compose -f infra/docker-compose.yml up -d` with `PUBLIC_HOSTNAME`
and the secrets in `.env` set to real values.

**Which subsystems are on** is decided in one place — `packages/config/src/appMode.ts` — and
validated at boot: a capability whose dependency is missing stops the process with a sentence saying
what to fix. Current state of every backend piece:
[`docs/backend/BACKEND_STATUS.md`](docs/backend/BACKEND_STATUS.md).

## Scripts

| Command                            | What it does                                            |
| ---------------------------------- | ------------------------------------------------------- |
| `pnpm dev:local`                   | Local mode: the web app alone, no API, no database      |
| `pnpm dev`                         | Runs every app in watch mode (turbo, parallel)          |
| `pnpm build`                       | Builds all packages and apps                            |
| `pnpm test`                        | Vitest unit/component suites in every package           |
| `pnpm lint`                        | ESLint, including the `no-hardcoded-design-values` rule |
| `pnpm typecheck`                   | `tsc --noEmit` across the workspace                     |
| `pnpm depcruise`                   | Layer-boundary rules from `00_MASTER.md` §5             |
| `pnpm db:migrate` / `pnpm db:seed` | Apply migrations / load the dev data set                |
| `pnpm e2e`                         | Playwright journeys (needs a running stack)             |
| `pnpm bench`                       | Canvas benchmark → `bench-results.json`                 |
| `pnpm check:gates`                 | The CI hygiene scripts (`scripts/*.mjs`) locally        |

CI gate scripts, all runnable standalone with plain Node:
`check-no-todo`, `check-skips`, `check-coverage`, `diff-coverage`, `check-bundle-secrets`,
`check-bundle-budget`, `check-migration-safety`.

## Architecture in one paragraph

TypeScript everywhere. A React 19 + Vite SPA renders a **custom hybrid canvas engine** — Canvas2D
for edges, grid and far-zoom level-of-detail glyphs, DOM overlay for the visible near-zoom cards —
driven by a spatial index so 5,000 nodes stay at 60 fps. The board document is a **Yjs CRDT**
(offline-first via IndexedDB, realtime via Hocuspocus, undo/redo via `Y.UndoManager`), projected
into **PostgreSQL** for querying, search and export. Every external tool — GitHub, Sherlock,
SpiderFoot and anything added later — is described by a **manifest** and executed by one generic
sandboxed runner pipeline, so the application core contains no tool-specific code. Nothing enters
the graph without provenance, and no AI or tool output is applied without a reviewable, undoable
proposal.

Full reasoning, rejected alternatives and the measured constraints behind each choice:
[`RAVEN-SPEC/00_MASTER.md`](RAVEN-SPEC/00_MASTER.md) §2 and
[`RAVEN-SPEC/02_ARCHITECTURE.md`](RAVEN-SPEC/02_ARCHITECTURE.md).

## Repository layout

| Path                             | Contents                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `apps/web`, `apps/api`           | React SPA; Fastify + tRPC API (`/healthz`, `/readyz`, metrics on 9464)              |
| `packages/{config,ui,db,domain}` | Env schema + logging, design tokens, Prisma schema, entity types                    |
| `infra/`                         | `docker-compose.yml`, `docker/*.Dockerfile`, `caddy/Caddyfile`, `egress/envoy.yaml` |
| `scripts/`                       | CI gate scripts (no dependencies beyond Node builtins)                              |
| `bench/`, `e2e/`                 | Canvas benchmark harness; Playwright journeys and the axe sweep                     |
| [`RAVEN-SPEC/`](RAVEN-SPEC/)     | The complete product + engineering specification (21 documents)                     |

Internal packages are **source-only**: they export `./src/*.ts` and are compiled by whoever
consumes them (Vite, tsx, vitest). Only `@nexus/ui` (Tailwind preset) and `@nexus/db`
(`prisma generate`) have a build step.

## Where the spec lives, and how phases work

Working on this with an AI agent? Point it at [`AGENTS.md`](AGENTS.md) first: invariants, commands,
reading order and the graph-query workflow, so it does not re-read the tree to orient itself.

1. [`RAVEN-SPEC/00_MASTER.md`](RAVEN-SPEC/00_MASTER.md) — **start here.** Frozen architecture
   decisions, product principles, the ten non-negotiables (N1–N10), the seven-check quality gate.
2. [`RAVEN-SPEC/20_ROADMAP.md`](RAVEN-SPEC/20_ROADMAP.md) — the ledger of what already shipped plus
   one self-contained implementation prompt per open phase.
3. Pick the lowest open phase, branch `phase/p<nn>-<slug>`, implement exactly that phase,
   open one PR titled `P<nn> — <name>`.
4. The PR body states what existed before, what was reused, what was intentionally not touched,
   plus evidence for every acceptance criterion and the test checklist from `18_TESTING.md` §16.
5. `ci-ok` is the single required check; it aggregates lint, typecheck, unit, coverage-gate,
   build, e2e, visual, bench, audit, docker and migrate-check.
6. In the same PR, move the phase into the `20_ROADMAP.md` ledger and delete its prompt.
7. **Merge it into `main` as soon as `ci-ok` is green** — squash-merge and delete the branch
   (`gh pr merge <n> --squash --delete-branch`). Never leave finished work sitting on a branch and
   never stack a PR on an unmerged one: `main` is the only source of truth, and stale branches just
   cost the next agent context to read.

Nothing is implemented "later": if a capability is in the core vision, it has a full architectural
solution in the spec before code is written. No `TODO` markers survive CI.

## CI, in short

Every PR runs the eleven jobs above. Since P2 the `bench` job runs `compare.mjs --enforce`: the
absolute N1 budgets gate immediately, and the 5 % regression gate starts as soon as a baseline
recorded on a CI runner exists (`bench/baseline.json` is still empty on purpose — a developer-machine
number would make every CI run look like a regression). `visual` starts diffing now that the canvas
engine paints a stable surface.

## Legal & ethical scope

Raven is built for **authorized research**: your own assets, public information, and engagements you
have permission to run. Every tool run records a consent scope and is written to the append-only
audit log; all outbound traffic leaves through an allowlist-only egress proxy. Using it to profile
people or systems you have no permission to investigate is outside the product's intended use and
may be illegal in your jurisdiction. See [`RAVEN-SPEC/15_SECURITY.md`](RAVEN-SPEC/15_SECURITY.md) §9.

## CI workflow file

CI lives at `.github/workflows/ci.yml` and is active: every push to `main` and every PR runs the
full job matrix (lint, typecheck, unit + coverage gate, build, e2e, visual, bench, audit, docker,
migrate-check) aggregated by the single required check `ci-ok`.
