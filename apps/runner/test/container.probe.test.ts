/**
 * 13_SHERLOCK.md §3.6 in the runner: a manifest that declares a capability probe gets its image
 * interrogated once per digest before the first run, an incompatible image never runs, and a
 * compatible one is not probed again.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { effectiveLimits, networkPolicyOf, parseManifest } from '@nexus/integrations';

import {
  clearCapabilityCache,
  createContainerExecutor,
  type ContainerExecutorDeps,
  type ContainerRuntime,
} from '../src/executors/container.ts';
import type { CancelWatch } from '../src/cancel.ts';

const HELP = 'options:\n  --json FILE           Write results to a JSON file\n';

function manifestWith(digest: string) {
  return parseManifest({
    manifestVersion: 1,
    id: 'probed-tool',
    name: 'Probed tool',
    version: '1.0.0',
    toolVersion: '0.16.0',
    publisher: { name: 'Raven core' },
    icon: 'integrations/test',
    repository: 'https://example.test/repo',
    license: 'MIT',
    description: 'A container manifest that declares a version and capability probe.',
    capabilities: ['enumerate-usernames'],
    inputs: [{ name: 'target', label: 'Target', type: 'string', from: { source: 'form' } }],
    outputs: [{ name: 'result', kind: 'json', fromStdout: true, primary: true }],
    permissions: ['graph:propose', 'net:broad'],
    execution: {
      kind: 'container',
      image: 'ghcr.io/example/tool',
      digest,
      command: ['--target', '{{input.target}}'],
      network: { mode: 'broad', allow: [], denyPrivateRanges: true },
      limits: { wallClockMs: 60_000, maxOutputBytes: 4096, tmpfsMiB: 32 },
      readOnlyRootFs: true,
      capabilityProbe: {
        versionArgs: ['--version'],
        helpArgs: ['--help'],
        requiredFlags: ['--json'],
        minVersion: '0.16.0',
      },
    },
    parser: { module: 'x', supportedOutputVersions: ['0.16'] },
    rateLimits: {},
    costHints: { typicalDurationMs: 1000, typicalOutboundRequests: 1, typicalNewNodes: 1 },
    maturity: 'stable',
    risk: { label: 'medium', upstreamMaintenance: 'active' },
    consent: {
      scopeText:
        'I confirm I am authorized to look up this handle and that it is lawful where I am.',
      allowedTargetScopes: ['public-index'],
    },
  });
}

function fakeChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setTimeout(() => {
    (child.stdout as EventEmitter).emit('data', new TextEncoder().encode('{"ok":true}'));
    child.emit('close', 0, null);
  }, 0);
  return child as unknown as ChildProcessWithoutNullStreams;
}

function runtime(help: string, version = 'Sherlock v0.16.0') {
  const probes: string[] = [];
  const spawned: string[] = [];
  const rt: ContainerRuntime = {
    pull: () => Promise.resolve(),
    probe: (_image, _digest, args) => {
      probes.push(args.join(' '));
      return Promise.resolve(args[0] === '--version' ? version : help);
    },
    spawn: () => {
      spawned.push('run');
      return fakeChild();
    },
    readOutput: () => Promise.resolve(undefined),
    kill: () => Promise.resolve(),
    listRunIds: () => Promise.resolve([]),
  };
  return { rt, probes, spawned };
}

const idleWatch = (): CancelWatch => ({
  cancelled: () => false,
  stop: () => Promise.resolve(),
  signal: new Promise<void>(() => undefined),
});

const deps = (over: Partial<ContainerExecutorDeps>): ContainerExecutorDeps => ({
  runtime: runtime(HELP).rt,
  sink: { put: () => Promise.resolve() },
  bucket: 'raven',
  orgId: 'org-1',
  watch: idleWatch(),
  sandbox: {
    runtime: 'runsc',
    proxyUrl: 'http://egress:3128',
    network: 'raven-egress',
    seccompProfile: '/etc/raven/seccomp-tool.json',
    apparmorProfile: 'raven-tool',
    env: {},
  },
  ...over,
});

const digest = (char: string) => `sha256:${char.repeat(64)}`;

function execute(rt: ContainerRuntime, imageDigest: string, onStdout?: (chunk: string) => void) {
  const manifest = manifestWith(imageDigest);
  const executor = createContainerExecutor(
    deps({ runtime: rt, ...(onStdout === undefined ? {} : { onStdout }) }),
  );
  return executor.execute({
    runId: 'run-1',
    manifest,
    input: { target: 'jsmith' },
    secretsRef: [],
    limits: effectiveLimits(manifest.execution.limits, networkPolicyOf(manifest)),
    cancelToken: 'cancel:run-1',
  });
}

describe('container capability probe', () => {
  it('probes version and help before the first run and reports the version', async () => {
    clearCapabilityCache();
    const { rt, probes, spawned } = runtime(HELP);
    const onStdout = vi.fn();
    const result = await execute(rt, digest('b'), onStdout);

    expect(probes).toEqual(['--version', '--help']);
    expect(spawned).toEqual(['run']);
    expect(result.status).toBe('succeeded');
    expect(onStdout.mock.calls[0]?.[0]).toContain('Sherlock v0.16.0');
  });

  it('refuses to run an image that lacks a required flag', async () => {
    clearCapabilityCache();
    const { rt, spawned } = runtime('options:\n  --site NAME\n', 'Sherlock v0.13.0');
    const result = await execute(rt, digest('c'));
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('IMAGE_INCOMPATIBLE');
    expect(spawned).toEqual([]);
  });

  it('warns about an image older than the verified version but still runs it', async () => {
    clearCapabilityCache();
    const { rt } = runtime(HELP, 'Sherlock v0.14.0');
    const onStdout = vi.fn();
    const result = await execute(rt, digest('d'), onStdout);

    expect(result.status).toBe('succeeded');
    expect(onStdout.mock.calls[0]?.[0]).toContain('predates');
  });

  it('probes a digest only once', async () => {
    clearCapabilityCache();
    const { rt, probes } = runtime(HELP);
    await execute(rt, digest('e'));
    await execute(rt, digest('e'));
    expect(probes).toEqual(['--version', '--help']);
  });
});
