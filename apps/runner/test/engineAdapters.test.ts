import { describe, expect, it, vi } from 'vitest';

import type {
  ArtifactRef,
  ExecutionLayer,
  IntegrationManifest,
  RawRunResult,
} from '@nexus/integrations';
import type { AdapterInput } from '@nexus/transforms';

import { createEngineAdapters, createEngineCliRun } from '../src/executors/engineAdapters.ts';

/** `sherlock` is the seeded python engine; its manifest shape only matters for limits here. */
const manifest = {
  id: 'sherlock',
  execution: {
    kind: 'container',
    limits: {
      wallClockMs: 300_000,
      cpuMillicores: 1000,
      memoryMiB: 512,
      pids: 64,
      maxOutputBytes: 1_000_000,
      maxArtifacts: 4,
      tmpfsMiB: 64,
    },
    network: { allow: ['example.com'], maxRequestsPerMinute: 60 },
    secretEnv: {},
  },
} as unknown as IntegrationManifest;

const artifact: ArtifactRef = {
  bucket: 'b',
  key: 'runs/1/stdout',
  bytes: 10,
  sha256: 'x',
  contentType: 'text/plain',
  truncated: false,
};

const result = (over: Partial<RawRunResult>): RawRunResult => ({
  runId: 'run-1',
  status: 'succeeded',
  exitCode: 0,
  startedAt: '2026-08-31T00:00:00.000Z',
  finishedAt: '2026-08-31T00:00:01.000Z',
  durationMs: 1000,
  artifacts: [artifact],
  stats: { bytesOut: 10, egressRequests: 1, egressDenied: 0, peakMemMiB: 20 },
  ...over,
});

const input: AdapterInput = {
  engineId: 'sherlock',
  capability: 'profile-discovery',
  payload: { username: 'someone' },
  timeoutMs: 30_000,
};

const deps = (raw: RawRunResult, stdout = '{"site":"github"}') => {
  const executor: ExecutionLayer = {
    execute: vi.fn(async () => raw),
    cancel: vi.fn(async () => undefined),
  };
  return {
    executor,
    manifestFor: () => manifest,
    readArtifact: async () => stdout,
    runId: () => 'run-1',
  };
};

describe('engine adapters over the execution layer (§37, §38)', () => {
  it('runs a containerized engine and returns its stdout', async () => {
    const run = createEngineCliRun(deps(result({})));
    expect(await run(input)).toEqual({ code: 0, stdout: '{"site":"github"}' });
  });

  it('caps the wall clock at the caller timeout instead of extending the manifest', async () => {
    const d = deps(result({}));
    await createEngineCliRun(d)(input);
    const request = vi.mocked(d.executor.execute).mock.calls[0]?.[0];
    expect(request?.limits.wallClockMs).toBe(30_000);
    expect(request?.limits.egressAllowlist).toEqual(['example.com']);
  });

  it('reports a missing integration as unavailable rather than throwing', async () => {
    const run = createEngineCliRun({ ...deps(result({})), manifestFor: () => undefined });
    expect(await run(input)).toMatchObject({ failure: 'unavailable' });
  });

  it('maps run statuses and error codes to adapter failures', async () => {
    const cases: readonly [RawRunResult, string | undefined][] = [
      [result({ status: 'timed_out' }), 'timeout'],
      [result({ status: 'failed', error: { code: 'INPUT_INVALID' } as never }), 'invalid-input'],
      [result({ status: 'failed', error: { code: 'TOOL_UNAVAILABLE' } as never }), 'unavailable'],
      [result({ status: 'partial' }), undefined],
    ];
    for (const [raw, failure] of cases) {
      expect((await createEngineCliRun(deps(raw))(input)).failure).toBe(failure);
    }
  });

  it('keeps a plain failure exit code so a refusal is not retried like a kill', async () => {
    const refused = await createEngineCliRun(deps(result({ status: 'failed', exitCode: 2 })))(
      input,
    );
    expect(refused).toMatchObject({ code: 2 });

    const killed = await createEngineCliRun(deps(result({ status: 'cancelled', exitCode: null })))(
      input,
    );
    expect(killed).toMatchObject({ code: null });
  });

  it('produces the cli, python, go and rust adapters over the same host binding', async () => {
    const [cli, python, go, rust] = createEngineAdapters(deps(result({})));
    expect([cli, python, go, rust].map((adapter) => adapter.runtime)).toEqual([
      'cli',
      'python',
      'go',
      'rust',
    ]);
    await expect(cli.execute(input)).resolves.toEqual({
      ok: true,
      output: { items: [{ site: 'github' }], raw: '{"site":"github"}' },
    });
  });
});
