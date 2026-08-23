/**
 * The `container` execution layer (10_INTEGRATIONS.md §6.1–§6.3, §6.8).
 *
 * This is the only module in the codebase allowed to spawn a process (N5, enforced by the
 * `no-child-process-in-api` rule and `test/arch.no-child-process-worker.test.ts`). Everything about
 * *how* the container is confined lives in `sandbox/flags.ts`; this file is the lifecycle: pull by
 * digest, verify the digest, start, stream, cap, collect, kill, clean up.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import {
  checkCapabilities,
  IntegrationError,
  parseImageCapabilities,
  payloadFor,
  toErrorPayload,
  type ExecutionLayer,
  type ArtifactRef,
  type ExecutionRequest,
  type ImageCapabilities,
  type RawRunResult,
} from '@nexus/integrations';

import { collectArtifact, StreamRingBuffer, type ArtifactSink } from '../artifacts.ts';
import type { CancelWatch } from '../cancel.ts';
import { TIMERS } from '../protocol.ts';
import { buildContainerArgs, renderCommand, type SandboxOptions } from '../sandbox/flags.ts';
import { scrub } from '../sandbox/secrets.ts';

/** The container runtime, injected so tests never need Docker. */
export interface ContainerRuntime {
  /** Pulls `image@digest`; must fail closed when the resolved digest differs. */
  pull(image: string, digest: string, timeoutMs: number): Promise<void>;
  spawn(
    argv: readonly string[],
    env: Readonly<Record<string, string>>,
  ): ChildProcessWithoutNullStreams;
  /** Runs the image with probe arguments and no network, returning stdout+stderr (13 §3.6). */
  probe(image: string, digest: string, args: readonly string[], timeoutMs: number): Promise<string>;
  /** Reads a declared output file out of the finished container's workdir. */
  readOutput(runId: string, path: string): Promise<Uint8Array | undefined>;
  kill(runId: string, signal: 'SIGTERM' | 'SIGKILL'): Promise<void>;
  /** Containers still alive that carry our run label; used by the reaper. */
  listRunIds(): Promise<readonly string[]>;
}

export const DOCKER_BIN = process.env.RUNNER_DOCKER_BIN ?? 'docker';

/** The default runtime: `docker` over argv, never a shell. */
export function dockerRuntime(): ContainerRuntime {
  const run = (args: readonly string[], timeoutMs: number): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = spawn(DOCKER_BIN, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new IntegrationError('IMAGE_PULL_TIMEOUT'));
      }, timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else
          reject(
            new IntegrationError('TOOL_UNAVAILABLE', { detail: { stderr: err.slice(0, 300) } }),
          );
      });
    });

  return {
    async pull(image, digest, timeoutMs) {
      await run(['pull', `${image}@${digest}`], timeoutMs);
      const inspected = await run(
        ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', `${image}@${digest}`],
        30_000,
      );
      if (!inspected.includes(digest)) {
        throw new IntegrationError('IMAGE_DIGEST_MISMATCH', { detail: { image } });
      }
    },
    async probe(image, digest, args, timeoutMs) {
      return run(['run', '--rm', '--network', 'none', `${image}@${digest}`, ...args], timeoutMs);
    },
    spawn: (argv, env) =>
      spawn(DOCKER_BIN, [...argv], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH ?? '', ...env },
      }) as unknown as ChildProcessWithoutNullStreams,
    async readOutput(runId, path) {
      try {
        const out = await run(['cp', `${runId}:${path}`, '-'], 30_000);
        return new TextEncoder().encode(out);
      } catch {
        return undefined;
      }
    },
    async kill(runId, signal) {
      await run(['kill', '--signal', signal, runId], 15_000).catch(() => '');
    },
    async listRunIds() {
      const out = await run(
        ['ps', '--filter', 'label=raven.run_id', '--format', '{{.Label "raven.run_id"}}'],
        15_000,
      );
      return out.split('\n').filter((line) => line.trim() !== '');
    },
  };
}

export interface ContainerExecutorDeps {
  readonly runtime: ContainerRuntime;
  readonly sink: ArtifactSink;
  readonly bucket: string;
  readonly orgId: string;
  readonly watch: CancelWatch;
  readonly sandbox: Omit<SandboxOptions, 'runId' | 'orgId' | 'limits' | 'tmpfsMiB'>;
  /** Secret values, for output scrubbing (§6.6 point 5). */
  readonly secrets?: Readonly<Record<string, string>>;
  readonly allowedRegistries?: readonly string[];
  readonly onStdout?: (chunk: string) => void;
  readonly now?: () => string;
}

function registryOf(image: string): string {
  const first = image.split('/')[0] ?? '';
  return first.includes('.') || first.includes(':') ? first : 'docker.io';
}

/** §3.6: probed once per digest, then cached forever — the image cannot change under a digest. */
const capabilityCache = new Map<string, ImageCapabilities>();

/** Exported for tests; a fresh process starts with an empty cache anyway. */
export function clearCapabilityCache(): void {
  capabilityCache.clear();
}

async function probeCapabilities(
  deps: ContainerExecutorDeps,
  execution: Extract<ExecutionRequest['manifest']['execution'], { kind: 'container' }>,
  probedAt: string,
): Promise<void> {
  const spec = execution.capabilityProbe;
  if (spec === undefined) return;
  let caps = capabilityCache.get(execution.digest);
  if (caps === undefined) {
    const [versionOutput, helpOutput] = await Promise.all([
      deps.runtime.probe(
        execution.image,
        execution.digest,
        spec.versionArgs,
        TIMERS.containerStartMs,
      ),
      deps.runtime.probe(execution.image, execution.digest, spec.helpArgs, TIMERS.containerStartMs),
    ]);
    caps = parseImageCapabilities({
      imageDigest: execution.digest,
      versionOutput,
      helpOutput,
      probedAt,
    });
    capabilityCache.set(execution.digest, caps);
  }
  const verdict = checkCapabilities(caps, spec);
  deps.onStdout?.(
    `probe: ${caps.versionString ?? 'version unknown'}` +
      (verdict.warning === null ? '' : ` — ${verdict.warning}`) +
      '\n',
  );
  if (!verdict.ok) {
    throw new IntegrationError('IMAGE_INCOMPATIBLE', {
      detail: {
        image: execution.image,
        digest: execution.digest,
        missingFlags: verdict.missingFlags,
      },
    });
  }
}

export function createContainerExecutor(deps: ContainerExecutorDeps): ExecutionLayer {
  const now = deps.now ?? (() => new Date().toISOString());
  const running = new Map<string, ChildProcessWithoutNullStreams>();

  return {
    async execute(request: ExecutionRequest): Promise<RawRunResult> {
      const startedAt = now();
      const start = Date.now();
      const execution = request.manifest.execution;
      if (execution.kind !== 'container') {
        throw new IntegrationError('INTERNAL', {
          why: 'ContainerExecutor received a non-container manifest.',
        });
      }

      const stdout = new StreamRingBuffer();
      const stderr = new StreamRingBuffer();
      const secrets = deps.secrets ?? {};
      const finish = (
        status: RawRunResult['status'],
        extra: Partial<RawRunResult> = {},
      ): RawRunResult => ({
        runId: request.runId,
        status,
        exitCode: null,
        startedAt,
        finishedAt: now(),
        durationMs: Date.now() - start,
        artifacts: [],
        stats: { bytesOut: 0, egressRequests: 0, egressDenied: 0, peakMemMiB: 0 },
        ...extra,
      });

      try {
        if (
          deps.allowedRegistries !== undefined &&
          !deps.allowedRegistries.includes(registryOf(execution.image))
        ) {
          throw new IntegrationError('IMAGE_REGISTRY_DENIED', {
            detail: { image: execution.image },
          });
        }
        await deps.runtime.pull(execution.image, execution.digest, TIMERS.imagePullMs);
        await probeCapabilities(deps, execution, startedAt);

        const rendered = renderCommand(
          request.manifest,
          request.input as Record<string, unknown>,
          request.runId,
        );
        const { argv, env } = buildContainerArgs(
          request.manifest,
          {
            ...deps.sandbox,
            runId: request.runId,
            orgId: deps.orgId,
            limits: request.limits,
            tmpfsMiB: execution.limits.tmpfsMiB,
          },
          rendered,
        );

        const child = deps.runtime.spawn(argv, env);
        running.set(request.runId, child);

        child.stdout.on('data', (chunk: Uint8Array) => {
          stdout.push(chunk);
          deps.onStdout?.(scrub(new TextDecoder().decode(chunk), secrets).slice(0, 4096));
        });
        child.stderr.on('data', (chunk: Uint8Array) => stderr.push(chunk));

        const exit = await Promise.race([
          new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
            child.on('close', (code, signal) => resolve({ code, signal }));
          }),
          waitAndKill(deps, request, child, 'timed_out'),
          deps.watch.signal.then(() => waitAndKill(deps, request, child, 'cancelled')),
        ]);

        const artifacts: ArtifactRef[] = [];
        let budget = request.limits.maxOutputBytes;
        for (const output of request.manifest.outputs) {
          const body =
            output.fromStdout === true
              ? new TextEncoder().encode(scrub(stdout.text(), secrets))
              : await deps.runtime.readOutput(
                  request.runId,
                  output.path ?? `${execution.workdir}/${output.name}`,
                );
          if (body === undefined) continue;
          const collected = await collectArtifact(deps.sink, body, {
            orgId: deps.orgId,
            runId: request.runId,
            name: output.name,
            kind: output.kind,
            maxBytes: output.maxBytes,
            runBudget: budget,
            bucket: deps.bucket,
          });
          budget -= collected.bytesWritten;
          artifacts.push(collected.ref);
        }

        const stats = {
          bytesOut: request.limits.maxOutputBytes - budget,
          egressRequests: 0,
          egressDenied: 0,
          peakMemMiB: 0,
        };

        if ('status' in exit) {
          return finish(exit.status, {
            artifacts,
            stats,
            error: payloadFor(exit.status === 'cancelled' ? 'CANCELLED' : 'TIMEOUT', {
              runId: request.runId,
            }),
          });
        }
        if (exit.code === 0) {
          const empty = artifacts.length === 0;
          return finish(empty ? 'failed' : 'succeeded', {
            exitCode: 0,
            artifacts,
            stats,
            ...(empty ? { error: payloadFor('OUTPUT_MISSING', { runId: request.runId }) } : {}),
          });
        }
        // §6.8: a non-zero exit with a parsable primary output is `partial`, not a total loss.
        return finish(artifacts.length > 0 ? 'partial' : 'failed', {
          exitCode: exit.code,
          artifacts,
          stats,
          error: payloadFor(exit.signal === 'SIGKILL' ? 'OOM_KILLED' : 'TOOL_EXIT_NONZERO', {
            runId: request.runId,
            why:
              exit.signal === 'SIGKILL'
                ? 'The container was killed by the kernel, which usually means the memory cap.'
                : `The tool exited with code ${String(exit.code)}.`,
          }),
        });
      } catch (error) {
        return finish('failed', { error: toErrorPayload(error, request.runId) });
      } finally {
        running.delete(request.runId);
      }
    },

    async cancel(runId: string): Promise<void> {
      await deps.runtime.kill(runId, 'SIGTERM');
      setTimeout(() => void deps.runtime.kill(runId, 'SIGKILL'), TIMERS.graceMs).unref?.();
    },
  };
}

/** SIGTERM → 5 s grace → SIGKILL, then still collect what the tool wrote (§6.7). */
async function waitAndKill(
  deps: ContainerExecutorDeps,
  request: ExecutionRequest,
  child: ChildProcessWithoutNullStreams,
  status: 'timed_out' | 'cancelled',
): Promise<{ status: 'timed_out' | 'cancelled' }> {
  if (status === 'timed_out') {
    await new Promise((resolve) => setTimeout(resolve, request.limits.wallClockMs));
  }
  await deps.runtime.kill(request.runId, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, TIMERS.graceMs));
  if (child.exitCode === null) await deps.runtime.kill(request.runId, 'SIGKILL');
  return { status };
}
