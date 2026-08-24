/**
 * The five GitHub job handlers (11_GITHUB.md §10, §4, §5, §6).
 *
 * Orchestration only: fetching goes through the counting `GithubClient` (§8), analysis and proposal
 * building stay in their pure modules, and every write goes through an injected store — so this
 * file has no Prisma, no Redis and no `Date.now()`, and the worker stays a thin wiring layer.
 */

import {
  githubRefKey,
  type GithubRef,
  type RepositoryAnalysis,
  type RepositoryData,
} from '@nexus/domain';

import type { GithubClient } from './client.ts';
import { collectAnalysisInputs } from './analysis/collect.ts';
import { analyzeRepository } from './analysis/analyze.ts';
import { buildIntegrationProposal, type IntegrationProposal } from './proposal.ts';
import type {
  GithubAnalyzePayload,
  GithubHydratePayload,
  GithubJobName,
  GithubJobPayload,
  GithubProposalPayload,
  GithubSweepPayload,
  GithubTabPayload,
} from './jobs.ts';
import { mapRepository, type RepoApi } from './repository.ts';

/** §4.3's lazy inspector tabs, each with its endpoint and TTL. `related` is local-graph only. */
export const GITHUB_TABS = {
  readme: { path: (key: string) => `/repos/${key}/readme`, ttlMs: 24 * 3_600_000 },
  releases: { path: (key: string) => `/repos/${key}/releases?per_page=20`, ttlMs: 6 * 3_600_000 },
  issues: { path: (key: string) => `/repos/${key}/issues?state=open&per_page=30`, ttlMs: 900_000 },
  contributors: {
    path: (key: string) => `/repos/${key}/contributors?per_page=30`,
    ttlMs: 24 * 3_600_000,
  },
} as const;

export type GithubTabName = keyof typeof GITHUB_TABS;

export function isGithubTab(tab: string): tab is GithubTabName {
  return Object.hasOwn(GITHUB_TABS, tab);
}

export interface RepositoryNodeRow {
  nodeId: string;
  repoKey: string;
  /** `fetch.lastFetchedAt`, ISO — `null` for a node that was never hydrated. */
  lastFetchedAt: string | null;
  ref: GithubRef;
}

export interface GithubHandlerStore {
  /** §3.5 item 3: hydration is a direct field patch, never a proposal — the user made this node. */
  patchRepositoryNode(nodeId: string, data: RepositoryData): Promise<void>;
  /** Per-tab cache with its own TTL (§4.3). */
  readTab(nodeId: string, tab: GithubTabName): Promise<{ fetchedAt: string } | null>;
  writeTab(nodeId: string, tab: GithubTabName, payload: unknown, fetchedAt: string): Promise<void>;
  saveAnalysis(analysis: RepositoryAnalysis): Promise<string>;
  loadAnalysis(analysisId: string): Promise<RepositoryAnalysis | null>;
  saveProposal(proposal: IntegrationProposal): Promise<void>;
  /** Repository nodes on a watched board, for the 30-min sweep (§4.4 rule 2). */
  listRepositoryNodes(boardId: string): Promise<readonly RepositoryNodeRow[]>;
  repoKeyOfNode(nodeId: string): Promise<string | null>;
}

export interface GithubHandlerDeps {
  readonly store: GithubHandlerStore;
  /** One client per job: the request cap in §5.9 is per analysis, not per process. */
  createClient(signal: AbortSignal): GithubClient;
  enqueueHydrate(payload: GithubHydratePayload): Promise<void>;
  /** Chains §6: a fresh analysis is immediately turned into a draft integration proposal. */
  enqueueProposal(payload: GithubProposalPayload): Promise<void>;
  newId(): string;
  now(): number;
}

export type GithubHandlers = {
  [N in GithubJobName]: (payload: GithubJobPayload[N], signal: AbortSignal) => Promise<void>;
};

/** §4.4's warm TTL: the sweep only refreshes nodes older than this. */
export const SWEEP_TTL_MS = 6 * 3_600_000;

export function createGithubHandlers(deps: GithubHandlerDeps): GithubHandlers {
  return {
    'github.hydrate': async (payload, signal) => hydrate(deps, payload, signal),
    'github.tab': async (payload, signal) => tab(deps, payload, signal),
    'github.analyze': async (payload, signal) => analyze(deps, payload, signal),
    'github.proposal': async (payload) => proposal(deps, payload),
    'github.sweep': async (payload) => sweep(deps, payload),
  };
}

/** Repo/path/blob refs all hydrate the repository they belong to; owner refs have no repo. */
function repoKeyOf(ref: GithubRef): string | null {
  return 'repo' in ref ? `${ref.owner}/${ref.repo}` : null;
}

async function hydrate(
  deps: GithubHandlerDeps,
  payload: GithubHydratePayload,
  signal: AbortSignal,
): Promise<void> {
  const repoKey = repoKeyOf(payload.ref);
  if (repoKey === null) return;
  const client = deps.createClient(signal);
  const api = await client.json<RepoApi>(`/repos/${repoKey}`);
  // 404 keeps the node as a link with an error badge (§3.5 item 4); N8 forbids deleting cached data.
  if (api === null) return;
  const languages =
    (await client.json<Record<string, number>>(`/repos/${repoKey}/languages`)) ?? {};
  await deps.store.patchRepositoryNode(
    payload.nodeId,
    mapRepository(api, {
      key: githubRefKey(payload.ref),
      languages,
      pinnedRef: payload.ref.kind === 'repo' ? (payload.ref.ref ?? null) : null,
      fetchedAt: new Date(deps.now()).toISOString(),
    }),
  );
}

async function tab(
  deps: GithubHandlerDeps,
  payload: GithubTabPayload,
  signal: AbortSignal,
): Promise<void> {
  if (!isGithubTab(payload.tab)) return;
  const spec = GITHUB_TABS[payload.tab];
  const repoKey = await deps.store.repoKeyOfNode(payload.nodeId);
  if (repoKey === null) return;
  const cached = await deps.store.readTab(payload.nodeId, payload.tab);
  const fresh =
    cached !== null && deps.now() - Date.parse(cached.fetchedAt) < spec.ttlMs && !payload.force;
  if (fresh) return;
  const body = await deps.createClient(signal).json<unknown>(spec.path(repoKey));
  if (body === null) return;
  await deps.store.writeTab(payload.nodeId, payload.tab, body, new Date(deps.now()).toISOString());
}

async function analyze(
  deps: GithubHandlerDeps,
  payload: GithubAnalyzePayload,
  signal: AbortSignal,
): Promise<void> {
  const inputs = await collectAnalysisInputs(deps.createClient(signal), payload.repoKey, {
    nowMs: deps.now(),
  });
  const analysisId = await deps.store.saveAnalysis(analyzeRepository(inputs));
  // §6.1: the proposal is a separate job so a slow build cannot lose the analysis that produced it.
  await deps.enqueueProposal({ analysisId });
}

async function proposal(deps: GithubHandlerDeps, payload: GithubProposalPayload): Promise<void> {
  const analysis = await deps.store.loadAnalysis(payload.analysisId);
  if (analysis === null) return;
  const built = buildIntegrationProposal(analysis, {
    id: deps.newId(),
    analysisId: payload.analysisId,
    generatedAt: new Date(deps.now()).toISOString(),
  });
  // An ineligible repository (§6.2) is a normal answer, not a failure — nothing to store.
  if (built === null) return;
  await deps.store.saveProposal(built);
}

async function sweep(deps: GithubHandlerDeps, payload: GithubSweepPayload): Promise<void> {
  const now = deps.now();
  for (const row of await deps.store.listRepositoryNodes(payload.boardId)) {
    const age = row.lastFetchedAt === null ? Infinity : now - Date.parse(row.lastFetchedAt);
    if (age < SWEEP_TTL_MS) continue;
    // Dedupe is the job id (`hydrate:{nodeId}:{refKey}`), so re-enqueueing a live job is free.
    await deps.enqueueHydrate({
      nodeId: row.nodeId,
      ref: row.ref,
      boardId: payload.boardId,
      userId: 'system',
    });
  }
}
