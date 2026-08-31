# AGENTS.md — project memory

Read this file first, then only what it points at. Do **not** read the tree to orient yourself.

## Read order (stop as soon as you have what you need)

1. This file.
2. `docs/DEVELOPER_HANDOFF.md` — repo map, where behaviour lives, commands.
3. `RAVEN-SPEC/20_ROADMAP.md` — phases, what is done, what is next (the tracker).
   `RAVEN-SPEC/25_IMPLEMENTATION_STATUS.md` — per-requirement audit of the owner's roadmap doc;
   read it instead of the roadmap doc itself, and update the touched rows in the same PR.
4. The one spec for your area: `05_CANVAS_ENGINE`, `06_NODE_SYSTEM`, `07_EDGE_SYSTEM`,
   `08_DATA_MODEL`, `09_BACKEND`, `10_INTEGRATIONS`, `21_TRANSFORM_SYSTEM`, `24_UNIFIED_QUERY`.
   Each ends with an **implementation status** section: shipped, deviations, not-yet.
5. `docs/adr/` only when you want to change a decision, not to learn it.

`RAVEN-SPEC/00_MASTER.md` wins over every other document; if code and spec disagree, code is the
fact and the spec gets corrected in the same PR.

## Structural queries instead of reading files

This repo is indexed for [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)
(`.mcp.json`). Use its graph tools — search, trace, impact, architecture — to find a symbol,
its callers or its blast radius. Reading whole directories to answer "where is X" is the wrong
tool and costs 100× the tokens.

## Invariants (breaking one is a bug, not a trade-off)

- **N2 local-first**: the default build works with no account, no server, no network. Anything
  server-only sits behind a capability in `packages/config/src/appMode.ts`.
- **N4 propose, never write**: no tool, agent or import mutates the board without an accepted
  proposal; every node/edge carries provenance.
- **Undo**: one user action = one undoable step; history is document state, not stack state.
- **Engine has no domain imports**: domain behaviour reaches `packages/canvas-engine` by injection
  (`edgePath`, `edgeHit`), never by import.
- **The engine is the only hit-test authority**: overlay DOM is transparent to the pointer
  (`06_NODE_SYSTEM.md` §13.6); hover/edit arrive as engine events and intents.
- **No `switch (node.type)`** outside `packages/domain/src/nodes/` — enforced by an eslint rule.
- **Performance is measured, not felt**: 5,000 nodes / 10,000 edges at 60 fps, asserted by `bench`.

## Commands

```bash
pnpm install                       # Node 22, pnpm 9
pnpm dev:local                     # web on :5173, nothing else
pnpm lint && pnpm typecheck && pnpm test && pnpm check:gates
pnpm exec prettier --check .
pnpm e2e                           # needs a build + seeded db (see CI)
pnpm --filter @nexus/db run build  # prisma generate — lint fails on db without it
```

CI (`.github/workflows/ci.yml`) runs all of the above plus coverage, bundle, docker, bench and
visual jobs. `ci-ok` is the required gate.

## Working agreement

- Never commit to `main`; branch, PR, wait for green CI, merge.
- **Everything lands in `main`, immediately.** As soon as a PR is green, squash-merge it and delete
  the branch (`gh pr merge <n> --squash --delete-branch`). Do not park finished work on a branch, do
  not stack a new PR on an unmerged one, and do not leave stale branches around for the next agent
  to read — `main` is the only source of truth.
- Keep the phase trackers (`RAVEN-SPEC/20_ROADMAP.md` and the spec's own status section) updated in
  the same PR as the code.
- PR bodies stay short: what changed, what was deliberately deferred.
