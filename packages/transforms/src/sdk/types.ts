/**
 * Transform SDK — the contract a third-party engine implements (L4.2, brief §77–81).
 *
 * Three deliberate narrowings of the brief's sketch:
 *  - `execute` is *always* a stream (`AsyncIterable<RawChunk>`). One code path instead of
 *    `execute` + `streamResults`, so a non-streaming engine cannot behave differently.
 *  - `buildRelationships` is folded into `normalize`: relationships are derived from the same raw
 *    chunks as the entities, and two passes over the same data drift apart.
 *  - `normalize` is synchronous and pure. No I/O after `execute` means the host can re-run it on
 *    cached raw chunks (L4.3 replay) and get the same graph.
 */

import type {
  CapabilityId,
  EngineId,
  EntityKind,
  ExecutionMode,
  Permission,
  ProviderId,
} from '../types.ts';

/** The selector one run operates on. `value` is already normalized by the host. */
export interface TransformInput {
  readonly kind: EntityKind;
  readonly value: string;
  /** Canvas node the selector came from, when it has one. Relationships may target it via `$input`. */
  readonly entityId?: string;
  readonly props?: Readonly<Record<string, unknown>>;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Host-proxied fetch. Engines never get ambient network access (17_PLUGIN_SDK.md §4.7). */
export type HostFetch = (
  url: string,
  init?: { readonly method?: string; readonly headers?: Readonly<Record<string, string>> },
) => Promise<{ readonly status: number; readonly body: unknown }>;

export interface EngineContext {
  readonly mode: ExecutionMode;
  /** Aborted on cancellation and on deadline. Engines must stop iterating when it fires. */
  readonly signal: AbortSignal;
  /** Wall-clock budget for `execute`. The driver enforces it too; this lets the engine be polite. */
  readonly deadlineMs: number;
  /** Hard cap from the transform manifest. Yielding more is not an error; the driver truncates. */
  readonly maxResults: number;
  /** Vault-injected secret, by manifest key. Never logged, never part of a cache key (§12.3). */
  readonly credential: (key: string) => string | undefined;
  readonly fetch: HostFetch;
  readonly log: (
    level: LogLevel,
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ) => void;
}

/** One slice of raw provider output, kept verbatim for provenance and replay. */
export interface RawChunk {
  /** ISO timestamp of the observation. */
  readonly at: string;
  /** Where this chunk came from, so the analyst can open the source itself (Part 2 §19). */
  readonly url?: string;
  readonly payload: unknown;
  /**
   * `false` means "the provider may hold more than this" — the router is then allowed to try a
   * fallback engine on an empty result (21_TRANSFORM_SYSTEM.md §5).
   */
  readonly exhaustive?: boolean;
}

/** An entity the engine proposes. Never written to the graph directly (N4). */
export interface ProposedEntity {
  /** Engine-local identity key, stable across runs. Used for dedup and as a relationship endpoint. */
  readonly key: string;
  readonly kind: EntityKind;
  readonly value: string;
  readonly label?: string;
  readonly props?: Readonly<Record<string, unknown>>;
  /** 0..1. Independent corroboration raises it later; the engine states what it saw. */
  readonly confidence: number;
}

/** The input entity, as a relationship endpoint. */
export const INPUT_REF = '$input';

export interface ProposedRelationship {
  /** An entity `key`, or `INPUT_REF`. */
  readonly from: string;
  readonly to: string;
  /** Edge type from `07_EDGE_SYSTEM.md`; unknown types are mapped to `related_to` by the host. */
  readonly kind: string;
  readonly confidence: number;
}

/** Why an entity is believed: the excerpt and the raw pointer behind it (§9.4). */
export interface Evidence {
  /** Entity `key` this supports. */
  readonly entity: string;
  readonly observedAt: string;
  readonly excerpt?: string;
  /** Index into the raw chunk list of the run. */
  readonly chunk?: number;
  /** Original provider URL behind this evidence; falls back to the chunk's url (Part 2 §19). */
  readonly url?: string;
}

export interface EngineOutput {
  readonly entities: readonly ProposedEntity[];
  readonly relationships: readonly ProposedRelationship[];
  readonly evidence: readonly Evidence[];
}

export interface EngineHealth {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly latencyMs?: number;
  readonly detail?: string;
}

/** Self-description. Checked against the shipped `EngineManifest` by the conformance harness. */
export interface EngineMetadata {
  readonly engine: EngineId;
  readonly version: string;
  readonly capability: CapabilityId;
  readonly provider: ProviderId;
  readonly permissions: readonly Permission[];
  readonly inputs: readonly EntityKind[];
  readonly outputs: readonly EntityKind[];
}

export interface InputVerdict {
  readonly ok: boolean;
  /** Shown to the analyst when `ok` is false. Required then. */
  readonly reason?: string;
  /** Engine-preferred form of the selector, e.g. a punycode domain. */
  readonly normalizedValue?: string;
}

/** What a third party implements. Only `metadata`, `validateInput`, `execute` and `normalize` are required. */
export interface TransformEngine {
  metadata(): EngineMetadata;
  /** One-time setup (compile a regex, warm a local index). Failure fails the run before any I/O. */
  initialize?(ctx: EngineContext): Promise<void> | void;
  /** Pure and cheap: no I/O. Called before `initialize` costs anything. */
  validateInput(input: TransformInput): InputVerdict;
  execute(input: TransformInput, ctx: EngineContext): AsyncIterable<RawChunk>;
  /** Pure: same chunks in, same graph out. */
  normalize(chunks: readonly RawChunk[], input: TransformInput): EngineOutput;
  healthCheck?(ctx: EngineContext): Promise<EngineHealth>;
  /** Always called, including after a failure or a cancellation. */
  cleanup?(): Promise<void> | void;
}
