/**
 * Investigation result → import proposal (24_UNIFIED_QUERY.md §8, 10_INTEGRATIONS.md §7.2).
 *
 * U7/N4: a run produces a *graph object*, never a write. Landing it on a board goes through the one
 * write path the product has — `ProposalReview` + `applyProposal` — so an answer from crt.sh is
 * reviewed, applied as a single undo step and carries its provenance exactly like an integration
 * import does. This module is the adapter between the two vocabularies and holds no state.
 */

import type { InvestigationResult, Provenance, ResolvedEntity } from '@nexus/query-engine';
import type { ImportProposal, ProposalItem, ProposedNode } from '@nexus/integrations';
import type { EntityKind } from '@nexus/transforms';

export const QUERY_INTEGRATION_ID = 'raven.query';

/**
 * Entity kinds map to the node types the registry actually has; everything else lands as `unknown`,
 * which is a real node type carrying its kind in props rather than a lossy cast to `note`.
 */
const NODE_TYPE_BY_KIND: Partial<Record<EntityKind, string>> = {
  domain: 'website',
  hostname: 'website',
  url: 'link',
  repo: 'repo',
  person: 'person',
  note: 'note',
};

export const nodeTypeFor = (kind: EntityKind): string => NODE_TYPE_BY_KIND[kind] ?? 'unknown';

/** The strongest source is the one worth showing first in the "why is this here" chip. */
const primarySource = (entity: {
  readonly sources: readonly Provenance[];
}): Provenance | undefined => [...entity.sources].sort((a, b) => b.confidence - a.confidence)[0];

const explainEntity = (entity: ResolvedEntity): string => {
  const providers = [...new Set(entity.sources.map((source) => source.provider))];
  const cached = entity.sources.some((source) => source.cached);
  const corroboration =
    providers.length > 1 ? `${String(providers.length)} independent providers` : providers[0];
  return `${entity.kind} · ${corroboration ?? 'no source'}${cached ? ' · cached' : ''} · confidence ${entity.confidence.toFixed(2)}`;
};

export interface ToProposalOptions {
  readonly boardId: string;
  readonly runId: string;
  readonly now?: string;
  readonly actorUserId?: string;
  /** Node the query was launched from, so results attach to it instead of floating. */
  readonly anchorNodeId?: string;
  /** Below this, a result is proposed but starts unselected (§8.3). */
  readonly autoSelectAbove?: number;
}

const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Builds the proposal. Seed entities are skipped: the analyst already has what they typed, and
 * re-adding it is the classic "the tool duplicated my node" complaint.
 */
export function toImportProposal(
  result: InvestigationResult,
  options: ToProposalOptions,
): ImportProposal {
  const now = options.now ?? new Date().toISOString();
  const actorUserId = options.actorUserId ?? 'local';
  const threshold = options.autoSelectAbove ?? 0.5;

  const provenanceOf = (source: Provenance | undefined, confidence: number) => ({
    source: source === undefined ? 'raven.query' : `${source.provider}:${source.engine}`,
    tool: QUERY_INTEGRATION_ID,
    toolVersion: '1',
    runId: options.runId,
    observedAt: source?.observedAt ?? now,
    importedAt: now,
    confidence,
    actorUserId,
    ...(source === undefined ? {} : { pointer: `/${source.transform}` }),
    ...(source === undefined || source.evidence.length === 0
      ? {}
      : { excerpt: source.evidence.join('\n').slice(0, 4096) }),
  });

  const entities = result.entities.filter((entity) => !entity.seed);
  const tempIdByEntity = new Map<string, string>();

  const nodes: ProposedNode[] = entities.map((entity, index) => {
    const tempId = `q-${String(index)}`;
    tempIdByEntity.set(entity.id, tempId);
    return {
      tempId,
      identityKey: `${entity.kind}:${entity.value}`,
      nodeType: nodeTypeFor(entity.kind),
      title: entity.label ?? entity.value,
      props: { ...entity.props, entityKind: entity.kind, value: entity.value },
      tags: [entity.kind],
      provenance: provenanceOf(primarySource(entity), entity.confidence),
      layoutHint: {
        ring: 1,
        index,
        ...(options.anchorNodeId === undefined ? {} : { anchorNodeId: options.anchorNodeId }),
      },
    };
  });

  const nodeItems: ProposalItem[] = nodes.map((node, index) => ({
    id: `node-${node.tempId}`,
    kind: 'new_node',
    selectedByDefault: (entities[index]?.confidence ?? 0) >= threshold,
    confidence: entities[index]?.confidence ?? 0,
    explain: explainEntity(entities[index] as ResolvedEntity),
    node,
  }));

  // An edge is only proposable when both of its endpoints are in the same proposal: a dangling ref
  // would apply into a broken graph, and silently dropping it is better than repairing it wrong.
  const edgeItems: ProposalItem[] = result.relations.flatMap((relation, index) => {
    const from = tempIdByEntity.get(relation.from);
    const to = tempIdByEntity.get(relation.to);
    if (from === undefined || to === undefined) return [];
    return [
      {
        id: `edge-${String(index)}`,
        kind: 'new_edge' as const,
        selectedByDefault: relation.confidence >= threshold,
        confidence: relation.confidence,
        explain: relation.derived
          ? `inferred by ${relation.derivedBy ?? 'the query layer'} · confidence ${relation.confidence.toFixed(2)}`
          : `stated by ${primarySource(relation)?.provider ?? 'a provider'} · confidence ${relation.confidence.toFixed(2)}`,
        edge: {
          tempId: `qe-${String(index)}`,
          fromRef: { kind: 'temp' as const, tempId: from },
          toRef: { kind: 'temp' as const, tempId: to },
          edgeType: relation.kind,
          props: { derived: relation.derived },
          provenance: provenanceOf(primarySource(relation), relation.confidence),
        },
      },
    ];
  });

  const items = [...nodeItems, ...edgeItems];

  return {
    id: `proposal-${options.runId}`,
    runId: options.runId,
    integrationId: QUERY_INTEGRATION_ID,
    boardId: options.boardId,
    createdAt: now,
    summary: {
      newNodes: nodeItems.length,
      newEdges: edgeItems.length,
      enriched: 0,
      conflicts: 0,
      skippedDuplicates: result.entities.length - entities.length,
    },
    items,
    issues: result.summary.warnings.map((message) => ({ level: 'warn' as const, message })),
    expiresAt: new Date(Date.parse(now) + PROPOSAL_TTL_MS).toISOString(),
  };
}
