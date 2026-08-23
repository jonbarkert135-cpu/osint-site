# Raven — 26 — OPEN-SOURCE REGISTRY (ENGINE PASSPORTS)

## Scope

The living registry required by Part 2 (§7 Automated Open-Source Discovery, §28 Engine Registry,
§77 Engine Passport). `22_ECOSYSTEM_AUDIT.md` is a **dated snapshot** of what exists; this document
is the **standing system** that decides what Raven is built on, tracks each adopted engine over its
lifetime, and catches drift (new upstream releases, dead projects, licence changes) before it
reaches production.

Non-goals: runtime execution (`10_INTEGRATIONS.md`, `24_UNIFIED_QUERY.md`), the commercial
landscape (`23_COMPETITOR_MATRIX.md`), the Maltego transform catalog (`docs/ecosystem/`).

> **Provenance, read this first.** Two kinds of facts live here, and they age differently:
>
> - **[code, YYYY-MM-DD]** — read from this repository on that date (manifests, runner config).
>   Trust it until the next commit touching that file.
> - **[source, YYYY-MM-DD]** — verified against a primary upstream source (release page, LICENSE,
>   registry) on that date. Re-verify before any adoption decision older than 90 days.
>
> Anything that could not be confirmed is written as **unverified** — never inferred from search
> snippets or model memory (same rule as `22_ECOSYSTEM_AUDIT.md`).

---

## 1. The passport standard (Part 2 §77)

Every engine — adopted, candidate or rejected — gets exactly one passport. Passports for adopted
engines live in §2; candidate passports are the tier rows of `22_ECOSYSTEM_AUDIT.md` until adoption.

| Field                                                    | Source of truth                                       |
| -------------------------------------------------------- | ----------------------------------------------------- |
| Engine Name / Purpose / Category                         | passport (below)                                      |
| Repository / Official Website                            | passport, re-checked on review                        |
| License / Version / Last Verified / Maintenance Status   | primary upstream source **[source, date]**            |
| Runtime / OS / Docker / CPU / RAM / Network Requirements | code manifest for adopted engines **[code, date]**    |
| Input Types / Output Types / API-or-CLI                  | code manifest                                         |
| Security Risks / Permissions                             | code manifest + `15_SECURITY.md`                      |
| Hidden Cloud Compatibility                               | §4 — **open** until the §33 environment survey exists |
| Execution Mode / Adapter                                 | `packages/integrations/<id>/`                         |
| Tests                                                    | `packages/integrations/test/<id>.test.ts`             |
| Fallback / Alternative                                   | passport + audit tier table                           |
| Deprecation Risk                                         | passport, reviewed quarterly                          |

Rule (Part 2 §8): an engine is **adopted** only when it is one line in `BUILTIN_SOURCES`
(`packages/integrations/src/registry.ts`) with a passing manifest and contract tests. Nothing is
"integrated" because a document says so.

## 2. Registered engines (adopted)

### 2.1 expand-url — first-party reference engine

| Field                  | Value                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| Purpose / Category     | follow redirect chains on pasted links → canonical URL node (enrichment)                           |
| License / Version      | Apache-2.0, manifest v1.0.0 **[code, 2026-08-23]**                                                 |
| Runtime / Execution    | Node.js, `execution.kind: 'builtin'` — in-runner, no container **[code, 2026-08-23]**              |
| Resources              | 30 s wall clock, 500 mCPU, 128 MiB RAM, 16 pids **[code, 2026-08-23]**                             |
| Network                | allowlist mode, http/https only **[code, 2026-08-23]**                                             |
| Input / Output         | `url` (from selected url node) → JSON ≤ 64 KiB **[code, 2026-08-23]**                              |
| Security risks         | minimal; exists to prove manifest → runner → proposal → apply → undo before third-party code ships |
| Fallback / Alternative | none needed (first-party)                                                                          |
| Deprecation risk       | none                                                                                               |

### 2.2 github — repository intelligence (HTTP-only)

| Field                  | Value                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Purpose / Category     | public repo metadata, README, releases, contributors, languages, license → nodes (discovery)                           |
| License / Version      | adapter Apache-2.0; upstream = GitHub REST API `2022-11-28` **[code, 2026-08-23]**                                     |
| Runtime / Execution    | Node.js, `execution.kind: 'http'` — no clone, no container **[code, 2026-08-23]**                                      |
| Network                | allowlist: `api.github.com`, `raw.githubusercontent.com`; 300 rpm, 10 concurrent per credential **[code, 2026-08-23]** |
| Auth                   | BYOK token; anonymous runs budget-capped by the adapter **[code, 2026-08-23]**                                         |
| Security risks         | token scoping is the user's; egress pinned to two hosts                                                                |
| Fallback / Alternative | manual analysis action in the Repository Analysis panel (already in UI)                                                |
| Deprecation risk       | low (versioned API, dated versions are retired on a published schedule — re-check header yearly)                       |

### 2.3 spiderfoot — broad OSINT sweep (self-hosted instance)

| Field                  | Value                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose / Category     | 200+ module OSINT sweep → domain/url/email/username/ip/repo entities + observations                                                                                                                       |
| License / Version      | MIT, stable v4.0, Python **[12_SPIDERFOOT.md, 2026-08-23]**                                                                                                                                               |
| Maintenance status     | **low — deps.dev (June 2026): 0 commits and 0 issue activity in 90 days** [12_SPIDERFOOT.md]; manifest `maturity: 'beta'`, `risk.label: 'high'`, `risk.upstreamMaintenance: 'low'` **[code, 2026-08-23]** |
| Runtime / Execution    | external self-hosted instance; Raven talks HTTP to `/scaneventresults` via the runner http executor — no third-party code runs in Raven **[code, 2026-08-23]**                                            |
| Network                | exactly one host, from `SPIDERFOOT_BASE_URL` (no default; unconfigured = dead host) **[code, 2026-08-23]**                                                                                                |
| Known gap              | Raven cannot launch/poll/cancel scans yet — analyst starts the scan, pastes the id (roadmap §1)                                                                                                           |
| Fallback / Alternative | tier-A passive chain from the audit: subfinder + httpx + Amass for infrastructure, Sherlock + Maigret for usernames [22_ECOSYSTEM_AUDIT.md, 2026-08-19]                                                   |
| Deprecation risk       | **high** — single-maintainer upstream with stalled activity; the fallback chain is the mitigation                                                                                                         |

### 2.4 sherlock — username → profile discovery (sandboxed container)

| Field                  | Value                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Purpose / Category     | username search across social sites → claimed profile URLs (discovery)                                                |
| License / Version      | MIT; manifest pins tool **v0.16.0** by image digest **[code, 2026-08-23]**                                            |
| Maintenance status     | tier A, upstream latest release **v0.16.0** (GitHub releases + PyPI) **[upstream, 2026-08-23]**                       |
| Runtime / Execution    | Python CLI as a container in the runner sandbox: read-only rootfs, gVisor, no capabilities **[code, 2026-08-23]**     |
| Network                | egress `broad` by necessity (hundreds of sites); private ranges denied **[code, 2026-08-23]**                         |
| Install rule           | no `SHERLOCK_IMAGE_DIGEST` ⇒ integration absent from the registry — never a floating `:latest` **[code, 2026-08-23]** |
| Confidence rule        | claimed handle = account, never a person; base confidence 0.7, cap 0.9 **[code, 2026-08-23]**                         |
| Fallback / Alternative | Maigret (MIT, tier A, 3000+ sites) [22_ECOSYSTEM_AUDIT.md, 2026-08-19]                                                |
| Deprecation risk       | medium — site definitions rot silently; needs the definition-diff watchdog (§3.4)                                     |

> **Registry finding 2026-08-23:** no drift. The suspected `0.16.1` upstream does not exist — the
> latest Sherlock release is `v0.16.0` (GitHub `releases/latest` and PyPI `sherlock-project`,
> checked 2026-08-23), which is exactly what `SHERLOCK_TOOL_VERSION` pins. Version rows in this
> registry must cite a checked source, not an audit summary.

## 3. Discovery pipeline (Part 2 §7)

The audit is not a one-off table. Candidates flow through a fixed pipeline; a candidate is
**adopted** only after every gate passes and its passport is complete.

```text
Project Discovery        (22_ECOSYSTEM_AUDIT.md, user requests, release feeds)
      ↓
Project Evaluation       (does it fill a capability gap no adopted engine fills? §78/§81)
      ↓
License Check            (house rule: GPL/AGPL process-isolated only; BUSL/source-available
                          external-service only; model weights checked separately — audit §1)
      ↓
Maintenance Check        (release cadence, commit activity, maintainer count → tier A–E)
      ↓
Compatibility Check      (execution kind fits http / builtin / sandboxed container? §4)
      ↓
Security Check           (egress surface, active vs passive, authorization gate — 15_SECURITY.md)
      ↓
Integration Score        (value × reliability × maintenance ÷ cost; Part 2 §79 — recorded in passport)
      ↓
Registry                 (passport in §2 + one line in BUILTIN_SOURCES + contract tests)
```

### 3.1 Current candidate pool

`22_ECOSYSTEM_AUDIT.md` [source, 2026-08-19] holds the scored pool: tier-A candidates subfinder,
httpx, nuclei (active — needs authorization gate), Amass, Maigret, dnstwist, crt.sh, GLEIF.
Next adoption order follows the roadmap, not this document.

### 3.2 Rejection log

Record rejections here so they are not re-litigated (Part 2 §6, §58):

| Project                  | Verdict                  | Why                                                | Date       |
| ------------------------ | ------------------------ | -------------------------------------------------- | ---------- |
| OpenCorporates free tier | forbidden for enrichment | share-alike terms unusable in a commercial product | 2026-08-19 |
| HIBP (full API)          | BYOK-only                | paid for everything except Pwned Passwords         | 2026-08-19 |

### 3.3 Freshness cadence

- Passports re-verified against primary sources **every 90 days** or on any roadmap touch of that
  engine, whichever comes first.
- Audit tiers re-run quarterly (next due **2026-11-19**).

### 3.4 Definition-freshness watchdog (open)

Scraping-based engines (Sherlock, Maigret) decay silently as sites change. A scheduled job must
diff upstream site definitions and alert on drift (audit §7 item 7). **Not built yet** — tracked in
roadmap §2 (Sherlock watchlist/diff).

## 4. Hidden Cloud compatibility (Part 2 §33 — open)

Part 2 §33 forbids assuming Docker, root, daemons or arbitrary binaries on the deployment
environment, and demands a survey of what the Hidden Cloud actually supports before adopting any
engine. **That survey has not been done** — `19_DEPLOYMENT.md` currently specifies full
k8s + gVisor self-hosting, which is the _target_, not a verified Hidden Cloud environment.

Until the survey exists (`27_HIDDEN_CLOUD_ARCHITECTURE.md`, next document in the Part 2 sequence),
every passport's Hidden Cloud field stays **unverified**, and the working assumption for new
engines is the most restrictive one: prefer `http` and `builtin` execution kinds; treat
containerized engines (Sherlock today) as requiring a confirmed container runtime.
