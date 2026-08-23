/**
 * The capability registry and the single entry point (14_AI_AGENT.md §1). `runCapability` is the
 * only way to invoke the AI layer, and it can only ever return a *result*: findings to read and,
 * at most, a proposal to accept. It never touches the Y.Doc — that is `applyProposal`'s job, and
 * the user's decision.
 */

import { clusterNodes, findDuplicates, suggestConnections } from './capabilities/deterministic.ts';
import {
  analyzeDocument,
  explainConnection,
  explainRepository,
  generateNote,
  investigationSummary,
  summarizeNode,
} from './capabilities/model.ts';
import { AIUnavailableError } from './provider.ts';
import type { AICapability, AICapabilityId, AIRunContext, AIRunResult } from './types.ts';

export const CAPABILITIES: Readonly<Record<AICapabilityId, AICapability>> = {
  'summarize-node': summarizeNode,
  'explain-connection': explainConnection,
  'find-duplicates': findDuplicates,
  'suggest-connections': suggestConnections,
  'cluster-nodes': clusterNodes,
  'investigation-summary': investigationSummary,
  'generate-note': generateNote,
  'analyze-document': analyzeDocument,
  'explain-repository': explainRepository,
};

/** Capabilities that work with no endpoint configured, for the "AI unavailable" UI state. */
export function availableCapabilities(hasProvider: boolean): readonly AICapability[] {
  return Object.values(CAPABILITIES).filter((c) => hasProvider || !c.needsProvider);
}

export async function runCapability(id: AICapabilityId, ctx: AIRunContext): Promise<AIRunResult> {
  const capability = CAPABILITIES[id];
  if (capability.needsProvider && ctx.provider.modelId === 'none') {
    throw new AIUnavailableError(`${id} needs an AI endpoint; configure one in settings`);
  }
  return capability.run(ctx);
}
