# Raven — 22 — OPEN-SOURCE ECOSYSTEM AUDIT

## Scope

A dated, tiered catalog of the external engines, libraries and services Raven can stand on, so that
no phase re-litigates "which OCR / which vector store / which crawler" from scratch, and so that no
phase adopts a project that is dead, licence-hostile or quietly abandoned. Covers five categories:

- **A** — discovery & OSINT engines (domains, usernames, e-mail, phone, company, infrastructure)
- **B** — documents, OCR, media & metadata extraction
- **C** — graph storage, search, vectors & entity resolution
- **D** — web research: crawling, browser automation, search aggregation, archiving, job queues
- **E** — LLM runtimes, structured extraction, canvas/graph visualization

Non-goals: the Maltego-specific transform/provider ecosystem (owned by
`docs/ecosystem/MALTEGO_AUDIT.md` and the transform-layer sections of `10_INTEGRATIONS.md`), the
commercial product landscape (`23_COMPETITOR_MATRIX.md`), and how these engines are actually driven
at runtime (`24_UNIFIED_QUERY.md`).

**Every fact in this file was collected on 2026-08-19 by live source checks** (GitHub releases,
PyPI/npm/crates registries, vendor pricing and licence pages). Facts age. Anything that could not be
confirmed against a primary source is written as **unverified** and must be re-checked by opening the
actual `LICENSE` file or release page before an adoption decision — never inferred from a search
snippet, and never from model memory.

---

## 1. Tier definitions

| Tier  | Meaning                                                                | Allowed use in Raven                                                   |
| ----- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **A** | Actively maintained, permissive licence, safe to depend on             | may be a default dependency or a bundled engine                        |
| **B** | Alive but with one real caveat (weak copyleft, single maintainer, 0.x) | allowed behind an adapter, with a named fallback and a monitoring note |
| **C** | Usable but with a licence, activity or accuracy problem                | optional / opt-in only; never a default; never on the critical path    |
| **D** | Effectively unmaintained, still widely recommended                     | reference only; do not add as a dependency                             |
| **E** | Dead, retired, or licence-incompatible with the product                | forbidden                                                              |

Two orthogonal flags used below:

- **BYOK** — the user brings their own paid API key. Raven never ships a shared key, never proxies
  the vendor, and never bundles the vendor's data (see §7).
- **Offline** — works with no network at all, which is the only tier that may run in `APP_MODE=local`
  without an explicit user opt-in (`docs/adr/ADR-001-local-first.md`).

**Licence rule of the house.** AGPL and GPL components may be invoked as a separate process
(subprocess, container, localhost service) but may never be linked into or vendored inside Raven's
own build. BUSL / "fair-code" / source-available components (ArangoDB, SurrealDB core, Windmill EE,
n8n) may only be pointed at as a user-operated external service. Model **weights** carry their own
licence, separate from the code licence — check both.

---

## 2. Category A — discovery & OSINT engines

| Tier    | Project                                                                                | Licence                         | Activity (2026-08-19)                  | Notes                                                                    |
| ------- | -------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| A       | subfinder (ProjectDiscovery)                                                           | MIT                             | v2.15.0, active monthly cadence        | passive subdomain enumeration; keyless core, optional free source keys   |
| A       | httpx (ProjectDiscovery)                                                               | MIT                             | v1.10.0, 2026-07-09                    | HTTP probing/fingerprinting; fully offline-capable binary                |
| A       | nuclei (ProjectDiscovery)                                                              | MIT/Apache-2.0                  | v3.11.1, 2026-08-08                    | template scanning; **active** scanner — authorization gate required      |
| A       | OWASP Amass v5                                                                         | Apache-2.0                      | v5.1.1, 2026-04-07                     | deep attack-surface graph; heavier, thinks in graphs (maps to our model) |
| A       | Sherlock                                                                               | MIT                             | v0.16.0, latest release 2025-09-16     | username → profiles; already scheduled as P11                            |
| A       | Maigret                                                                                | MIT (commercial use explicit)   | v0.6.4, 2026-08-11                     | 3000+ sites, richer dossier than Sherlock                                |
| A       | dnstwist                                                                               | Apache-2.0                      | last tag 20240116, repo active 2025-09 | typosquat detection; DNS-only, fully offline                             |
| A       | crt.sh                                                                                 | public service (no SLA)         | continuous                             | CT search; best-effort, needs backoff                                    |
| A       | GLEIF LEI API                                                                          | CC0                             | in production since 2020               | the only genuinely free company-registry source                          |
| B       | theHarvester                                                                           | **unverified** SPDX             | v4.11.1, 2026-06-03                    | verify LICENSE before shipping; depends on third-party search quotas     |
| B       | certstream-server-go                                                                   | **unverified** licence          | v1.9.0, 2026-04-03                     | successor to the dead CaliDog server; self-hosted CT stream              |
| B       | Osmedeus                                                                               | MIT                             | v5.0.3, 2026-05-29                     | declarative recon orchestration — reference architecture for §5 of `23`  |
| B       | native RDAP (IANA bootstrap)                                                           | protocol, free                  | ~60 % TLD coverage                     | build our own client; WHOIS fallback needed                              |
| B       | Blackbird                                                                              | **unverified** licence          | rolling `main`, no tags                | do not bundle until LICENSE is opened                                    |
| C       | ignorant                                                                               | GPL-3.0                         | thin maintenance, PR backlog           | subprocess-only if ever used                                             |
| C       | ZoomEye / Netlas / Epieos                                                              | proprietary SaaS                | active                                 | BYOK adapters only                                                       |
| C       | holehe                                                                                 | GPL-3.0                         | no push since 2024-09                  | password-reset side-channel — most ToS-fragile technique in the category |
| D       | recon-ng                                                                               | GPL-3.0                         | no substantive commits since ~2024     | still the top tutorial recommendation; dead                              |
| D       | PhoneInfoga                                                                            | GPL-3.0                         | maintainer: "stable but unmaintained"  | dead by declaration                                                      |
| D       | mosint                                                                                 | MIT                             | last push 2024-02                      | dead                                                                     |
| E       | Photon                                                                                 | GPL-3.0 vs MIT conflict         | nothing since ~2019                    | abandoned + contradictory licence metadata                               |
| E       | GHunt                                                                                  | AGPL-3.0                        | PyPI 2.3.4, 2026-03-16                 | hardest copyleft + requires the user's live Google session               |
| E       | CaliDog/certstream-server                                                              | —                               | dead                                   | use certstream-server-go instead                                         |
| E, BYOK | Shodan, Censys, urlscan, IntelX, HIBP, Hunter, WhoisXML, OpenCorporates, OpenSanctions | proprietary / paid data licence | active                                 | never bundled; see §7                                                    |

**Adopt (A-tier defaults):** the ProjectDiscovery trio as the domain/host recon spine, Amass v5 as
the "deep" mode, Sherlock + Maigret for usernames, dnstwist for typosquats, crt.sh (with our own
backoff) and GLEIF for free enrichment.

**Watch-outs.** Username tooling is scraping-based by nature: site definitions rot silently, so
Raven needs a scheduled definition-diff job (§8) rather than trusting a green run. HIBP is paid for
everything except Pwned Passwords; OpenCorporates' free tier is share-alike and therefore unusable
in a commercial product; OpenSanctions requires a data licence for any business use even
self-hosted; IntelX explicitly forbids a shared API key inside a shipped product.

---

## 3. Category B — documents, OCR, media & metadata

| Tier | Project                 | Licence                                                | Activity (2026-08-19)           | Role in Raven                                       |
| ---- | ----------------------- | ------------------------------------------------------ | ------------------------------- | --------------------------------------------------- |
| A    | libmagic / python-magic | BSD-ish / MIT                                          | rolling                         | **first-pass** file-type sniffing, always runs      |
| A    | pypdfium2               | Apache-2.0 / BSD-3                                     | v5.13.0                         | non-AGPL PDF render/extract baseline                |
| A    | pdfplumber              | MIT                                                    | v0.11.10, 2026-06-15            | positional text + tables when a text layer exists   |
| A    | Docling (IBM)           | MIT                                                    | v2.120.1, 2026-08-14, ~daily    | primary PDF/Office → structured document            |
| A    | Marker (datalab-to)     | Apache-2.0 (code)                                      | v2.0.0, 2026-07-20              | second engine; CPU `fast` mode for triage           |
| A    | Tesseract               | Apache-2.0                                             | 5.5.3, 2026-07-24               | zero-GPU OCR fallback                               |
| A    | PaddleOCR / PaddleX     | Apache-2.0                                             | v3.7.0, 2026-06-11              | CJK / non-Latin OCR; separate container (Paddle)    |
| A    | ExifTool                | Artistic/GPL (subprocess)                              | 13.59, 2026-05-27               | default metadata extractor                          |
| A    | MediaInfo               | BSD-2-style                                            | 26.05, 2026-05-12               | A/V container metadata                              |
| A    | ffmpeg                  | LGPL-2.1+ (**build LGPL, not GPL**)                    | 9.0, 2026-08-04 (ABI break)     | demux, frames, audio for transcription              |
| A    | ClamAV                  | GPL-2.0 (daemon/subprocess)                            | 1.5.4, 2026-08-07               | mandatory pre-ingest scan gate                      |
| A    | Apache Tika             | Apache-2.0                                             | 3.3.2, 2026-07-16               | universal fallback parser (JVM)                     |
| A    | Camelot                 | MIT                                                    | v2.0.0, 2026-06-04              | table-extraction fallback                           |
| B    | unstructured (OSS lib)  | Apache-2.0                                             | 0.25.2, 2026-08-03              | breadth for e-mail/HTML; hosted API rejected        |
| B    | GROBID                  | Apache-2.0                                             | 0.9.0, 2026-04-07               | scholarly PDFs only, on-demand container            |
| B    | Surya                   | Apache-2.0 code, **OpenRAIL-M weights, revenue cap**   | v2, 2026-05-27                  | needs an inference server; licence review at scale  |
| B    | faster-whisper          | MIT                                                    | v1.2.1, 2025-10-31 (~10 mo old) | transcription; whisper.cpp identified as fallback   |
| A/B  | MinerU                  | custom "MinerU Open Source Licence" (Apache-based)     | 3.4.5, active                   | strong alternative; **read the licence** first      |
| C    | dots.ocr / dots.mocr    | MIT code vs custom weights licence (**open conflict**) | active in bursts                | do not ship until maintainers resolve issue #5      |
| C    | openai/whisper          | MIT                                                    | feature-frozen                  | reference only                                      |
| D    | EasyOCR                 | Apache-2.0                                             | v1.7.2, 2024-09                 | Torch-compat PRs unmerged; aging                    |
| D    | Tabula / tabula-java    | MIT                                                    | v1.0.5, 2021                    | superseded by Camelot                               |
| E    | PyMuPDF (as dependency) | AGPL-3.0 or paid Artifex                               | active                          | biggest licence landmine; **also a transitive dep** |
| E    | Apache Any23            | Apache-2.0                                             | retired to the Attic, 2023-06   | no patches ever again                               |
| E    | hachoir                 | GPL-2.0                                                | "No Maintenance Intended"       | replaced by libmagic + MediaInfo + ExifTool         |

**The pipeline this implies:** `libmagic → ClamAV → (route) → pypdfium2/pdfplumber | Docling |
Marker | Tika | GROBID → ExifTool/MediaInfo metadata → optional OCR ladder (Tesseract → PaddleOCR →
VLM)`. The escalation ladder and its confidence scoring are ours to build (§8).

**Transitive-AGPL trap.** PyMuPDF is pulled in by other, permissively-licensed projects'
`requirements.txt`. Licence checking must be done on the resolved dependency tree, not on the
top-level package, and CI must fail closed on a copyleft component appearing inside a bundled build.

---

## 4. Category C — graph storage, search, vectors, entity resolution

The single biggest change since the spec was written: **KuzuDB was archived in October 2025** by its
creator. It is still recommended in essentially every "embedded graph database" article written
before that date. Do not integrate the upstream repo. The successor forks (LadybugDB, Lance Graph)
are real but unverified for production. **CozoDB** has been dead since 2024-12 (fork: `mnestic`,
also unverified).

| Tier | Project                   | Licence                               | Activity (2026-08-19)         | Role                                                    |
| ---- | ------------------------- | ------------------------------------- | ----------------------------- | ------------------------------------------------------- |
| A    | DuckDB + duckdb-wasm      | MIT                                   | active; wasm lags core        | local analytics, in-browser; `vss` still experimental   |
| A    | Oxigraph                  | MIT/Apache-2.0                        | v0.5.9, ~2026-06              | RDF/SPARQL with genuine WASM bindings                   |
| A    | Qdrant                    | Apache-2.0                            | v1.19.0, 2026-08-05           | vector store, server mode                               |
| A    | LanceDB                   | Apache-2.0                            | v0.37.1, ~2026-08             | embedded vector store, no server → local mode           |
| A    | Meilisearch CE            | MIT (EE is BUSL)                      | v1.53.1, 2026-08-13           | full-text if/when a local daemon exists                 |
| A    | spaCy                     | MIT                                   | v3.8.15                       | classical NLP baseline                                  |
| A    | GLiNER                    | Apache-2.0 (code + models)            | v0.2.28, ~2026-03             | zero-shot NER, CPU/ONNX, in-browser capable             |
| B    | Orama                     | Apache-2.0 (per-pkg unverified)       | v3.2.0, 2026-06-27            | in-browser hybrid search                                |
| B    | sql.js / wa-sqlite + FTS5 | MIT                                   | active                        | offline SQLite + FTS in the tab                         |
| B    | sqlite-vec                | MIT                                   | v0.1.x alpha                  | vectors inside WASM SQLite; pre-1.0, solo maintainer    |
| B    | Splink                    | MIT                                   | v4.0.16, 2026-03-11           | **entity resolution engine of choice** (DuckDB backend) |
| B    | Apache AGE                | Apache-2.0                            | v1.8.0, 2026-07-09            | Cypher on Postgres if a server mode appears             |
| B    | Tantivy                   | MIT                                   | v0.26.1, ~2026-05             | only if we need a custom Rust/WASM index                |
| B    | MiniSearch                | MIT                                   | v7.2.0, ~2025-12              | tiny fallback index; single maintainer                  |
| B    | Zingg                     | Apache-2.0 (unverified file)          | v0.7.0                        | Spark/JVM — too heavy for local mode                    |
| B    | GLiREL                    | Apache-2.0                            | v1.2.1, 2025-04 (**stalled**) | relation typing; optional plugin only                   |
| A    | Neo4j Community           | GPL-3.0 (separate process)            | 2026.07.1, 2026-08-05         | user-operated server option, never embedded             |
| C    | Chroma                    | Apache-2.0                            | v1.5.9, 2026-05               | alternative to Qdrant/LanceDB                           |
| C    | hnswlib                   | Apache-2.0                            | v0.9.0, 2026-03               | too low-level; no persistence layer                     |
| C    | flair                     | MIT per README, NOASSERTION on GitHub | v0.15.1, 2025-02              | aging; verify LICENSE                                   |
| C    | REBEL / mREBEL            | licence **unverified**                | frozen research artifact      | static model only                                       |
| C    | recordlinkage             | BSD-3                                 | last push 2024-02             | superseded by Splink                                    |
| D    | KuzuDB (upstream)         | MIT                                   | **archived 2025-10-10**       | do not integrate                                        |
| D    | CozoDB                    | MPL-2.0                               | dead since 2024-12            | do not integrate                                        |
| E    | ArangoDB, SurrealDB core  | BUSL-1.1                              | active                        | source-available; user-deployed only, never vendored    |
| E    | Typesense                 | GPL-3.0                               | active                        | arm's-length server only                                |

**Adopt:** DuckDB(+wasm) for local analytics, Oxigraph for the RDF/knowledge layer, LanceDB
(embedded) ⇄ Qdrant (server) behind one vector-store interface, Splink for entity resolution,
spaCy + GLiNER for extraction, Orama / wa-sqlite+FTS5 for in-browser search.

---

## 5. Category D — crawling, browser automation, search, archiving, queues

| Tier    | Project                    | Licence                               | Activity (2026-08-19)    | Role                                          |
| ------- | -------------------------- | ------------------------------------- | ------------------------ | --------------------------------------------- |
| A       | Playwright                 | Apache-2.0                            | v1.62.x, 2026-07         | the browser substrate                         |
| A       | patchright                 | **unverified** (Playwright-derived)   | v1.61.x, 2026-06         | drop-in stealth Playwright                    |
| A       | crawl4ai                   | Apache-2.0 + attribution clause       | v0.9.2, 2026-07-15       | primary fetch + extract engine                |
| A       | Scrapy                     | BSD-3                                 | v2.17.0, 2026-07-07      | bulk/breadth crawling                         |
| A       | trafilatura                | Apache-2.0 (GPL before 1.8)           | v2.2.0                   | boilerplate removal (Python side)             |
| A       | Readability.js             | Apache-2.0                            | 0.6.0, 2025-03 (dormant) | boilerplate removal (browser side)            |
| A       | SearXNG                    | AGPL-3.0 (self-hosted)                | rolling, 2026.8.17       | only keyless search aggregation path          |
| A       | Wayback CDX                | IA terms, keyless                     | continuous               | historical snapshots; ~1 req/s politeness     |
| A       | Common Crawl               | permissive custom ToU                 | monthly                  | bulk historical corpus                        |
| A       | monolith                   | CC0                                   | v2.10.1                  | default single-file evidence snapshot         |
| A       | SingleFile                 | AGPL-3.0 (**external tool only**)     | v1.22.98, 2026-02        | JS-heavy page snapshots via subprocess        |
| A       | River                      | MPL-2.0                               | v0.44.0                  | Postgres-only job queue → matches local mode  |
| A       | BullMQ                     | MIT                                   | v6.1.2, 2026-08-16       | queue when Redis is present                   |
| A       | Temporal                   | MIT (server)                          | v1.31.2, 2026-07-08      | only if durable long workflows are needed     |
| A       | Prefect                    | Apache-2.0                            | v3.8.3                   | Python-side orchestration option              |
| A, BYOK | Brave Search API           | commercial ToS                        | active                   | clean paid search upgrade                     |
| A, BYOK | Tavily, Exa                | commercial ToS                        | active                   | LLM-oriented / semantic search                |
| B       | Camoufox                   | MPL-2.0                               | beta channel by design   | high-fingerprint targets; verify build origin |
| B       | Katana                     | MIT                                   | v1.6.1+, 2026-08         | fast discovery crawl                          |
| B       | newspaper4k                | **unverified** SPDX                   | v0.9.6                   | news-layout fallback extractor                |
| B       | Goose3                     | Apache-2.0                            | v3.1.22                  | third extractor in the ensemble               |
| B       | ArchiveBox                 | MIT                                   | 0.7.4 stable / 0.9.x rc  | local archiving; mid-rewrite                  |
| B       | browser-use, Stagehand     | MIT                                   | very active              | **sandbox required** — see below              |
| C       | Firecrawl (engine)         | AGPL-3.0 core, MIT SDKs               | active                   | external service only, never vendored         |
| C       | n8n                        | Sustainable Use Licence (not OSI)     | very active              | user-run integration only                     |
| B/C     | Windmill                   | Apache-2.0 + AGPL + proprietary EE    | very active              | user-run only                                 |
| B, BYOK | Serper.dev                 | commercial ToS (resells Google SERPs) | active                   | inherits Google ToS exposure                  |
| D       | Mercury / Postlight Parser | MIT                                   | last tag 2022-10         | dead                                          |
| D       | Newspaper3k                | MIT                                   | dead since ~2020         | replaced by newspaper4k                       |

**Two hard safety findings, both new:**

1. **LLM-driven browser agents are an active attack surface.** browser-use suffered a March 2026
   supply-chain compromise (a malicious `litellm` version pulled by its install script), and
   indirect prompt injection via page content (fake instructions in the DOM, SSRF through
   agent-driven fetches) is a documented, unsolved class of bug in both browser-use and Stagehand.
   Raven may only run such an agent inside an egress-allow-listed sandbox with no ambient
   credentials, with a pinned and audited dependency set. This is a `15_SECURITY.md` obligation, not
   a nice-to-have.
2. **Legality ≠ ToS safety.** hiQ v. LinkedIn means scraping public data is generally not a CFAA
   crime, but LinkedIn still won on contract/ToS grounds. Every result Raven surfaces must therefore
   carry a provenance/legal-posture tag (§8) — "keyless public API", "self-hosted metasearch
   proxying third-party engines", "SERP reseller", "licensed data" are meaningfully different, and
   the analyst should see which one produced a given node.

---

## 6. Category E — LLM runtimes, structured extraction, visualization

| Tier | Project                                                | Licence                        | Activity (2026-08-19)         | Role                                                                    |
| ---- | ------------------------------------------------------ | ------------------------------ | ----------------------------- | ----------------------------------------------------------------------- |
| A    | Ollama                                                 | MIT                            | v0.32.x, weekly               | default local LLM runtime (target its API, don't vendor)                |
| A    | llama.cpp                                              | MIT                            | daily builds                  | embedded fallback engine                                                |
| A    | vLLM                                                   | Apache-2.0                     | v0.27.x                       | self-hosted GPU "power engine"                                          |
| A    | transformers.js (`@huggingface/transformers`)          | Apache-2.0                     | v4.2.0                        | in-browser inference, zero install                                      |
| A    | onnxruntime-web                                        | MIT                            | v1.27.0                       | WASM/WebGPU runtime for GLiNER-ONNX, embeddings                         |
| A    | Instructor                                             | MIT                            | v1.15.4                       | typed extraction, prototyping                                           |
| A    | Outlines                                               | Apache-2.0                     | v1.3.3                        | decode-time constrained generation → preferred when correctness matters |
| A    | GLiNER                                                 | Apache-2.0                     | v0.2.28                       | non-LLM entity extraction (see also §4)                                 |
| A    | D3 (ISC), Observable Plot (ISC)                        | ISC                            | active ecosystem              | scales/force math, lightweight charts                                   |
| A    | MapLibre GL JS                                         | BSD-3                          | v6.4.1 (ESM-only)             | geospatial view; needs an offline tile plan                             |
| A    | TanStack Table                                         | MIT                            | v9.1.2                        | headless tables — fits "we render our own"                              |
| A    | sigma.js (v3 stable) / graphology                      | MIT                            | v3.0.3, v4 alpha              | graph model; renderer likely ours (budget)                              |
| A    | Cytoscape.js                                           | MIT                            | v3.34.1                       | alternative with built-in graph algorithms                              |
| B    | `@cosmograph/cosmos` (engine only)                     | MIT                            | active                        | GPU force layout for 100k+ node graphs                                  |
| B    | LangGraph / PydanticAI / DSPy / Vercel AI SDK / Mastra | MIT / Apache-2.0               | active                        | orchestration options; TS-native ones fit our stack                     |
| B    | AG Grid Community                                      | MIT                            | v36.1.0                       | heavier, batteries-included alternative                                 |
| B    | ECharts                                                | Apache-2.0                     | v6.1.0                        | 359 KB gzip — cannot be in the initial bundle                           |
| C    | BAML                                                   | **unverified** per sub-package | v0.16.0                       | interesting codegen, adds a compiler                                    |
| C    | Marvin                                                 | Apache-2.0                     | ~5 months quiet               | prototyping only                                                        |
| C    | vis-timeline                                           | Apache-2.0/MIT                 | maintainer seeking successor  | plan its replacement before deep-integrating                            |
| C    | visx                                                   | MIT                            | v4.0.0, users leaving         | sustainability red flag                                                 |
| D    | regl                                                   | MIT                            | frozen since ~2020            | do not build new rendering on it                                        |
| D    | Leaflet 1.x                                            | BSD-2                          | v2 in alpha for a year        | MapLibre is the future-proof choice                                     |
| E    | `@cosmograph/cosmograph` (UI wrapper)                  | **CC-BY-NC-4.0**               | active                        | non-commercial licence — forbidden                                      |
| E    | LM Studio (as a component)                             | proprietary, closed source     | active                        | recommend to users, never embed                                         |
| E    | `@finos/perspective` (old scope)                       | —                              | moved to `@perspective-dev/*` | don't add the deprecated name                                           |

**Bundle-budget consequence.** The 250 KB gzip initial-JS budget (`16_PERFORMANCE.md`) rules out
adopting a full graph framework wholesale. The recommended shape is: graphology as the in-memory
graph model, D3 submodules for maths, our own WebGL/Canvas renderer (already true of
`packages/canvas-engine`), and `@cosmograph/cosmos` lazily loaded only for the huge-graph mode.

---

## 7. Paid and BYOK services — the standing rules

1. Raven ships **no** vendor API key, ever, and never proxies a vendor through our infrastructure.
2. A paid source is an adapter with `requiresCredential: true`; in `APP_MODE=local` it stays
   invisible until the user pastes a key.
3. Keys live encrypted at rest, are never written to logs, run history or exported reports.
4. Each paid adapter declares its unit of cost (request, credit, page, query) and Raven tracks burn
   per key, warning before an overage — this is a product feature, not an afterthought (§8).
5. Data licences are separate from API access: OpenCorporates, OpenSanctions and IntelX restrict
   what may be stored or redistributed even after a legitimate paid query. Result nodes from such
   sources carry a `redistribution: restricted` flag and are excluded from shareable exports unless
   the user overrides with an explicit confirmation.

---

## 8. What Raven must build itself

None of the audited projects provide these; every one of them is Raven-owned product surface:

1. **The manifest-driven adapter layer** — one interface over "local CLI / container / remote API /
   in-browser WASM", with lifecycle, health, versioning and licence metadata per engine.
2. **Normalization into one entity/relation schema** — every extractor (Sherlock vs Maigret,
   Docling vs Marker vs GROBID, spaCy vs GLiNER vs an LLM) emits its own shape and its own notion of
   confidence. `packages/domain` owns the canonical target.
3. **Entity resolution UX** — Splink gives statistics, not a review queue, merge audit trail, or an
   un-merge path on a canvas.
4. **The extraction-quality arbiter and escalation ladder** — run cheap extractors first, score the
   result, escalate to expensive ones only when the score is low.
5. **A credential and cost broker** for BYOK sources, with quota tracking and pre-flight warnings.
6. **Provenance and legal-posture tagging** on every produced node and edge.
7. **A definition-freshness watchdog** for scraping-based tools (Sherlock/Maigret site lists,
   nuclei templates), diffing upstream definitions on a schedule so silent decay becomes an alert.
8. **A local inference-server manager** — Surya 2, MinerU VLM and dots.ocr all now require a serving
   backend; something must start them on demand, share the GPU and stop them when idle.
9. **An offline map-tile pipeline** so the geospatial view does not break the local-mode promise.
10. **A licence-compliance gate in CI** operating on the resolved dependency tree, failing closed on
    copyleft inside a bundled artifact.

---

## 9. Re-audit policy

- This document is re-verified **every quarter** and before any phase that adopts a new engine.
- A dependency may not be added unless it has a row here, or the PR adds one.
- Every row carries a date; a row older than six months is treated as unverified.
- Tier D/E entries are kept deliberately, with the reason, because the failure mode this file exists
  to prevent is adopting something that a tutorial, a listicle or a model's memory still recommends
  long after it died.

---

## 10. Re-verification pass — 2026-08-24

A second live pass (GitHub releases API, PyPI/npm/crates, vendor pricing and licence pages) covering
categories A–E plus documents/images/code. Where a row below disagrees with §2–§6, **this section
wins**. Anything not re-checked keeps its 2026-08-19 dating and must be treated as ageing.

### 10.1 Category A — discovery, verified passports

| Tier | Project             | Licence                       | Latest / last release      | Score | Note                                                                  |
| ---- | ------------------- | ----------------------------- | -------------------------- | ----- | --------------------------------------------------------------------- |
| A    | subfinder           | MIT                           | v2.16.0, 2026-08-22        | 90    | passive subdomain enumeration; keyless core                           |
| A    | OWASP Amass         | Apache-2.0                    | v5.1.1, 2026-04-07         | 88    | deep attack-surface graph, thinks in graphs                           |
| A    | dnsx                | MIT                           | v1.3.0, 2026-07-16         | 88    | DNS resolution/enrichment                                             |
| A    | httpx               | MIT                           | v1.10.0, 2026-07-09        | 87    | HTTP probing/fingerprinting                                           |
| A    | theHarvester        | **GPL-3.0**                   | 4.11.1, 2026-06-03         | 85    | subprocess only — never linked or vendored                            |
| A    | Sherlock            | MIT                           | v0.16.0, 2025-09-16        | 84    | username discovery; Python ≥3.10                                      |
| A    | Maigret             | MIT                           | v0.6.4, ~2026-08           | 82    | richer username profiling, 3000+ sites                                |
| A    | katana              | MIT                           | v1.7.0, 2026-08-05         | 83    | crawler; active fetching → authorization gate                         |
| B    | naabu               | MIT (GPL probe data excluded) | v2.6.1, ~2026-05           | 82    | port scanning — active scanner, gated                                 |
| B    | dnstwist            | Apache-2.0                    | 20250130 (calver)          | 78    | typosquat permutations                                                |
| B    | Blackbird           | **licence unconfirmed**       | rolling, commit 2025-07-13 | 70    | do not adopt until the LICENSE file is read                           |
| B    | Naminter            | MIT                           | rolling, active 2025–26    | 68    | young WhatsMyName-based checker                                       |
| A    | WhatsMyName dataset | CC BY-SA 4.0 (data)           | rolling                    | 80    | share-alike applies to the **data**; keep it as data, not a fork      |
| C    | holehe              | **GPL-3.0**                   | v1.61, ~2 years quiet      | 55    | at risk; subprocess only                                              |
| C    | recon-ng            | **GPL-3.0**                   | 5.1.2, upstream stagnant   | 55    | reference only                                                        |
| D    | sn0int              | **GPL-3.0**                   | v0.26.1, 2024-09-15        | 48    | >1.5 years quiet                                                      |
| D    | **SpiderFoot**      | MIT core                      | **v4.0, 2022-04-07**       | 45    | **demoted from a load-bearing engine** — see §10.5                    |
| D    | PhoneInfoga         | GPL-3.0                       | v2.11.0                    | 40    | README: "stable but unmaintained", may be archived — **do not adopt** |

Public data sources worth standing on: **GLEIF LEI** (CC0, no key, CORS-friendly), **RDAP** (IETF
standard, JSON, usually CORS-open), **dns.google / cloudflare-dns DoH JSON** (callable straight from
the browser — the only reliable in-browser discovery primitives), **Wikidata SPARQL** (CC0, needs an
explicit User-Agent), **ipinfo Lite** (free tier), **crt.sh** (free but heavily rate-limited, ~5
req/min per IP → server-side with cache only), **BGPView** (community-run, no SLA).

BYOK commercial: Shodan, Censys, urlscan (Pro from ~$1,250/mo), **VirusTotal public API is
non-commercial only** — a commercial deployment needs Premium, HIBP (from ~$3.90/mo),
OpenCorporates (free key is share-alike; non-share-alike from ~£6,600/yr), WhoisXML (500 free).

**In-browser (CORS) reality check.** Only DoH JSON, RDAP, GLEIF and Wikidata are reliably callable
from the browser. Username/e-mail checks, crt.sh and most vendor APIs are not — they need the runner
or the API process. Any UI design that assumes browser-side collection is wrong.

### 10.2 Documents, images, code — licence landmines

- **PyMuPDF is AGPL-3.0**, not MIT. Prefer `pdf.js` (browser), `pdfplumber`/`pdfminer.six` (server),
  `docling` or `unstructured` for structured extraction.
- **marker / surya (datalab-to)**: code is Apache-2.0 but the **model weights** are a modified AI
  Pubs OpenRAIL-M — free only below a revenue/funding threshold. Weights carry their own licence.
- **trufflehog is AGPL-3.0**, **cloc is GPL-2.0**, **licensee** drags in a Ruby runtime.
- **libraries.io**: AGPL and its open dataset is abandoned — call npm / PyPI / crates.io / Docker Hub
  registry APIs directly instead of an aggregator.
- Dead or stalled, with replacements: pHash.org C++ (2013 → python `imagehash`), blockhash-js (2014),
  face-api.js (author stopped → MediaPipe or `@vladmandic/face-api`, **unverified**), exif-js (2017),
  `exifr` (last release 2021 — usable but flag it, fallback `exiftool` wrapper).
- Recommended and active: pdf.js, docling, unstructured, tesseract.js, PaddleOCR, GLiNER, spaCy,
  transformers.js, sharp/libvips, file-type, Magika, OpenCV.js, tree-sitter, scc/tokei, semgrep,
  syft/grype/osv-scanner (or trivy), dependency-cruiser, cdxgen, gitleaks, jscpd.
- **Runs in the browser via WASM**: pdf.js, tesseract.js, transformers.js, OpenCV.js,
  web-tree-sitter, Magika. That set defines what the local-first mode can do with no server.

### 10.3 Search, orchestration, graph, AI — corrections

- **Bing Web Search API is retired** (Microsoft Learn marks the page retired/archived). Any plan that
  assumed it is void.
- **Kuzu is archived by its own team** — remove from the embedded-graph shortlist.
- **RedisGraph is discontinued**; **Whoogle** is archived by its owner; Postlight Parser, Cayley,
  `dedupe` and `recordlinkage` are stalled.
- **`@xenova/transformers` is dead (since 2024-05); the maintained successor is
  `@huggingface/transformers`** — easy and expensive to confuse.
- Licences confirmed by reading LICENSE: n8n = Sustainable Use Licence (not OSI), Windmill = AGPLv3
  - proprietary EE, Memgraph and ArangoDB = BUSL 1.1, SearXNG / Zingg / Firecrawl core = AGPL-3.0,
    Neo4j Community = GPL-3.0. All of these are "point at as an external service", never vendored.
- Working shortlist for phase 2: search — Tavily/Exa + Brave Search API + self-hosted SearXNG as
  fallback; extraction — trafilatura + defuddle; crawling — Crawlee + Playwright; orchestration —
  pg-boss for light jobs, Temporal if durable multi-step routing is needed; AI — pgvector +
  `@huggingface/transformers` + LangGraph; graph — Apache AGE (Postgres extension) + Splink for
  entity resolution; visualization — sigma.js + graphology, maplibre-gl + deck.gl, vis-timeline.

### 10.4 Scoring method

Integration Score /100 is a weighted expert judgement, not a computed metric: Maintenance 15,
Security 15, Performance 15, Compatibility 10, API quality 10, Output quality 10, Community 10,
Licence 10, Complexity 5. Two engines within ~5 points of each other are a tie — decide on licence
and adapter cost, not on the number.

### 10.5 Consequences for the build

1. `26_OPEN_SOURCE_REGISTRY.md` §2.3 (spiderfoot) is demoted to Tier D and must not be presented as
   the broad-sweep engine. The capability it was covering is re-composed from subfinder + dnsx +
   httpx + theHarvester + public APIs, which are all actively maintained.
2. Any GPL/AGPL engine (theHarvester, holehe, recon-ng, trufflehog, SearXNG, Firecrawl core) is
   invoked as a **separate process or service** only — never linked, never vendored. This is already
   the house rule in §1; the pass adds names to it.
3. The browser-executable set (§10.1, §10.2) is the true ceiling of `APP_MODE=local` with no runner.
   Product copy must not promise more than that offline.

### 10.6 Not verified in this pass

`@vladmandic/face-api`, `exiftool-vendored`, practical browser ONNX export for GLiNER, Docker Hub tag
freshness, and direct GitHub-API confirmation for Scrapy, Selenium, Celery, sentence-transformers and
Oxigraph (rate-limited at 60 req/h; versions taken from PyPI). All of these stay **unverified** until
opened at the source.
