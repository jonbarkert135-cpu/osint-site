/** The streaming vocabulary of a run (24_UNIFIED_QUERY.md §6.2). */

import type {
  EngineId,
  ExclusionReason,
  RunRecord,
  RunStatus,
  TransformId,
} from '@nexus/transforms';

import type { Provenance, ResolvedEntity, ResolvedRelation } from './resolve.ts';

export interface StepRef {
  readonly transform: TransformId;
  /** Stage index; steps inside a stage run concurrently. */
  readonly stage: number;
  readonly input: { readonly kind: string; readonly value: string };
}

export type QueryEvent =
  | { readonly type: 'plan.started'; readonly stages: number; readonly steps: number }
  | { readonly type: 'stage.started'; readonly stage: number; readonly steps: number }
  | { readonly type: 'step.started'; readonly step: StepRef; readonly engine: EngineId }
  | { readonly type: 'step.skipped'; readonly step: StepRef; readonly reason: ExclusionReason }
  | { readonly type: 'entity.found'; readonly step: StepRef; readonly entity: ResolvedEntity }
  | { readonly type: 'relation.found'; readonly step: StepRef; readonly relation: ResolvedRelation }
  | {
      readonly type: 'step.done';
      readonly step: StepRef;
      readonly engine: EngineId;
      readonly status: RunStatus;
      readonly produced: number;
      readonly cached: boolean;
      readonly run: RunRecord;
    }
  | {
      readonly type: 'step.failed';
      readonly step: StepRef;
      readonly engine: EngineId;
      readonly message: string;
      /** True when a fallback engine is about to be tried for the same step. */
      readonly fallback: boolean;
    }
  | { readonly type: 'plan.done'; readonly result: RunSummary };

/** How the run ended (§6.4): `partial` keeps everything already produced. */
export type RunOutcomeStatus = 'completed' | 'degraded' | 'partial' | 'cancelled' | 'failed';

export interface RunSummary {
  readonly status: RunOutcomeStatus;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly stepsPlanned: number;
  readonly stepsCompleted: number;
  readonly stepsFailed: number;
  readonly stepsSkipped: number;
  readonly cacheHits: number;
  readonly entities: number;
  readonly relations: number;
  /** Reasons the plan could not run in full, for the run report. */
  readonly warnings: readonly string[];
}

export interface InvestigationResult {
  readonly summary: RunSummary;
  readonly entities: readonly ResolvedEntity[];
  readonly relations: readonly ResolvedRelation[];
  readonly runs: readonly RunRecord[];
  /** Every observation made, in arrival order — the audit trail behind the graph. */
  readonly provenance: readonly Provenance[];
}
