/**
 * Fact vs inference, and how sure we are (Part 2 §25, §26).
 *
 * Everything in a run is one of three things, and the analyst must never have to guess which:
 * something a provider *said* (observed), something this layer worked out by putting several
 * observations together (derived), or something a model *suggested* (AI inference). A hypothesis
 * that looks like a fact is worse than no answer at all, so the classification lives here — one
 * pure function, one vocabulary — and the UI only paints what it returns.
 *
 * Confidence is reported next to the two things that justify it: how many independent providers
 * carried it, and how much evidence is attached. A number alone is not an argument.
 */

import type { Provenance, ResolvedEntity, ResolvedRelation } from './resolve.ts';

export type Assurance = 'observed' | 'derived' | 'inference';
export type ConfidenceBand = 'high' | 'medium' | 'low';

export const ASSURANCE_LABEL: Readonly<Record<Assurance, string>> = {
  observed: 'Observed',
  derived: 'Derived',
  inference: 'AI inference',
};

export const CONFIDENCE_LABEL: Readonly<Record<ConfidenceBand, string>> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

export interface Assessment {
  readonly assurance: Assurance;
  readonly confidence: number;
  readonly band: ConfidenceBand;
  /** Independent providers behind it — repetition by one provider is not corroboration (§7.4). */
  readonly sourceCount: number;
  /** Attached excerpts, source URLs or raw payloads the analyst can open. */
  readonly evidenceCount: number;
  /** One sentence the UI can show verbatim: why this is what it says it is. */
  readonly why: string;
}

/** Engines whose output is a suggestion, not an observation. */
const INFERENCE_ENGINES = ['ai', 'llm', 'infer'];

const isInference = (engine: string): boolean =>
  INFERENCE_ENGINES.some((prefix) => engine === prefix || engine.startsWith(`${prefix}-`));

export const confidenceBand = (confidence: number): ConfidenceBand =>
  confidence >= 0.75 ? 'high' : confidence >= 0.45 ? 'medium' : 'low';

const providersOf = (sources: readonly Provenance[]): readonly string[] => [
  ...new Set(sources.map((source) => source.provider)),
];

const evidenceCountOf = (sources: readonly Provenance[]): number =>
  sources.reduce((total, source) => total + (source.refs ?? []).length, 0);

const assess = (
  sources: readonly Provenance[],
  confidence: number,
  derived: boolean,
  what: string,
): Assessment => {
  const providers = providersOf(sources);
  const evidenceCount = evidenceCountOf(sources);
  const modelled = sources.length > 0 && sources.every((source) => isInference(source.engine));
  const assurance: Assurance = modelled
    ? 'inference'
    : derived || evidenceCount === 0
      ? 'derived'
      : 'observed';
  const list = providers.join(', ');
  const why = modelled
    ? `Suggested by ${list || 'a model'} — a hypothesis, not an observation. Corroborate before using it.`
    : assurance === 'observed'
      ? `Stated directly by ${list}, with ${String(evidenceCount)} piece(s) of evidence attached.`
      : `${what} from ${String(providers.length)} source(s) (${list}) — no provider stated it outright.`;
  return {
    assurance,
    confidence,
    band: confidenceBand(confidence),
    sourceCount: providers.length,
    evidenceCount,
    why,
  };
};

export const assessEntity = (entity: ResolvedEntity): Assessment =>
  assess(entity.sources, entity.confidence, false, 'Worked out');

export const assessRelation = (relation: ResolvedRelation): Assessment =>
  assess(relation.sources, relation.confidence, relation.derived, 'Inferred by the resolver');
