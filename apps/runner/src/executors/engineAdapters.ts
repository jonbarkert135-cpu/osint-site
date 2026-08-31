/**
 * Host binding for the `cli` and `python` engine adapters — Part 2 §37, §38.
 *
 * `@nexus/transforms` owns the adapter contract and stays process-blind; this file is the half that
 * knows where a process may run. It routes through the existing `ExecutionLayer`, so an engine gets
 * the sandbox, the egress proxy, the limits and the artifact collection that every other run gets:
 * one confinement, not a second unreviewed door (N5).
 */

import {
  createCatalogRegistry,
  createCliAdapter,
  createGoAdapter,
  createPythonAdapter,
  createRustAdapter,
} from '@nexus/transforms';
import type { AdapterInput, CliExit, CliRun, EngineAdapter } from '@nexus/transforms';
import {
  effectiveLimits,
  networkPolicyOf,
  type ArtifactRef,
  type ExecutionLayer,
  type IntegrationManifest,
  type RawRunResult,
} from '@nexus/integrations';

export interface EngineAdapterDeps {
  /** Integration manifest for an engine's `integration` id; undefined when it is not installed. */
  readonly manifestFor: (integrationId: string) => IntegrationManifest | undefined;
  readonly executor: ExecutionLayer;
  /** Reads a collected artifact back as text — the engine's stdout. */
  readonly readArtifact: (ref: ArtifactRef) => Promise<string>;
  readonly runId: () => string;
  readonly cancelToken?: (runId: string) => string;
}

const catalog = createCatalogRegistry();

const integrationOf = (engineId: string): string | undefined =>
  catalog.engine(engineId)?.integration;

/** Which host failures are the tool's absence rather than its answer. */
const UNAVAILABLE_CODES = new Set([
  'TOOL_UNAVAILABLE',
  'IMAGE_PULL_TIMEOUT',
  'IMAGE_PULL_FAILED',
  'IMAGE_DIGEST_MISMATCH',
  'IMAGE_REGISTRY_DENIED',
  'CAPABILITY_MISSING',
]);

const toExit = (result: RawRunResult, stdout: string): CliExit => {
  const code = result.error?.code;
  if (result.status === 'timed_out') return { code: null, stdout, failure: 'timeout' };
  if (code === 'INPUT_INVALID') return { code: null, stdout, failure: 'invalid-input' };
  if (code !== undefined && UNAVAILABLE_CODES.has(code)) {
    return { code: null, stdout, stderr: code, failure: 'unavailable' };
  }
  if (result.status === 'succeeded' || result.status === 'partial') {
    return { code: 0, stdout };
  }
  // A cancelled or failed run keeps its exit code, so the adapter can tell a refusal (exit 2, do not
  // retry) from a kill (null, worth one retry).
  return { code: result.exitCode, stdout, ...(code === undefined ? {} : { stderr: code }) };
};

export const createEngineCliRun = (deps: EngineAdapterDeps): CliRun => {
  return async (input: AdapterInput): Promise<CliExit> => {
    const integrationId = integrationOf(input.engineId);
    const manifest = integrationId === undefined ? undefined : deps.manifestFor(integrationId);
    if (manifest === undefined) {
      return {
        code: null,
        stdout: '',
        stderr: `no integration manifest for engine ${input.engineId}`,
        failure: 'unavailable',
      };
    }

    const runId = deps.runId();
    const network = networkPolicyOf(manifest);
    const result = await deps.executor.execute({
      runId,
      manifest,
      input: input.payload,
      secretsRef: [],
      // The engine's own timeout is a ceiling on the manifest's, never an extension of it: a caller
      // may ask for less time, never for more than the tool was approved to take.
      limits: effectiveLimits(manifest.execution.limits, network, {
        maxWallClockMs: input.timeoutMs,
      }),
      cancelToken: deps.cancelToken?.(runId) ?? `cancel:${runId}`,
    });

    const stdoutRef = result.stdoutRef ?? result.artifacts[0];
    const stdout = stdoutRef === undefined ? '' : await deps.readArtifact(stdoutRef);
    return toExit(result, stdout);
  };
};

/**
 * The adapters this host can serve: cli, python, go and rust — one `run`, four passports (§38).
 * Registering them is the caller's call.
 */
export const createEngineAdapters = (
  deps: EngineAdapterDeps,
): readonly [EngineAdapter, EngineAdapter, EngineAdapter, EngineAdapter] => {
  const run = createEngineCliRun(deps);
  return [
    createCliAdapter({ run }),
    createPythonAdapter({ run }),
    createGoAdapter({ run }),
    createRustAdapter({ run }),
  ];
};
