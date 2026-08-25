/**
 * The run dashboard, assembled from what the run actually produced (Part 2 §20, §21).
 *
 * The dashboard is not a fixed screen: the counters, the service panels and the recommendations
 * exist only if the run produced something to put in them. A service that returned nothing gets a
 * panel saying so rather than being hidden — an empty answer from Sherlock *is* a finding.
 *
 * Pure module: it takes an `InvestigationResult` and returns view data. No React, no state.
 */

import type { EvidenceRef, InvestigationResult, ResolvedEntity } from '@nexus/query-engine';

export interface Counter {
  readonly label: string;
  readonly value: string;
}

export interface ServicePanel {
  /** Provider id — the service the analyst recognises ("crt.sh", "dns.google"). */
  readonly provider: string;
  /** `complete`, `failed` or `empty`: what the panel header says under the name. */
  readonly state: 'complete' | 'failed' | 'empty';
  readonly entities: readonly ResolvedEntity[];
}

export interface TimelineItem {
  readonly at: string;
  readonly label: string;
  readonly provider: string;
}

export interface EvidenceItem {
  readonly entityId: string;
  readonly entity: string;
  readonly provider: string;
  readonly ref: EvidenceRef;
}

export interface Dashboard {
  readonly counters: readonly Counter[];
  readonly services: readonly ServicePanel[];
  readonly timeline: readonly TimelineItem[];
  readonly evidence: readonly EvidenceItem[];
  readonly recommendations: readonly string[];
}

const plural = (count: number, one: string, many: string): string =>
  `${String(count)} ${count === 1 ? one : many}`;

/** Entity kinds, biggest group first — the "12 Entities / 23 Websites / 4 Repositories" block. */
const kindCounters = (entities: readonly ResolvedEntity[]): Counter[] =>
  [
    ...entities.reduce<Map<string, number>>((acc, entity) => {
      acc.set(entity.kind, (acc.get(entity.kind) ?? 0) + 1);
      return acc;
    }, new Map()),
  ]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, count]) => ({ label: kind, value: String(count) }));

const refsOf = (entity: ResolvedEntity): readonly EvidenceRef[] =>
  entity.sources.flatMap((source) => source.refs ?? []);

/** First source URL and first raw payload attached to an entity — what a card links out to (§19). */
export const sourceOf = (entity: ResolvedEntity): { url?: string; raw?: unknown } => {
  const refs = refsOf(entity);
  const url = refs.find((ref) => ref.url !== undefined)?.url;
  const raw = refs.find((ref) => ref.raw !== undefined)?.raw;
  return { ...(url === undefined ? {} : { url }), ...(raw === undefined ? {} : { raw }) };
};

export function buildDashboard(result: InvestigationResult): Dashboard {
  const found = result.entities.filter((entity) => !entity.seed);
  const providers = [...new Set(result.provenance.map((source) => source.provider))].sort();
  const failed = new Set(
    result.runs.filter((run) => run.status === 'failed').map((run) => run.provider),
  );
  const done = result.summary.stepsCompleted;
  const planned = result.summary.stepsPlanned;

  const services: ServicePanel[] = providers.map((provider) => {
    const entities = found.filter((entity) =>
      entity.sources.some((source) => source.provider === provider),
    );
    const state: ServicePanel['state'] = failed.has(provider)
      ? 'failed'
      : entities.length === 0
        ? 'empty'
        : 'complete';
    return { provider, state, entities };
  });

  const timeline: TimelineItem[] = result.provenance
    .map((source) => ({
      at: source.observedAt,
      provider: source.provider,
      label: `${source.transform} · ${source.input.value}${source.cached ? ' · cached' : ''}`,
    }))
    .sort((a, b) => a.at.localeCompare(b.at));

  const evidence: EvidenceItem[] = found.flatMap((entity) =>
    entity.sources.flatMap((source) =>
      (source.refs ?? []).map((ref) => ({
        entityId: entity.id,
        entity: entity.label ?? entity.value,
        provider: source.provider,
        ref,
      })),
    ),
  );

  const weak = found.filter((entity) => entity.confidence < 0.5).length;
  const unsourced = found.filter((entity) => sourceOf(entity).url === undefined).length;
  const recommendations = [
    result.duplicates.length > 0
      ? `Review ${plural(result.duplicates.length, 'possible duplicate', 'possible duplicates')} before building the graph.`
      : null,
    result.summary.stepsFailed > 0
      ? `${plural(result.summary.stepsFailed, 'service', 'services')} failed — the picture is partial; re-run them before concluding.`
      : null,
    weak > 0
      ? `${plural(weak, 'finding is', 'findings are')} below 0.5 confidence — corroborate with a second provider.`
      : null,
    unsourced > 0
      ? `${plural(unsourced, 'finding has', 'findings have')} no source URL — treat as a lead, not as evidence.`
      : null,
    found.length > 0 && result.relations.length === 0
      ? 'Nothing connects these findings yet — add relationships on the canvas after Build Graph.'
      : null,
  ].filter((line): line is string => line !== null);

  return {
    counters: [
      { label: 'Entities', value: String(found.length) },
      ...kindCounters(found),
      { label: 'Relationships', value: String(result.relations.length) },
      { label: 'Sources', value: String(result.provenance.length) },
      { label: 'Service results', value: `${String(done)}/${String(planned)} complete` },
    ],
    services,
    timeline,
    evidence,
    recommendations,
  };
}
