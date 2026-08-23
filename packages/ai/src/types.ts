import type { BoardEdge, BoardNode } from '@nexus/domain';
import type { ImportProposal } from '@nexus/integrations/pipeline';

import type { AIProvider } from './provider.ts';

export const AI_CAPABILITIES = [
  'summarize-node',
  'explain-connection',
  'find-duplicates',
  'suggest-connections',
  'cluster-nodes',
  'investigation-summary',
  'generate-note',
  'analyze-document',
  'explain-repository',
] as const;

export type AICapabilityId = (typeof AI_CAPABILITIES)[number];

export interface AIGraph {
  readonly nodes: readonly BoardNode[];
  readonly edges: readonly BoardEdge[];
}

export interface AIRunContext {
  readonly boardId: string;
  readonly runId: string;
  readonly now: string;
  readonly actorUserId: string;
  readonly graph: AIGraph;
  readonly provider: AIProvider;
  /** Caller-supplied ids keep the run pure and let the client pre-compute the ghost preview. */
  readonly newId: () => string;
  /** Capability target: selected nodes, or the edge being explained. */
  readonly nodeIds?: readonly string[];
  readonly edgeId?: string;
}

/** A read-only observation shown in the preview panel. Findings never touch the graph. */
export interface AIFinding {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly nodeIds: readonly string[];
}

export interface AIRunResult {
  readonly runId: string;
  readonly capability: AICapabilityId;
  readonly model: string;
  /** Why the capability produced this — always populated (explainable). */
  readonly explanation: string;
  readonly findings: readonly AIFinding[];
  /** Present only when the run wants to write; the user still has to accept it (N4). */
  readonly proposal?: ImportProposal;
}

export interface AICapability {
  readonly id: AICapabilityId;
  /** False for the deterministic capabilities, which work with no endpoint configured. */
  readonly needsProvider: boolean;
  readonly description: string;
  run(ctx: AIRunContext): Promise<AIRunResult>;
}

export function nodeText(node: BoardNode): string {
  const data = node.data;
  const parts = [node.title];
  for (const key of ['text', 'summary', 'description', 'url']) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0) parts.push(value);
  }
  return parts.join('\n').slice(0, 4000);
}
