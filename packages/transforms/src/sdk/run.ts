/**
 * The host-side driver of one engine run (L4.2). It owns everything an engine must not be trusted
 * with: the deadline, cancellation, truncation, output validation and cleanup.
 *
 * Lifecycle, per 21_TRANSFORM_SYSTEM.md §9.1:
 *   validateInput → initialize → execute (streamed) → normalize → validate → outcome
 * A cancelled or timed-out run keeps what it already collected (brief §82–83).
 */

import { ENTITY_KINDS, type EntityKind, type ExecutionMode } from '../types.ts';
import {
  INPUT_REF,
  type EngineContext,
  type EngineOutput,
  type Evidence,
  type HostFetch,
  type LogLevel,
  type ProposedEntity,
  type ProposedRelationship,
  type RawChunk,
  type TransformEngine,
  type TransformInput,
} from './types.ts';

export type EngineRunStatus = 'completed' | 'partial' | 'failed' | 'cancelled';

export type FailureCode =
  | 'invalid-input'
  | 'timeout'
  | 'cancelled'
  | 'engine-error'
  | 'contract-violation';

/**
 * Thrown by an engine that already knows how its run failed. The driver files any other thrown
 * error as a retryable `engine-error`; this lets a `timeout` or `invalid-input` keep its code so
 * the retry budget (§30) is not spent on a run that can never succeed.
 */
export class EngineFailure extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'EngineFailure';
  }
}

export interface RunFailure {
  readonly code: FailureCode;
  readonly message: string;
  /** Whether running the same engine again could plausibly succeed. */
  readonly retryable: boolean;
}

export interface RunOptions {
  readonly input: TransformInput;
  readonly mode: ExecutionMode;
  /** From the transform manifest: `limits.maxResults` and `limits.expectedRuntimeMs` × slack. */
  readonly maxResults: number;
  readonly deadlineMs: number;
  readonly fetch: HostFetch;
  readonly credential?: (key: string) => string | undefined;
  readonly log?: (
    level: LogLevel,
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ) => void;
  /** External cancellation (the user pressed Stop). */
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

export interface RunOutcome {
  readonly status: EngineRunStatus;
  readonly entities: readonly ProposedEntity[];
  readonly relationships: readonly ProposedRelationship[];
  readonly evidence: readonly Evidence[];
  /** Raw provider output, verbatim, for provenance and replay. */
  readonly chunks: readonly RawChunk[];
  /** False when the engine said it may not have seen everything — lets the router try a fallback. */
  readonly exhaustive: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly failure?: RunFailure;
  /** Contract violations found in the engine's own output. Non-empty means the run failed. */
  readonly violations: readonly string[];
}

const KINDS = new Set<string>(ENTITY_KINDS);
const inRange = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 1;

/** Checks the engine's output against the SDK contract. Empty result means the output is usable. */
export const validateOutput = (
  output: EngineOutput,
  usedNetwork: boolean,
  declaredNetwork: boolean,
): readonly string[] => {
  const violations: string[] = [];
  const keys = new Set<string>();

  for (const entity of output.entities) {
    if (!entity.key) violations.push('entity with an empty key');
    else if (keys.has(entity.key)) violations.push(`duplicate entity key: ${entity.key}`);
    keys.add(entity.key);
    if (!entity.value) violations.push(`entity ${entity.key} has an empty value`);
    if (!KINDS.has(entity.kind)) violations.push(`entity ${entity.key} has unknown kind`);
    if (!inRange(entity.confidence)) violations.push(`entity ${entity.key} confidence out of 0..1`);
  }

  const known = (ref: string): boolean => ref === INPUT_REF || keys.has(ref);
  for (const rel of output.relationships) {
    if (!known(rel.from) || !known(rel.to)) {
      violations.push(`relationship ${rel.from}→${rel.to} references an unknown entity`);
    }
    if (!rel.kind) violations.push(`relationship ${rel.from}→${rel.to} has no kind`);
    if (!inRange(rel.confidence))
      violations.push(`relationship ${rel.from}→${rel.to} confidence out of 0..1`);
  }

  for (const item of output.evidence) {
    if (!known(item.entity))
      violations.push(`evidence references an unknown entity: ${item.entity}`);
  }
  const supported = new Set(output.evidence.map((item) => item.entity));
  for (const key of keys) {
    if (!supported.has(key)) violations.push(`entity ${key} has no evidence`);
  }

  if (usedNetwork && !declaredNetwork) {
    violations.push('engine used the network without declaring the `network` permission');
  }
  return violations;
};

const abortPromise = (signal: AbortSignal): Promise<'aborted'> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve('aborted');
    else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });

const EMPTY: EngineOutput = { entities: [], relationships: [], evidence: [] };

const truncate = (output: EngineOutput, maxResults: number): EngineOutput => {
  if (output.entities.length <= maxResults) return output;
  const entities = output.entities.slice(0, maxResults);
  const kept = new Set(entities.map((entity) => entity.key));
  const alive = (ref: string): boolean => ref === INPUT_REF || kept.has(ref);
  return {
    entities,
    relationships: output.relationships.filter((rel) => alive(rel.from) && alive(rel.to)),
    evidence: output.evidence.filter((item) => alive(item.entity)),
  };
};

/** Runs one engine over one input. Never throws: every failure comes back as an outcome. */
export const runEngine = async (
  engine: TransformEngine,
  options: RunOptions,
): Promise<RunOutcome> => {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const chunks: RawChunk[] = [];
  let exhaustive = true;
  let usedNetwork = false;
  let failure: RunFailure | undefined;
  let timedOut = false;

  const finish = (
    status: EngineRunStatus,
    output: EngineOutput,
    violations: readonly string[],
  ): RunOutcome => {
    const capped = truncate(output, options.maxResults);
    return {
      status,
      entities: capped.entities,
      relationships: capped.relationships,
      evidence: capped.evidence,
      chunks,
      exhaustive,
      truncated: capped.entities.length < output.entities.length,
      durationMs: now() - startedAt,
      ...(failure ? { failure } : {}),
      violations,
    };
  };

  const verdict = engine.validateInput(options.input);
  if (!verdict.ok) {
    failure = {
      code: 'invalid-input',
      message: verdict.reason ?? 'the engine rejected the input',
      retryable: false,
    };
    return finish('failed', EMPTY, []);
  }
  const input: TransformInput = verdict.normalizedValue
    ? { ...options.input, value: verdict.normalizedValue }
    : options.input;

  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  if (options.signal?.aborted === true) controller.abort();
  else options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.deadlineMs);

  const ctx: EngineContext = {
    mode: options.mode,
    signal: controller.signal,
    deadlineMs: options.deadlineMs,
    maxResults: options.maxResults,
    credential: options.credential ?? (() => undefined),
    fetch: async (url, init) => {
      usedNetwork = true;
      return options.fetch(url, init);
    },
    log: options.log ?? (() => undefined),
  };

  let iterator: AsyncIterator<RawChunk> | undefined;
  try {
    await engine.initialize?.(ctx);
    iterator = engine.execute(input, ctx)[Symbol.asyncIterator]();
    const aborted = abortPromise(controller.signal);
    for (;;) {
      const step = await Promise.race([iterator.next(), aborted]);
      if (step === 'aborted') break;
      if (step.done === true) break;
      chunks.push(step.value);
      if (step.value.exhaustive === false) exhaustive = false;
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      failure =
        error instanceof EngineFailure
          ? { code: error.code, message: error.message, retryable: error.retryable }
          : {
              code: 'engine-error',
              message: error instanceof Error ? error.message : String(error),
              retryable: true,
            };
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    // Not awaited on purpose: a generator suspended inside a long `await` only resumes when that
    // await settles, so awaiting `return()` would re-introduce the timeout we just enforced.
    void iterator?.return?.().catch(() => undefined);
    await Promise.resolve(engine.cleanup?.()).catch(() => undefined);
  }

  if (controller.signal.aborted) {
    failure = timedOut
      ? { code: 'timeout', message: `execute exceeded ${options.deadlineMs} ms`, retryable: true }
      : { code: 'cancelled', message: 'cancelled by the user', retryable: true };
    exhaustive = false;
  }

  let output: EngineOutput;
  try {
    output = engine.normalize(chunks, input);
  } catch (error) {
    failure = {
      code: 'contract-violation',
      message: `normalize threw: ${error instanceof Error ? error.message : String(error)}`,
      retryable: false,
    };
    return finish('failed', EMPTY, ['normalize threw']);
  }

  const declaredNetwork = engine.metadata().permissions.includes('network');
  const violations = validateOutput(output, usedNetwork, declaredNetwork);
  if (violations.length > 0) {
    failure ??= {
      code: 'contract-violation',
      message: violations[0] ?? 'invalid output',
      retryable: false,
    };
    // A violating engine's output never reaches the graph, even partially.
    return finish('failed', EMPTY, violations);
  }

  if (failure?.code === 'cancelled') return finish('cancelled', output, violations);
  if (failure) return finish(chunks.length > 0 ? 'partial' : 'failed', output, violations);
  return finish('completed', output, violations);
};

/** The output kinds an engine actually produced — used to chain the next transform layer. */
export const producedKinds = (outcome: RunOutcome): readonly EntityKind[] => [
  ...new Set(outcome.entities.map((entity) => entity.kind)),
];
