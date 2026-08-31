/**
 * Adapter-backed engines — the join between Part 2 §37/§38 (adapters) and §11–§14 (the executor).
 *
 * The executor drives `TransformEngine`s; adapters speak `AdapterInput`/`AdapterResult`. Without
 * this bridge the cli/python adapters exist and no plan can ever reach them. It is deliberately
 * thin: one `execute` that calls the adapter once, and a `normalize` that turns items into proposed
 * entities. Everything engine-specific (how to read one item) is injected, so a new CLI engine is a
 * few lines of mapping rather than a new class.
 */

import type { AdapterError, AdapterInput, EngineAdapter } from '../adapters.ts';
import type { EntityKind } from '../types.ts';
import { EngineFailure, type FailureCode } from './run.ts';
import {
  INPUT_REF,
  type EngineMetadata,
  type EngineOutput,
  type InputVerdict,
  type ProposedEntity,
  type RawChunk,
  type TransformEngine,
  type TransformInput,
} from './types.ts';

/** Fields a CLI conventionally puts the answer in, most specific first. */
const VALUE_FIELDS = ['host', 'hostname', 'domain', 'url', 'name', 'value', 'ip'] as const;

export const defaultReadValue = (item: Readonly<Record<string, unknown>>): string | undefined => {
  for (const field of VALUE_FIELDS) {
    const candidate = item[field];
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return undefined;
};

export interface AdapterEngineOptions {
  readonly metadata: EngineMetadata;
  readonly adapter: EngineAdapter;
  /** What the host runs the engine on. Default: the input entity, by kind and value. */
  readonly payload?: (input: TransformInput) => Readonly<Record<string, unknown>>;
  /**
   * Reads one result item. Returning undefined drops the item rather than inventing a value.
   * Not named `valueOf`: that key exists on every object through `Object.prototype`, so `??` would
   * never see it as missing.
   */
  readonly readValue?: (item: Readonly<Record<string, unknown>>) => string | undefined;
  /** Kind of the entities produced. Default: the engine's first declared output. */
  readonly outputKind?: EntityKind;
  readonly relationship?: string;
  readonly confidence?: number;
}

const DEFAULT_CONFIDENCE = 0.6;

/** Adapter failure kinds that the driver has a matching code for; the rest are engine errors. */
const FAILURE_CODE: Record<AdapterError['kind'], FailureCode> = {
  timeout: 'timeout',
  'invalid-input': 'invalid-input',
  unavailable: 'engine-error',
  upstream: 'engine-error',
  internal: 'engine-error',
};

export const createAdapterEngine = (options: AdapterEngineOptions): TransformEngine => {
  const metadata = options.metadata;
  const readValue = options.readValue ?? defaultReadValue;
  const outputKind = options.outputKind ?? metadata.outputs[0];
  if (outputKind === undefined) {
    throw new Error(`${metadata.engine} declares no output kind and none was given`);
  }
  const confidence = options.confidence ?? DEFAULT_CONFIDENCE;

  return {
    metadata: () => metadata,

    validateInput: (input): InputVerdict =>
      metadata.inputs.includes(input.kind) && input.value.trim() !== ''
        ? { ok: true }
        : {
            ok: false,
            reason: `${metadata.engine} does not accept ${input.kind} "${input.value}"`,
          },

    async *execute(input, ctx): AsyncIterable<RawChunk> {
      const adapterInput: AdapterInput = {
        engineId: metadata.engine,
        capability: metadata.capability,
        payload: options.payload?.(input) ?? { kind: input.kind, value: input.value },
        timeoutMs: ctx.deadlineMs,
      };

      const result = await options.adapter.execute(adapterInput, (progress) => {
        ctx.log('debug', progress.message ?? 'running', { fraction: progress.fraction });
      });

      if (!result.ok) {
        throw new EngineFailure(
          FAILURE_CODE[result.error.kind],
          `${result.error.kind}: ${result.error.message}`,
          result.error.retryable,
        );
      }

      yield {
        at: new Date().toISOString(),
        payload: { items: result.output.items, raw: result.output.raw },
        exhaustive: true,
      };
    },

    normalize(chunks, _input): EngineOutput {
      const entities: ProposedEntity[] = [];
      const seen = new Set<string>();

      for (const chunk of chunks) {
        const payload = chunk.payload as { items?: readonly Record<string, unknown>[] };
        for (const item of payload.items ?? []) {
          const value = readValue(item);
          if (value === undefined || seen.has(value)) continue;
          seen.add(value);
          entities.push({
            key: value,
            kind: outputKind,
            value,
            props: item,
            confidence,
          });
        }
      }

      return {
        entities,
        relationships: entities.map((entity) => ({
          from: INPUT_REF,
          to: entity.key,
          kind: options.relationship ?? 'related_to',
          confidence,
        })),
        evidence: entities.map((entity) => ({
          entity: entity.key,
          observedAt: chunks[0]?.at ?? new Date().toISOString(),
          chunk: 0,
          ...(chunks[0]?.url === undefined ? {} : { url: chunks[0].url }),
        })),
      };
    },
  };
};
