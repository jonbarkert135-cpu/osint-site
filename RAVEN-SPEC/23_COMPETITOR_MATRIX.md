# Raven — 23 — COMPETITOR & ADJACENT-PRODUCT MATRIX

## Scope

Where Raven sits among the products an analyst could use instead: commercial intelligence platforms,
open-source investigation stacks, canvas/knowledge tools, and AI research agents. The purpose is to
decide what to copy, what to do better, what to deliberately not build, and which gap Raven is
actually filling — not to produce a sales battlecard.

Non-goals: the open-source engines Raven builds **on** (`22_ECOSYSTEM_AUDIT.md`), the Maltego
transform ecosystem specifically (`docs/ecosystem/MALTEGO_AUDIT.md`), and the design of our own
query layer (`24_UNIFIED_QUERY.md`).

> **Provenance, read this first.** Dated 2026-08-19. This document is a **qualitative positioning
> analysis** based on domain knowledge of these products. Unlike `22_ECOSYSTEM_AUDIT.md`, its rows
> were **not** verified against primary sources in this pass. Therefore it deliberately contains
> **no version numbers, no prices, no release dates and no licence assertions** that a decision
> could be hung on. Treat every cell as a hypothesis about product shape, useful for direction,
> unusable as evidence. §7 lists exactly what must be verified before any of this informs a
> commitment (licences and pricing above all).

---

## 1. What is table stakes in 2026

A product in this space that lacks these is not considered serious by buyers. None of them is a
differentiator; all of them are the entry ticket.

1. An entity/link graph with expandable nodes, plus timeline and map views over the same data.
2. A connector/transform catalog rather than hard-coded sources, with per-source credentials.
3. Full-text and semantic search over ingested documents, OCR for scans, transcription for media.
4. LLM assistance: summarize a document set, draft a dossier, natural language to query. Expected
   everywhere, good almost nowhere.
5. Provenance and an audit trail — who collected what, when, from where.
6. Collaboration: cases, comments, roles. SaaS by default, self-hosting for government buyers.
7. Report export with figures and citations.
8. In the canvas tier specifically: real-time multiplayer.
9. In the notes tier specifically: local-first storage with offline editing and CRDT sync.

Raven's non-negotiable additions on top of that list: local-first as the **default** shape, and
provenance an analyst can actually click through to the raw response.

---

## 2. The matrix

Columns follow the brief. "Relevance" means relevance to Raven's design decisions, not market
threat. All rows unverified (see the banner).

### 2.1 Commercial intelligence platforms

| Product                                             | Category                | Best features                                                              | Weaknesses                                                                        | OSS    | Self-host | API     | Plugin-friendly  | Architecture                       | UX lesson                                                    | Relevance                       |
| --------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------ | --------- | ------- | ---------------- | ---------------------------------- | ------------------------------------------------------------ | ------------------------------- |
| Maltego                                             | Intel platform          | Transform ecosystem; expand-on-node is the genre's reference gesture       | Desktop-Java feel; per-transform data costs stack; graphs get unreadable at scale | No     | Partly    | Yes     | Yes (transforms) | Desktop client + transform servers | Right-click an entity → pick an engine → results attach      | **High**                        |
| Palantir Gotham / Foundry                           | Intel platform          | Ontology layer, lineage, scale                                             | Cost; depends on forward-deployed engineers; unbuyable by small teams             | No     | Yes       | Yes     | Limited          | Ontology + pipelines               | Ontology-first modelling (conceptually)                      | Medium                          |
| IBM i2 Analyst's Notebook                           | Intel platform          | Link-chart semantics and timeline analysis; the LE standard                | Legacy Windows UI; weak collaboration                                             | No     | Yes       | Limited | Some             | Thick desktop client               | Its chart conventions are worth mirroring                    | Medium                          |
| Blackdot Videris                                    | OSINT platform          | The cleanest modern graph UI in the commercial tier; collection into chart | Closed; limited extensibility                                                     | No     | Some      | Yes     | No               | SaaS + collectors                  | Collection results flow straight into the chart              | **High**                        |
| Skopenow / Liferaft Navigator                       | OSINT SaaS              | Fast person/company dossiers                                               | Shallow past the dossier; brittle when platforms change                           | No     | No        | Some    | No               | SaaS collectors                    | One-click dossier as an entry point                          | High                            |
| ShadowDragon Horizon                                | OSINT                   | Broad social/dark-web collection                                           | Ethics criticism; uneven UI                                                       | No     | Some      | Yes     | Some             | Collector suite                    | —                                                            | Medium                          |
| Recorded Future / Babel Street / Fivecast / Cognyte | Data-feed intel         | Curated feeds, alerting, risk scoring                                      | You rent data, not tooling; opaque sourcing; ethics exposure                      | No     | Rarely    | Yes     | No               | SaaS feed + analytics              | Alerting UX only                                             | Medium (as sources, not rivals) |
| Nuix Investigate                                    | eDiscovery/forensics    | Huge-corpus processing; forensic formats                                   | Heavy, expensive, forensic rather than OSINT                                      | No     | Yes       | Yes     | Some             | Distributed processing             | Avoid its interface density                                  | Low                             |
| Linkurious Enterprise                               | Graph analytics         | Investigation UI over an existing graph DB; alerting                       | Requires you to already have the graph                                            | No     | Yes       | Yes     | Some             | On top of Neo4j                    | Graph filtering UX                                           | Medium                          |
| Siren                                               | Investigative analytics | Graph + search + timeline, federated queries                               | Real data-engineering effort to stand up                                          | Partly | Yes       | Yes     | Yes              | Elasticsearch-backed federation    | "Query where the data lives" instead of ingesting everything | High                            |

### 2.2 Open-source investigation stacks

| Product           | Category            | Best features                                                                 | Weaknesses                                                | OSS      | Self-host | API           | Plugin-friendly | Architecture              | UX lesson                                    | Relevance              |
| ----------------- | ------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------- | -------- | --------- | ------------- | --------------- | ------------------------- | -------------------------------------------- | ---------------------- |
| OpenCTI           | OSS threat intel    | STIX2 data model; a real connector contract; active community                 | CTI-shaped rather than general investigation; heavy stack | Yes      | Yes       | Yes (GraphQL) | Yes             | GraphQL + search + queue  | Its connector contract is a model to copy    | **High**               |
| OCCRP Aleph       | OSS investigation   | Cross-dataset entity matching; the FollowTheMoney ontology; leak-scale ingest | Ops-heavy; search-centric, no canvas                      | Yes      | Yes       | Yes           | Some            | FtM + relational + search | Adopt FtM rather than inventing a schema     | **High**               |
| SpiderFoot        | OSS/SaaS recon      | Very many modules; automated scans                                            | Noisy output; weak correlation                            | Core OSS | Yes       | Yes           | Yes (modules)   | Scan engine + modules     | The module model; the noise is the lesson    | **High** (already P12) |
| ICIJ Datashare    | OSS documents       | Local document analysis, NER, batch search                                    | Documents only; no graph canvas                           | Yes      | Yes       | Some          | Some            | Local service + search    | Local-first stance matches ours              | High                   |
| Timesketch        | OSS timeline        | Collaborative timeline analysis; sketches as artifacts                        | Forensics-shaped; dated UI                                | Yes      | Yes       | Yes           | Yes             | Search-backed             | The timeline is a saved object, not a toggle | Medium                 |
| Gephi / Cytoscape | OSS graph           | Layout algorithms and network metrics                                         | Desktop, static, no investigation workflow                | Yes      | Yes       | Partly        | Yes             | Desktop + plugins         | The metrics menu                             | Low                    |
| Graphistry        | Graph visualization | GPU rendering of very large graphs                                            | Visualization layer only                                  | Partly   | Yes       | Yes           | Yes             | GPU rendering             | Scale-rendering lessons                      | Medium                 |

### 2.3 Canvas, notes and knowledge tools

| Product                           | Category           | Best features                                                              | Weaknesses                                        | OSS                       | Self-host  | API       | Plugin-friendly | Architecture                | UX lesson                                                   | Relevance |
| --------------------------------- | ------------------ | -------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------- | ---------- | --------- | --------------- | --------------------------- | ----------------------------------------------------------- | --------- |
| Obsidian (+ Canvas, Excalidraw)   | Knowledge          | Local plain files; the strongest plugin ecosystem; open canvas file format | Canvas weak at scale; no data layer               | App is free, not OSS      | Local      | Local-ish | Best-in-class   | Markdown vault + plugin API | Plain, diffable case files; canvas-file interop             | **High**  |
| Affine                            | Knowledge / canvas | Document ↔ whiteboard duality over one content model; local-first         | Younger; performance                              | Yes                       | Yes        | Some      | Some            | CRDT block model            | One keystroke between page and edgeless mode                | **High**  |
| Milanote / Miro / FigJam          | Canvas             | Multiplayer, polish, performance                                           | No data model beneath the rectangles              | No                        | No         | Yes       | Some            | SaaS canvas                 | Multiplayer feel; nothing structural                        | Medium    |
| tldraw                            | Canvas SDK         | Embeddable, excellent interaction model                                    | **Licence terms must be verified** before any use | Source-available (verify) | Yes        | Yes       | Yes             | React canvas SDK            | Interaction model reference only — we render our own canvas | Medium    |
| Heptabase / Scrintal / Kosmik     | Visual research    | Cards on a canvas tied to reading and notes                                | Cloud, closed, small teams                        | No                        | No         | Limited   | No              | SaaS canvas                 | Card-on-canvas reading workflow                             | High      |
| Notion                            | Knowledge          | Databases + docs, polish                                                   | Cloud-only; no real canvas                        | No                        | No         | Yes       | Yes             | SaaS blocks                 | Database views over the same objects                        | Medium    |
| Tana / Capacities / Logseq / Roam | Outliner / PKM     | Typed objects and supertags                                                | Learning curve; ecosystem churn                   | Logseq yes                | Logseq yes | Some      | Some            | Block graph                 | Typed objects, not free text                                | Medium    |
| Kumu                              | Relationship maps  | Beautiful stakeholder maps                                                 | Manual data; no collection                        | No                        | No         | Some      | No              | SaaS                        | Map styling                                                 | Low       |

### 2.4 AI research and agent products

| Product                                         | Category       | Best features                                          | Weaknesses                                    | OSS    | Self-host | API  | Plugin-friendly | Architecture                 | UX lesson                              | Relevance |
| ----------------------------------------------- | -------------- | ------------------------------------------------------ | --------------------------------------------- | ------ | --------- | ---- | --------------- | ---------------------------- | -------------------------------------- | --------- |
| NotebookLM                                      | AI research    | Answers grounded in your own sources, with citations   | Cloud; closed corpus; no graph                | No     | No        | No   | No              | Hosted model + grounding     | Every sentence anchored to a source    | High      |
| Deep-research products / GPT Researcher / STORM | AI agents      | Multi-step planning; outline-then-write; cited reports | Slow; hallucinated citations; output is prose | Partly | Yes       | Yes  | Yes             | planner → retriever → writer | **Show the plan while it runs**        | **High**  |
| Perplexity Spaces                               | AI research    | Fast sourced answers; shared spaces                    | Shallow; no durable artifact                  | No     | No        | Yes  | No              | Search + LLM                 | Inline citation chips                  | Medium    |
| Elicit / Consensus                              | AI research    | Structured extraction across papers                    | Academic corpus only                          | No     | No        | Some | No              | Paper pipelines              | Extraction straight into a table       | Medium    |
| Reor / Khoj                                     | Local AI notes | Local models over your own notes                       | Rough edges; small projects                   | Yes    | Yes       | Some | Some            | Local embeddings             | Local RAG plumbing                     | Medium    |
| Hunchly                                         | Capture        | Automatic, hashed capture of everything you browse     | Platform-bound; capture only, no analysis     | No     | Local app | No   | No              | Extension + local store      | **Passive capture into the open case** | **High**  |

---

## 3. Best ideas to adopt

1. **Expand-on-node (Maltego).** Right-click an entity, choose a capability, results attach as
   connected nodes. This is the single most important borrowed gesture; `24_UNIFIED_QUERY.md` §3
   makes the query bar the second entry point to the same machinery.
2. **A documented connector contract (OpenCTI).** Declared inputs, outputs, rate limits and
   confidence, so third parties can ship engines. Already our manifest direction — the lesson is to
   document and version it as a public contract, not an internal shape.
3. **FollowTheMoney (Aleph).** Strongly consider adopting FtM as the entity ontology, or at minimum
   guaranteeing a lossless FtM import/export. It is the closest thing to a shared standard in
   investigative journalism, and adopting it makes Raven interoperable on day one instead of being
   another silo. **Decision to be taken in P17 planning, with the FtM spec actually read.**
4. **Passive capture (Hunchly).** A browser companion that archives, hashes and timestamps every
   page visited during a case. Cheap to build on top of the P6 capture pipeline, and it is the
   feature working investigators reliably rave about.
5. **Page ↔ edgeless duality (Affine).** The same content as a document or as canvas objects, one
   keystroke apart.
6. **Plain, diffable case files (Obsidian).** A case is a folder you can put in git, not a blob in
   someone's cloud — the natural expression of our local-first ADR.
7. **Show the plan while it runs (STORM / deep-research agents).** Our plan review surface
   (`24` §5) is exactly this, one step further: the plan is editable before it executes.
8. **Citation anchoring (NotebookLM).** Any generated sentence links to the exact node and the exact
   raw response that supports it.
9. **The timeline as a saved artifact (Timesketch)**, not a view toggle.

## 4. Ideas to improve on

| Their failure                                                  | Raven's answer                                                                          |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Graphs become hairballs past a few hundred nodes (Maltego, i2) | auto-clustering and "collapse to group" by default; spatial layout the analyst controls |
| One-click dossiers are shallow and locked (Skopenow, Liferaft) | a dossier is an editable canvas subgraph, not a PDF                                     |
| Module output is noise (SpiderFoot)                            | ranked, deduplicated, confidence-scored results; raw hits behind a drawer (`24` §7)     |
| Deep-research agents produce a wall of prose                   | agents produce typed entities and claims on the canvas; prose is optional output        |
| Canvases have no data layer (Obsidian Canvas, Miro)            | every node is a typed entity with properties and provenance                             |
| Excellent link semantics trapped in a 2005 UI (i2)             | keep the semantics, modern rendering (`07_EDGE_SYSTEM.md`)                              |
| "Audit log" that you cannot actually inspect (everyone)        | click a fact → see the run, the request and the raw response                            |

## 5. Ideas to reject, deliberately

- **Ontology modelling before value (Palantir).** Raven must be useful within ten minutes of first
  launch, with zero configuration.
- **Selling data feeds.** A licensing trap and an ethics exposure; Raven sells tooling, and paid
  data stays BYOK (`22_ECOSYSTEM_AUDIT.md` §7).
- **Cloud-only multiplayer as the default (Miro, Notion).** It breaks the local-first guarantee that
  is our whole positioning.
- **Automated "risk scores" on people (Fivecast/Cognyte flavour).** Impressive in a demo,
  indefensible in real casework, legally and ethically toxic. Confidence in Raven describes _how
  well a fact is sourced_, never _how dangerous a person is_.
- **Auto-layout as the primary interaction (Gephi).** Investigators rely on spatial memory; a graph
  that re-shuffles itself destroys it.
- **Forensic chain-of-custody certification (Nuix).** Large scope, small market, not our first act.

## 6. Ideas to build ourselves — where Raven wins

Five gaps nobody currently serves; together they are Raven's actual product thesis:

1. **Local-first _plus_ serious collection.** Intelligence platforms are SaaS; local-first tools do
   not collect. Nothing does both. This is the primary gap.
2. **A canvas with a real entity model beneath it.** Canvas tools are dumb rectangles; graph tools
   deny spatial freedom.
3. **An affordable middle tier** between free-but-noisy open-source recon and enterprise platforms
   priced for governments — the three-person team, the newsroom, the fraud analyst.
4. **Agents that produce artifacts, not essays** — verified entities dropped into a workspace you
   keep working in.
5. **Provenance you can actually inspect** — click a fact, see the HTTP response that produced it.

Concretely, this implies building: the engine-orchestration plan as canvas objects; a single
file-backed case bundle holding graph, vectors and documents; provenance as a first-class visual;
time-travel and run-diff over the case's CRDT history; BYO-model routing with a per-case budget; and
importers for Maltego `.mtgx`, Obsidian `.canvas`, Aleph FtM and OpenCTI STIX, so Raven is a
migration target rather than another silo.

## 7. Verification backlog (must be done before any of this drives a commitment)

1. **tldraw's licence terms** — asserted nowhere in this file; verify before even prototyping with it.
2. **FollowTheMoney** — read the spec and Aleph's import/export surface before deciding on adoption.
3. **OpenCTI's connector contract** — read the actual interface docs before copying it.
4. **The Obsidian `.canvas` format spec** — verify before promising interop.
5. **Affine's project status and licence.**
6. **STORM / GPT Researcher licences** if any code is reused rather than only the idea.
7. **All pricing claims** — none are made here; if any enter a deck or a positioning statement they
   must be sourced first.
8. **User complaints** should be sourced from real forums (r/OSINT, product communities, review
   sites) rather than recollection, before §4 hardens into product decisions.

---

## 8. Verified competitor pass — 2026-08-24

**Provenance.** Every claim in this section was checked against a primary vendor page (pricing,
product, docs) or an independent review on **2026-08-24** via live web search. It supersedes the
unverified cells above wherever the two disagree. Prices move; re-verify anything older than 90 days
before it enters a deck, a plan or a pricing decision.

### 8.1 The matrix (Part 2 §5 columns)

| Product                        | Category                 | Best features                                                  | Weaknesses                                           | Open source         | Self-hosted        | API                     | Plugin friendly      | Architecture                    | UX                      | Relevance to Raven                      |
| ------------------------------ | ------------------------ | -------------------------------------------------------------- | ---------------------------------------------------- | ------------------- | ------------------ | ----------------------- | -------------------- | ------------------------------- | ----------------------- | --------------------------------------- |
| Maltego                        | Link analysis / OSINT    | Transform Hub (~96 integrations), Machines, mature graph UX    | Opaque credit pricing, desktop-first                 | no (free CE tier)   | partial (TDS)      | yes (Transform SDK)     | yes                  | property graph + transforms     | desktop, steep curve    | high — the marketplace model            |
| SpiderFoot / HX                | OSINT automation         | 200+ modules, free core, HX monitoring & alerts                | OSS edition is single-user, core unmaintained (§8.3) | yes (MIT core)      | yes                | partial (HX)            | yes (Python modules) | modular, event-driven           | web UI / CLI            | high — OSS→cloud monetization pattern   |
| Hunchly                        | Evidence capture         | Auto SHA-256 page capture, court-ready exports                 | Chrome-only, no collaboration, no graph              | no                  | yes (local store)  | no                      | no                   | linear case file                | simple, single-user     | medium — evidence module inside a node  |
| IBM i2 Analyst's Notebook      | Link analysis (gov/LE)   | TextChart, data connectors, maturity                           | Legacy UX, multi-SKU licensing                       | no                  | yes (Analysis Hub) | partial (connector kit) | limited              | proprietary chart model         | desktop, complex        | medium — the data-connector pattern     |
| Palantir Gotham                | Enterprise intel         | Data fusion at scale, AI ops                                   | Astronomical price, lock-in                          | no                  | yes (air-gapped)   | yes                     | limited              | ontology + Foundry hybrid       | analyst-grade, high bar | low segment fit, useful ambition bar    |
| DataWalk                       | Investigative graph+AI   | Unified graph (LPG+RDF+OLAP+vector), no-code entity resolution | Undisclosed price, weaker brand                      | no                  | yes (cluster)      | yes (JDBC/ODBC)         | yes (App Center)     | hybrid graph engine             | no-code visual          | high — hybrid graph model               |
| Linkurious                     | Graph visualization      | Transparent two-tier pricing, DB-agnostic                      | Stores no data itself                                | no                  | yes                | yes (REST + webhooks)   | yes                  | viz layer over a graph DB       | web, intuitive          | high — honest pricing                   |
| Siren                          | Search-led investigation | Semantic search, billions of records, mobile                   | Undisclosed price, LE-focused                        | no                  | yes                | yes                     | yes                  | Elasticsearch + Federate        | search-first            | medium — search-first pattern           |
| Nuix Investigate               | Forensics / eDiscovery   | Reviewer scale, communication-pattern views                    | Not an OSINT graph, complex licensing                | no                  | yes                | limited                 | no                   | document indexing               | web reviewer            | low — adjacent category                 |
| Skopenow                       | Fraud/threat OSINT SaaS  | Confidence scoring on individual facts, auto-aggregation       | Undisclosed price, narrow focus                      | no                  | no                 | limited                 | no                   | pipeline + models               | simple                  | medium — per-fact confidence UI         |
| Liferaft Navigator             | Threat monitoring        | AI dedupe, insights digest, deep/dark web                      | No graph canvas, undisclosed price                   | no                  | no                 | limited                 | no                   | monitoring/alert engine         | dashboard-centric       | medium — noise-reduction pattern        |
| ShadowDragon Horizon/SocialNet | Collection & monitoring  | Alias resolution across 200+ platforms, OIMonitor, snapshots   | Sales-gated, expensive                               | no                  | no                 | as a data source        | yes (inside Maltego) | real-time collection            | web, sales-gated        | high — watchlist/monitoring pattern     |
| Recorded Future                | Threat intelligence      | One Intelligence Graph behind many products                    | Narrow cyber-TI niche, expensive                     | no                  | no                 | yes                     | yes (SIEM/SOAR)      | single graph + solution modules | enterprise dashboard    | medium — "one graph, many products"     |
| Intelligence X                 | Leak/darkweb search      | Full breach records, permanent archive, public pricing         | Not real-time, legal grey zone                       | no                  | no                 | yes (Search + Leaks)    | limited              | index + archive                 | simple search           | medium — transparent pricing example    |
| OSINT Industries               | Selector enrichment      | Transparent credits, real-time lookups                         | Narrow, no graph                                     | no                  | no                 | yes (upper tiers)       | modular sources      | real-time API aggregator        | very simple             | high — credit + add-on monetization     |
| Obsidian (+ Canvas)            | PKM / canvas             | 1200+ plugins, local-first, offline                            | No native realtime collaboration                     | no (partly visible) | yes (default)      | limited (plugin API)    | yes (huge ecosystem) | markdown files + link graph     | tinkerable              | medium — plugin ecosystem model         |
| Notion                         | Cloud workspace/canvas   | Realtime collaboration, database views                         | Cloud-only, no offline-first                         | no                  | no                 | yes (REST)              | yes                  | pages + databases               | polished but complex    | medium — collaboration UX benchmark     |
| Milanote                       | Visual board             | Effortless drag-drop ideation                                  | Few integrations                                     | no                  | no                 | limited                 | limited              | board-based                     | very simple             | low                                     |
| Miro                           | Enterprise whiteboard    | MCP server (agent-native), 250+ integrations                   | Costly at scale, not for structured graphs           | no                  | no                 | yes (REST + MCP)        | yes                  | canvas engine + AI workflows    | polished enterprise     | high — the MCP pattern                  |
| Kumu                           | Relationship mapping     | Rich narrative per node/edge, focus mode                       | Weak API, no OSINT data                              | no                  | yes (enterprise)   | limited                 | limited              | graph + narrative layer         | presentation-focused    | high — presentation/report views        |
| tldraw                         | Canvas SDK               | Production-grade multiplayer canvas out of the box             | An SDK, not a product; paid licence                  | source-available    | yes (embeddable)   | yes (runtime API)       | yes                  | React canvas engine             | developer-facing        | high — canvas-engine table-stakes bar   |
| Heptabase                      | AI research whiteboard   | AI "reads with you", cited answers, self-hosted embeddings     | Not built for team investigations                    | no                  | no                 | limited (CLI)           | limited              | cards + whiteboard + AI         | polished                | high — AI panel pattern                 |
| Logseq                         | Local-first outliner     | Genuinely open source, hosted-only monetization                | DB version still beta                                | yes                 | yes (default)      | limited                 | yes                  | markdown/SQLite + outline graph | power-user              | medium — open-core model                |
| Perplexity Deep Research       | AI search/research       | Fast (2–4 min), cheap, browser agent                           | Weaker on non-obvious findings                       | no                  | no                 | limited                 | no                   | LLM + web retrieval             | chat-first              | high — the speed/price benchmark        |
| Elicit                         | AI systematic review     | PRISMA-grade extraction, unified credit pool                   | Narrow academic niche                                | no                  | no                 | yes (enterprise)        | limited              | LLM + academic corpus           | specialised workflow    | medium — unified usage pool             |
| Exa Websets                    | Agentic search API       | Criteria verification + enrichment, usage-based pricing        | Not an end-user product, slow queries                | no                  | no                 | yes (API-first)         | yes (SDK)            | search → verify → enrich        | developer/dashboard     | high — direct pattern for Raven's agent |
| OpenAI / Gemini Deep Research  | Agentic research         | Shows the plan before executing, workspace context             | Embedded in a general product                        | no                  | no                 | limited (MCP)           | yes (MCP, OpenAI)    | multi-step reasoning agent      | chat + report           | medium — plan-before-execute UX         |

### 8.2 Verified pricing anchors (2026-08-24)

Only figures that were read off a vendor or independent-review page are listed. Everything else is
deliberately absent rather than guessed.

| Product                                                              | Verified pricing signal                                                                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Maltego                                                              | Community free; Professional credit-based (Standard 20k / Advanced 40k credits) from ~€7,500/yr; >5 seats → Enterprise, quoted |
| SpiderFoot HX                                                        | Annual only, three tiers (Freelancer 15 scans/mo, 1 user; Business 50 scans/mo, 3 users; Enterprise custom)                    |
| Hunchly                                                              | ~$129.99/yr Classic (local storage); cloud storage priced separately                                                           |
| ShadowDragon                                                         | Sales-gated; monitoring tier widely reported in the tens of thousands per year — treat as an order of magnitude, not a quote   |
| Intelligence X                                                       | Public tiered pricing for search + leaks API                                                                                   |
| OSINT Industries                                                     | Public credit-based tiers with add-on sources                                                                                  |
| Linkurious                                                           | Public two-tier model (managed vs self-managed)                                                                                |
| Palantir, DataWalk, Siren, Nuix, Skopenow, Liferaft, Recorded Future | No public price. Quote-only.                                                                                                   |

### 8.3 Findings that change our plans

1. **SpiderFoot's open-source core is effectively unmaintained** — last release v4.0 on 2022-04-07;
   the project was acquired by Intel 471 and an open issue titled "Project Dead?" stands unanswered.
   It may stay a _reference_ for module breadth and for the OSS→cloud business pattern, but it must
   not be a load-bearing engine. See `26_OPEN_SOURCE_REGISTRY.md` §2.3, now demoted.
2. **The "honest pricing" gap is real.** Every graph-capable competitor except Linkurious and
   Intelligence X hides its price. A public price _plus_ a self-hosted option is a rare combination
   and a genuine wedge.
3. **Agent-native access is becoming table stakes.** Miro already ships an MCP server; OpenAI ships
   MCP support. Raven should expose the canvas over MCP alongside the plugin SDK.
4. **Nobody combines verification + explanation + suggestion.** Exa verifies results against
   criteria, Heptabase explains with citations, Maltego Machines suggest next steps — no product
   does all three on one investigation graph. That combination is Raven's differentiator.

### 8.4 White space (five unserved niches)

1. A graph-capable investigation canvas with **public** per-seat/credit pricing for SMB and
   independent investigators — between OSINT Industries (no graph) and Maltego Enterprise/Palantir.
2. **AI-verified auto-enrichment inside the canvas**: click a node → the agent searches, verifies
   against criteria and attaches entities with explainable confidence.
3. **Affordable persistent identity monitoring** — today an enterprise-only module.
4. A **presentation/storytelling layer over an investigation graph** (client and court-facing
   reports straight from the canvas).
5. **Open-core, self-hosted, agent-native** investigation canvas — open-core exists (Logseq),
   agent-native exists (Miro/tldraw); nobody ships both for investigations.

### 8.5 Table stakes, re-confirmed

Full-text + fuzzy graph search · no-code/visual query builder · geospatial and temporal views ·
entity resolution · report export (PDF/CSV/MD) · record- and field-level RBAC · change alerts and
monitoring · API + webhooks · undo/redo, multiplayer cursors, copy-paste · a plugin/transform
ecosystem. Against our tracker (`25_IMPLEMENTATION_STATUS.md`) the still-open ones are: alternative
views (§31/§32), export beyond `.raven`/JSON (§29), monitoring, and the plugin SDK.

### 8.6 Verification backlog, updated

Items 7 and 8 of §7 are now partly discharged (pricing anchors above are sourced; the weakness
column draws on vendor docs and independent reviews). Still open and unverified: tldraw's licence
terms, the FollowTheMoney spec, OpenCTI's connector contract, the Obsidian `.canvas` format, and
Affine's status. No decision may rest on those five until each is read at the source.
