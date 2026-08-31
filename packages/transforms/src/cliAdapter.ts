/**
 * The `cli` and `python` engine adapters — Part 2 §37, §38.
 *
 * Both runtimes are the same act from the core's point of view: render a command, run it somewhere,
 * read stdout. The difference (a Go binary vs a Python image) is the host's business, so this file
 * owns no process API at all: the caller injects `run`. That keeps `@nexus/transforms` importable
 * from the browser bundle (N2) and keeps the single sanctioned process door in the runner (N5).
 */

import type { AdapterInput, AdapterResult, EngineAdapter } from './adapters.ts';
import type { EngineRuntime } from './types.ts';

export interface CliExit {
  /** null when the process was killed rather than exiting. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr?: string;
  /** Set when the host itself refused: no docker, no binary, a bad payload, a timeout. */
  readonly failure?: 'timeout' | 'unavailable' | 'invalid-input';
}

/**
 * Injected by the host: renders the command for this engine, runs it under whatever confinement the
 * host has, and returns what came back. It must enforce `input.timeoutMs` itself — the adapter holds
 * no process handle and cannot kill anything.
 */
export type CliRun = (input: AdapterInput) => Promise<CliExit>;

export interface CliAdapterOptions {
  readonly runtime?: EngineRuntime;
  readonly run: CliRun;
  readonly available?: () => boolean | Promise<boolean>;
}

/**
 * stdout → items. Three shapes cover every CLI worth wrapping: JSON lines (subfinder, httpx, dnsx),
 * one JSON document (an array or an object), and plain lines (sherlock's txt output).
 * Anything else is the engine's parser problem, not the adapter's.
 */
export const parseCliStdout = (stdout: string): readonly Record<string, unknown>[] => {
  const text = stdout.trim();
  if (text === '') return [];

  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const asJson = (line: string): unknown => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return undefined;
    }
  };

  const whole = asJson(text);
  if (Array.isArray(whole)) {
    return whole.map((item) => (isRecord(item) ? item : { value: item }));
  }
  if (isRecord(whole)) return [whole];

  const parsed = lines.map(asJson);
  if (parsed.every(isRecord)) return parsed;

  return lines.map((line) => ({ value: line.trim() }));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const createCliAdapter = (options: CliAdapterOptions): EngineAdapter => ({
  runtime: options.runtime ?? 'cli',
  available: options.available ?? (() => true),

  async execute(input: AdapterInput, onProgress): Promise<AdapterResult> {
    // A CLI reports no percentage, and inventing one would be a lie the run console repeats (§24).
    onProgress?.({ fraction: null, message: `running ${input.engineId}` });

    let exit: CliExit;
    try {
      exit = await options.run(input);
    } catch (error) {
      return {
        ok: false,
        error: {
          kind: 'internal',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      };
    }

    if (exit.failure === 'timeout') {
      return {
        ok: false,
        error: {
          kind: 'timeout',
          message: `${input.engineId} exceeded ${input.timeoutMs}ms`,
          retryable: true,
        },
      };
    }
    if (exit.failure === 'invalid-input') {
      return {
        ok: false,
        error: {
          kind: 'invalid-input',
          message:
            exit.stderr?.trim() ||
            `${input.engineId} cannot run capability ${input.capability} on this payload`,
          retryable: false,
        },
      };
    }
    if (exit.failure === 'unavailable') {
      return {
        ok: false,
        error: {
          kind: 'unavailable',
          message: exit.stderr?.trim() || `${input.engineId} is not runnable on this host`,
          retryable: false,
        },
      };
    }
    if (exit.code !== 0) {
      return {
        ok: false,
        error: {
          kind: 'upstream',
          message: exit.stderr?.trim() || `${input.engineId} exited with code ${String(exit.code)}`,
          // A killed process (null) is worth one retry; a refusal with an exit code is not.
          retryable: exit.code === null,
        },
      };
    }

    return { ok: true, output: { items: parseCliStdout(exit.stdout), raw: exit.stdout } };
  },
});

/** Python engines are containerized CLIs; same contract, different passport (§34). */
export const createPythonAdapter = (options: Omit<CliAdapterOptions, 'runtime'>): EngineAdapter =>
  createCliAdapter({ ...options, runtime: 'python' });
