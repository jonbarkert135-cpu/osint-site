/**
 * Engine adapter abstraction — Part 2 §37, §38.
 *
 * The core knows five things about an engine: input, execution, progress, output, error.
 * It never learns that something is Python, Docker or a CLI: that is the adapter's private
 * business. This is the same boundary as invariant R1 (core stays tool-agnostic).
 */

import type { EngineManifest, EngineRuntime } from './types.ts';
import { ADAPTER_SUPPORT, resolveRuntime } from './runtime.ts';

export interface AdapterInput {
  readonly engineId: string;
  readonly capability: string;
  /** Opaque to the core: each adapter interprets its own payload. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
}

export interface AdapterProgress {
  /** 0..1, or null when the adapter genuinely cannot tell. Never a fake percentage. */
  readonly fraction: number | null;
  readonly message?: string;
}

export interface AdapterOutput {
  readonly items: readonly Readonly<Record<string, unknown>>[];
  readonly raw?: string;
}

export interface AdapterError {
  readonly kind: 'timeout' | 'unavailable' | 'invalid-input' | 'upstream' | 'internal';
  readonly message: string;
  readonly retryable: boolean;
}

export type AdapterResult =
  | { readonly ok: true; readonly output: AdapterOutput }
  | { readonly ok: false; readonly error: AdapterError };

export interface EngineAdapter {
  readonly runtime: EngineRuntime;
  /** Cheap check: is this adapter usable right now on this host? */
  readonly available: () => boolean | Promise<boolean>;
  readonly execute: (
    input: AdapterInput,
    onProgress?: (progress: AdapterProgress) => void,
  ) => Promise<AdapterResult>;
}

export class AdapterRegistry {
  readonly #adapters = new Map<EngineRuntime, EngineAdapter>();

  register(adapter: EngineAdapter): this {
    this.#adapters.set(adapter.runtime, adapter);
    return this;
  }

  get(runtime: EngineRuntime): EngineAdapter | undefined {
    return this.#adapters.get(runtime);
  }

  /** The adapter that would run this engine, without the caller knowing which runtime that is. */
  for(engine: EngineManifest): EngineAdapter | undefined {
    return this.#adapters.get(resolveRuntime(engine).runtime);
  }

  has(runtime: EngineRuntime): boolean {
    return this.#adapters.has(runtime);
  }

  runtimes(): readonly EngineRuntime[] {
    return [...this.#adapters.keys()].sort();
  }
}

/** Why an engine cannot be executed here — a stated reason beats a silent skip (invariant U5). */
export type DispatchRefusal =
  | { readonly reason: 'no-adapter'; readonly runtime: EngineRuntime }
  | { readonly reason: 'adapter-planned'; readonly runtime: EngineRuntime }
  | { readonly reason: 'host-incompatible'; readonly runtime: EngineRuntime };

export const canDispatch = (
  registry: AdapterRegistry,
  engine: EngineManifest,
): DispatchRefusal | null => {
  const spec = resolveRuntime(engine);
  if (spec.deployment === 'unsupported' || !spec.hostCompatible) {
    return { reason: 'host-incompatible', runtime: spec.runtime };
  }
  if (!registry.has(spec.runtime)) {
    return ADAPTER_SUPPORT[spec.runtime] === 'planned'
      ? { reason: 'adapter-planned', runtime: spec.runtime }
      : { reason: 'no-adapter', runtime: spec.runtime };
  }
  return null;
};
