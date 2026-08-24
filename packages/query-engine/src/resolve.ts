/**
 * Deduplication, corroboration and provenance (24_UNIFIED_QUERY.md §7.2–§7.5).
 *
 * The builder is an accumulator, not a store: it takes what engines proposed and returns one
 * investigation graph in which every node knows which run, engine, provider and input produced it
 * (U6). Nothing here writes to a board — the layer proposes and the analyst commits (U7).
 */

import type { EngineId, EntityKind, ProviderId, TransformId } from '@nexus/transforms';
import type { Evidence, ProposedEntity, ProposedRelationship, RawChunk } from '@nexus/transforms';
import { INPUT_REF } from '@nexus/transforms';

import { canonicalValue, identityKey } from './normalize.ts';

/**
 * One piece of evidence, kept next to the raw thing it came from (Part 2 §18, §19). The normalized
 * view must always be one click away from what the provider actually said, or the analyst is
 * trusting a summary they cannot check.
 */
export interface EvidenceRef {
  readonly excerpt?: string;
  /** Original provider URL — "Open source". */
  readonly url?: string;
  /** Raw provider payload, verbatim — "View raw result". */
  readonly raw?: unknown;
  readonly observedAt: string;
}

/** Where one observation came from. Credentials never appear here (§9). */
export interface Provenance {
  readonly runId: string;
  readonly transform: TransformId;
  readonly engine: EngineId;
  readonly provider: ProviderId;
  readonly input: { readonly kind: EntityKind; readonly value: string };
  readonly observedAt: string;
  /** True when the answer came from the result cache; a cached answer never poses as a live one. */
  readonly cached: boolean;
  /** Confidence as stated by this source alone, before corroboration. */
  readonly confidence: number;
  readonly evidence: readonly string[];
  /** Same evidence, with its source URL and raw payload attached (§18, §19). */
  readonly refs?: readonly EvidenceRef[];
}

export interface ResolvedEntity {
  /** Identity key when the kind has one, else a run-scoped synthetic id. */
  readonly id: string;
  readonly kind: EntityKind;
  readonly value: string;
  readonly label?: string;
  readonly props: Readonly<Record<string, unknown>>;
  /** Corroborated confidence, 0..1 (§7.4). */
  readonly confidence: number;
  readonly sources: readonly Provenance[];
  /** True for the entity the query started from. */
  readonly seed: boolean;
}

export interface ResolvedRelation {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly confidence: number;
  /** True when the layer inferred the edge rather than an engine stating it (§7.5). */
  readonly derived: boolean;
  readonly derivedBy?: string;
  readonly sources: readonly Provenance[];
}

/**
 * Noisy-OR over *independent* providers, capped at 0.99 (§7.4). Two observations from the same
 * provider are one observation repeated: the strongest wins, it does not corroborate itself.
 */
export const corroborate = (sources: readonly Provenance[]): number => {
  const strongest = new Map<ProviderId, number>();
  for (const source of sources) {
    const previous = strongest.get(source.provider) ?? 0;
    if (source.confidence > previous) strongest.set(source.provider, source.confidence);
  }
  const combined = [...strongest.values()].reduce((acc, value) => acc * (1 - value), 1);
  return Math.min(0.99, Number((1 - combined).toFixed(4)));
};

export interface EngineResult {
  readonly entities: readonly ProposedEntity[];
  readonly relationships: readonly ProposedRelationship[];
  readonly evidence: readonly Evidence[];
  /** Raw provider output of the same run, so evidence can point back at it (§19). */
  readonly chunks?: readonly RawChunk[];
}

export interface GraphBuilder {
  /** Registers the entity the query started from; returns its id. */
  seed(kind: EntityKind, value: string, provenance: Provenance): string;
  /**
   * Folds one engine result into the graph. `inputId` is the entity the run was launched from, so
   * `$input` relationships resolve to a real node. Returns the entities that are new to the graph,
   * in arrival order, for streaming.
   */
  absorb(inputId: string, result: EngineResult, provenance: Provenance): readonly ResolvedEntity[];
  readonly entities: readonly ResolvedEntity[];
  readonly relations: readonly ResolvedRelation[];
  /** Entities of a given kind, best first — how the next stage picks its inputs. */
  byKind(kind: EntityKind): readonly ResolvedEntity[];
  entity(id: string): ResolvedEntity | undefined;
}

interface MutableEntity {
  id: string;
  kind: EntityKind;
  value: string;
  label?: string;
  props: Record<string, unknown>;
  sources: Provenance[];
  seed: boolean;
}

const freeze = (entity: MutableEntity): ResolvedEntity => ({
  id: entity.id,
  kind: entity.kind,
  value: entity.value,
  ...(entity.label !== undefined ? { label: entity.label } : {}),
  props: entity.props,
  confidence: corroborate(entity.sources),
  sources: entity.sources,
  seed: entity.seed,
});

const relationId = (from: string, kind: string, to: string): string => `${from}|${kind}|${to}`;

export const createGraphBuilder = (): GraphBuilder => {
  const entities = new Map<string, MutableEntity>();
  const relations = new Map<
    string,
    { readonly base: Omit<ResolvedRelation, 'confidence' | 'sources'>; sources: Provenance[] }
  >();
  let synthetic = 0;

  const idFor = (kind: EntityKind, value: string): string =>
    identityKey(kind, value) ?? `${kind}:#${++synthetic}`;

  const upsert = (
    kind: EntityKind,
    rawValue: string,
    provenance: Provenance,
    extra: {
      readonly label?: string;
      readonly props?: Readonly<Record<string, unknown>>;
      readonly seed?: boolean;
    },
  ): { readonly id: string; readonly created: boolean } => {
    const value = canonicalValue(kind, rawValue);
    const id = idFor(kind, value);
    const existing = entities.get(id);
    if (existing) {
      existing.sources.push(provenance);
      if (existing.label === undefined && extra.label !== undefined) existing.label = extra.label;
      // Later observations fill gaps; they never overwrite what an earlier source established.
      for (const [key, item] of Object.entries(extra.props ?? {})) {
        if (!(key in existing.props)) existing.props[key] = item;
      }
      return { id, created: false };
    }
    entities.set(id, {
      id,
      kind,
      value,
      ...(extra.label !== undefined ? { label: extra.label } : {}),
      props: { ...(extra.props ?? {}) },
      sources: [provenance],
      seed: extra.seed === true,
    });
    return { id, created: true };
  };

  const link = (
    from: string,
    to: string,
    kind: string,
    provenance: Provenance,
    confidence: number,
  ): void => {
    const id = relationId(from, kind, to);
    const existing = relations.get(id);
    if (existing) {
      existing.sources.push({ ...provenance, confidence });
      return;
    }
    relations.set(id, {
      base: { id, from, to, kind, derived: false },
      sources: [{ ...provenance, confidence }],
    });
  };

  return {
    seed: (kind, value, provenance) => upsert(kind, value, provenance, { seed: true }).id,

    absorb: (inputId, result, provenance) => {
      const created: ResolvedEntity[] = [];
      const evidenceFor = new Map<string, string[]>();
      const refsFor = new Map<string, EvidenceRef[]>();
      for (const item of result.evidence) {
        const bucket = evidenceFor.get(item.entity) ?? [];
        bucket.push(item.excerpt ?? `${item.observedAt}#${String(item.chunk ?? 0)}`);
        evidenceFor.set(item.entity, bucket);

        const chunk = item.chunk === undefined ? undefined : result.chunks?.[item.chunk];
        const url = item.url ?? chunk?.url;
        const refs = refsFor.get(item.entity) ?? [];
        refs.push({
          ...(item.excerpt !== undefined ? { excerpt: item.excerpt } : {}),
          ...(url !== undefined ? { url } : {}),
          ...(chunk !== undefined ? { raw: chunk.payload } : {}),
          observedAt: item.observedAt,
        });
        refsFor.set(item.entity, refs);
      }

      const idByKey = new Map<string, string>([[INPUT_REF, inputId]]);
      for (const proposed of result.entities) {
        const source: Provenance = {
          ...provenance,
          confidence: proposed.confidence,
          evidence: evidenceFor.get(proposed.key) ?? [],
          refs: refsFor.get(proposed.key) ?? [],
        };
        const { id, created: isNew } = upsert(proposed.kind, proposed.value, source, {
          ...(proposed.label !== undefined ? { label: proposed.label } : {}),
          ...(proposed.props !== undefined ? { props: proposed.props } : {}),
        });
        idByKey.set(proposed.key, id);
        const entity = entities.get(id);
        if (isNew && entity) created.push(freeze(entity));
      }

      for (const relationship of result.relationships) {
        const from = idByKey.get(relationship.from);
        const to = idByKey.get(relationship.to);
        // A relationship to an entity the engine did not produce is dropped, not invented.
        if (from === undefined || to === undefined || from === to) continue;
        link(from, to, relationship.kind, provenance, relationship.confidence);
      }
      return created;
    },

    get entities() {
      return [...entities.values()].map(freeze);
    },
    get relations() {
      return [...relations.values()].map(({ base, sources }) => ({
        ...base,
        confidence: corroborate(sources),
        sources,
      }));
    },
    byKind: (kind) =>
      [...entities.values()]
        .filter((entity) => entity.kind === kind)
        .map(freeze)
        .sort((a, b) => b.confidence - a.confidence),
    entity: (id) => {
      const found = entities.get(id);
      return found ? freeze(found) : undefined;
    },
  };
};
