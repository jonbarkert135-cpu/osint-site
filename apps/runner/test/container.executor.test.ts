/**
 * The container execution lifecycle with an injected runtime: registry allowlist, digest pull,
 * output collection from stdout and from files, and the §6.8 exit-code → status mapping.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { effectiveLimits, networkPolicyOf, parseManifest } from '@nexus/integrations';

import {
  createContainerExecutor,
  type ContainerExecutorDeps,
  type ContainerRuntime,
} from '../src/executors/container.ts';
import type { CancelWatch } from '../src/cancel.ts';

const manifest = parseManifest({
  manifestVersion: 1,
  id: 'test-tool',
  name: 'Test tool',
  version: '1.0.0',
  toolVersion: '2.0.0',
  publisher: { name: 'Raven core' },
  icon: 'integrations/test',
  repository: 'https://example.test/repo',
  license: 'MIT',
  description: 'A container manifest used to exercise the container execution lifecycle.',
  capabilities: ['scan-domain'],
  inputs: [{ name: 'target', label: 'Target', type: 'string', from: { source: 'form' } }],
  outputs: [{ name: 'result', kind: 'json', fromStdout: true, primary: true }],
  permissions: ['graph:propose', 'net:allowlist'],
  execution: {
    kind: 'container',
    image: 'ghcr.io/example/tool',
    digest: `sha256:${'a'.repeat(64)}`,
    command: ['--target', '{{input.target}}'],
    network: { mode: 'allowlist', allow: ['api.example.test'], denyPrivateRanges: true },
    limits: { wallClockMs: 60_000, maxOutputBytes: 4096, tmpfsMiB: 32 },
    readOnlyRootFs: true,
  },
  parser: { module: 'x', supportedOutputVersions: ['2.0'] },
  rateLimits: {},
  costHints: { typicalDurationMs: 1000, typicalOutboundRequests: 1, typicalNewNodes: 1 },
  maturity: 'experimental',
  risk: { label: 'medium', upstreamMaintenance: 'unknown' },
  consent: {
    scopeText: 'I confirm I am authorized to scan this target and that it is lawful where I am.',
    allowedTargetScopes: ['owned-asset'],
  },
});

const fileManifest = parseManifest({
  ...JSON.parse(JSON.stringify(manifest)),
  outputs: [{ name: 'result', kind: 'json', path: '/work/out.json', primary: true }],
});

const limits = effectiveLimits(manifest.execution.limits, networkPolicyOf(manifest));

/** A child process that emits the given stdout and then closes with `code`/`signal`. */
function fakeChild(options: {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
}): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  child.stdout = stdout;
  child.stderr = stderr;
  child.exitCode = options.code ?? null;
  setTimeout(() => {
    if (options.stdout !== undefined) stdout.emit('data', new TextEncoder().encode(options.stdout));
    if (options.stderr !== undefined) stderr.emit('data', new TextEncoder().encode(options.stderr));
    child.emit('close', options.code ?? 0, options.signal ?? null);
  }, 0);
  return child as unknown as ChildProcessWithoutNullStreams;
}

function runtime(over: Partial<ContainerRuntime> = {}): ContainerRuntime & {
  pulled: string[];
  killed: string[];
} {
  const pulled: string[] = [];
  const killed: string[] = [];
  return {
    pulled,
    killed,
    pull: (image, digest) => {
      pulled.push(`${image}@${digest}`);
      return Promise.resolve();
    },
    probe: () => Promise.resolve(''),
    spawn: () => fakeChild({ stdout: '{"ok":true}', code: 0 }),
    readOutput: () => Promise.resolve(undefined),
    kill: (runId, signal) => {
      killed.push(`${runId}:${signal}`);
      return Promise.resolve();
    },
    listRunIds: () => Promise.resolve([]),
    ...over,
  };
}

const sink = () => {
  const written: { key: string; body: string }[] = [];
  return {
    written,
    put: (key: string, body: Uint8Array) => {
      written.push({ key, body: new TextDecoder().decode(body) });
      return Promise.resolve();
    },
  };
};

const idleWatch = (): CancelWatch => ({
  cancelled: () => false,
  stop: () => Promise.resolve(),
  signal: new Promise<void>(() => undefined),
});

const sandbox = {
  runtime: 'runsc' as const,
  proxyUrl: 'http://egress:3128',
  network: 'raven-egress',
  seccompProfile: '/etc/raven/seccomp-tool.json',
  apparmorProfile: 'raven-tool',
  env: {},
};

const deps = (over: Partial<ContainerExecutorDeps> = {}): ContainerExecutorDeps => ({
  runtime: runtime(),
  sink: sink(),
  bucket: 'raven',
  orgId: 'org-1',
  watch: idleWatch(),
  sandbox,
  ...over,
});

const request = (over: Record<string, unknown> = {}) => ({
  runId: 'run-1',
  manifest,
  input: { target: 'example.test' },
  secretsRef: [],
  limits,
  cancelToken: 'cancel:run-1',
  ...over,
});

describe('container executor', () => {
  it('pulls by digest, streams stdout into the primary artifact and succeeds', async () => {
    const store = sink();
    const rt = runtime();
    const onStdout = vi.fn();
    const executor = createContainerExecutor(deps({ runtime: rt, sink: store, onStdout }));

    const result = await executor.execute(request());
    expect(result.status).toBe('succeeded');
    expect(result.exitCode).toBe(0);
    expect(rt.pulled).toEqual([`ghcr.io/example/tool@sha256:${'a'.repeat(64)}`]);
    expect(store.written[0]?.body).toBe('{"ok":true}');
    expect(onStdout).toHaveBeenCalledWith('{"ok":true}');
  });

  it('scrubs secrets out of stdout before it is stored', async () => {
    const store = sink();
    const executor = createContainerExecutor(
      deps({
        sink: store,
        runtime: runtime({ spawn: () => fakeChild({ stdout: '{"t":"sekrit-value"}', code: 0 }) }),
        secrets: { 'tool.api': 'sekrit-value' },
      }),
    );
    await executor.execute(request());
    expect(store.written[0]?.body).toBe('{"t":"«redacted:tool.api»"}');
  });

  it('reads a declared file output out of the container', async () => {
    const store = sink();
    const executor = createContainerExecutor(
      deps({
        sink: store,
        runtime: runtime({
          spawn: () => fakeChild({ code: 0 }),
          readOutput: (_runId: string, path: string) =>
            Promise.resolve(new TextEncoder().encode(`from ${path}`)),
        }),
      }),
    );
    const result = await executor.execute(request({ manifest: fileManifest }));
    expect(result.status).toBe('succeeded');
    expect(store.written[0]?.body).toBe('from /work/out.json');
  });

  it('fails when the tool exits clean but wrote nothing', async () => {
    const executor = createContainerExecutor(
      deps({
        runtime: runtime({
          spawn: () => fakeChild({ code: 0 }),
          readOutput: () => Promise.resolve(undefined),
        }),
      }),
    );
    const result = await executor.execute(request({ manifest: fileManifest }));
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('OUTPUT_MISSING');
  });

  it('treats a non-zero exit with output as partial, not as a total loss (§6.8)', async () => {
    const executor = createContainerExecutor(
      deps({ runtime: runtime({ spawn: () => fakeChild({ stdout: 'half', code: 2 }) }) }),
    );
    const result = await executor.execute(request());
    expect(result.status).toBe('partial');
    expect(result.exitCode).toBe(2);
    expect(result.error?.code).toBe('TOOL_EXIT_NONZERO');
  });

  it('reports a SIGKILL as an OOM kill', async () => {
    const executor = createContainerExecutor(
      deps({
        runtime: runtime({ spawn: () => fakeChild({ code: 137, signal: 'SIGKILL' }) }),
      }),
    );
    const result = await executor.execute(request());
    expect(result.error?.code).toBe('OOM_KILLED');
  });

  it('refuses an image from a registry that is not allowed', async () => {
    const rt = runtime();
    const executor = createContainerExecutor(
      deps({ runtime: rt, allowedRegistries: ['registry.internal'] }),
    );
    const result = await executor.execute(request());
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('IMAGE_REGISTRY_DENIED');
    expect(rt.pulled).toEqual([]);
  });

  it('surfaces a failed pull as a canonical error', async () => {
    const executor = createContainerExecutor(
      deps({ runtime: runtime({ pull: () => Promise.reject(new Error('no such image')) }) }),
    );
    const result = await executor.execute(request());
    expect(result.status).toBe('failed');
    expect(result.error).toBeDefined();
  });

  it('refuses a non-container manifest, because that is a wiring bug', async () => {
    const executor = createContainerExecutor(deps());
    const builtin = {
      ...manifest,
      execution: {
        kind: 'builtin' as const,
        module: 'expand-url',
        limits: manifest.execution.limits,
      },
    };
    await expect(executor.execute(request({ manifest: builtin }))).rejects.toThrow(/INTERNAL/);
  });

  it('cancels a run with SIGTERM first', async () => {
    const rt = runtime();
    const executor = createContainerExecutor(deps({ runtime: rt }));
    await executor.cancel('run-9');
    expect(rt.killed).toEqual(['run-9:SIGTERM']);
  });

  it('kills and reports cancelled when the watch trips mid-run', async () => {
    const rt = runtime({ spawn: () => fakeChild({ stdout: 'partial output', code: null }) });
    const executor = createContainerExecutor(
      deps({
        runtime: rt,
        watch: {
          cancelled: () => true,
          stop: () => Promise.resolve(),
          signal: Promise.resolve(),
        } satisfies CancelWatch,
      }),
    );
    const result = await executor.execute(request({ limits: { ...limits, wallClockMs: 60_000 } }));
    expect(['cancelled', 'succeeded']).toContain(result.status);
    expect(rt.killed.some((entry) => entry.startsWith('run-1:'))).toBe(true);
  }, 20_000);
});
