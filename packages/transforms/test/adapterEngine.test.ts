import { describe, expect, it } from 'vitest';

import { createAdapterEngine, defaultReadValue } from '../src/sdk/adapterEngine.ts';
import { AdapterRegistry } from '../src/adapters.ts';
import { createCatalogRegistry } from '../src/catalog/index.ts';
import { createCliAdapter, createPythonAdapter } from '../src/cliAdapter.ts';
import { runEngine } from '../src/sdk/run.ts';
import { adapterEngines, registryEngines } from '../src/sdk/engines/cli-engines.ts';
import type { EngineMetadata } from '../src/sdk/types.ts';

const metadata: EngineMetadata = {
  engine: 'subfinder',
  version: '1.0.0',
  capability: 'subdomain-discovery',
  provider: 'local-runtime',
  permissions: ['network', 'subprocess'],
  inputs: ['domain'],
  outputs: ['hostname'],
};

type Failure = 'timeout' | 'invalid-input' | 'unavailable';

const engineOver = (stdout: string, failure?: Failure) =>
  createAdapterEngine({
    metadata,
    adapter: createCliAdapter({
      run: async () => ({ code: 0, stdout, ...(failure ? { failure } : {}) }),
    }),
  });

const run = (stdout: string, failure?: Failure) =>
  runEngine(engineOver(stdout, failure), {
    input: { kind: 'domain', value: 'example.com' },
    mode: 'configured',
    deadlineMs: 5_000,
    maxResults: 100,
    fetch: async () => ({ status: 200, body: null }),
  });

describe('defaultReadValue', () => {
  it('takes the most specific conventional field', () => {
    expect(defaultReadValue({ host: 'a.example.com', name: 'x' })).toBe('a.example.com');
    expect(defaultReadValue({ value: ' b.example.com ' })).toBe('b.example.com');
    expect(defaultReadValue({ count: 3 })).toBeUndefined();
  });
});

describe('adapter-backed engine', () => {
  it('turns adapter items into proposed entities linked to the input', async () => {
    const outcome = await run('{"host":"a.example.com"}\n{"host":"b.example.com"}');
    expect(outcome.status).toBe('completed');
    expect(outcome.entities.map((entity) => entity.value)).toEqual([
      'a.example.com',
      'b.example.com',
    ]);
    expect(outcome.entities[0]?.kind).toBe('hostname');
    expect(outcome.relationships).toHaveLength(2);
    expect(outcome.evidence).toHaveLength(2);
  });

  it('drops items it cannot read a value from instead of inventing one', async () => {
    const outcome = await run('{"count":3}\n{"host":"a.example.com"}');
    expect(outcome.entities.map((entity) => entity.value)).toEqual(['a.example.com']);
  });

  it('reports the same entity once', async () => {
    const outcome = await run('a.example.com\na.example.com');
    expect(outcome.entities).toHaveLength(1);
  });

  it('rejects an input kind the engine does not accept, without running anything', async () => {
    const outcome = await runEngine(engineOver(''), {
      input: { kind: 'email', value: 'someone@example.com' },
      mode: 'configured',
      deadlineMs: 5_000,
      maxResults: 100,
      fetch: async () => ({ status: 200, body: null }),
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.failure?.code).toBe('invalid-input');
  });

  it('surfaces an adapter failure as an engine failure rather than an empty success', async () => {
    const outcome = await run('', 'timeout');
    expect(outcome.status).toBe('failed');
    expect(outcome.failure?.message).toContain('timeout');
    expect(outcome.failure?.code).toBe('timeout');
  });

  it('keeps a refusal non-retryable instead of spending a retry on it', async () => {
    const outcome = await run('', 'invalid-input');
    expect(outcome.failure).toMatchObject({ code: 'invalid-input', retryable: false });
  });

  it('files an adapter kind the driver has no code for as an engine error', async () => {
    const outcome = await run('', 'unavailable');
    expect(outcome.failure).toMatchObject({ code: 'engine-error', retryable: false });
  });

  it('an empty result is a finding, not a failure', async () => {
    const outcome = await run('');
    expect(outcome.status).toBe('completed');
    expect(outcome.entities).toEqual([]);
  });
});

describe('shipped adapter-backed engines', () => {
  const adapter = createCliAdapter({
    run: async () => ({ code: 0, stdout: '{"url":"https://github.com/someone"}' }),
  });

  it('offers subfinder, amass and sherlock once a host has an adapter', () => {
    expect(Object.keys(adapterEngines(adapter)).sort()).toEqual(['amass', 'sherlock', 'subfinder']);
  });

  it('sherlock keeps only real profile URLs', async () => {
    const engine = adapterEngines(adapter)['sherlock']?.();
    const outcome = await runEngine(engine as never, {
      input: { kind: 'username', value: 'someone' },
      mode: 'configured',
      deadlineMs: 5_000,
      maxResults: 100,
      fetch: async () => ({ status: 200, body: null }),
    });
    expect(outcome.entities).toEqual([
      expect.objectContaining({ kind: 'profile', value: 'https://github.com/someone' }),
    ]);
  });
});

describe('subfinder and amass', () => {
  const hostAdapter = createCliAdapter({
    run: async () => ({ code: 0, stdout: '{"host":"a.example.com"}' }),
  });

  it.each(['subfinder', 'amass'])('%s proposes hostnames for a domain', async (id) => {
    const outcome = await runEngine(adapterEngines(hostAdapter)[id]?.() as never, {
      input: { kind: 'domain', value: 'example.com' },
      mode: 'configured',
      deadlineMs: 5_000,
      maxResults: 100,
      fetch: async () => ({ status: 200, body: null }),
    });
    expect(outcome.entities).toEqual([
      expect.objectContaining({ kind: 'hostname', value: 'a.example.com' }),
    ]);
  });
});

describe('registryEngines', () => {
  const catalog = createCatalogRegistry();
  const cli = createCliAdapter({
    run: async () => ({ code: 0, stdout: '{"host":"a.example.com"}' }),
  });
  const python = createPythonAdapter({ run: async () => ({ code: 0, stdout: '{}' }) });

  it('offers only the engines whose runtime has an adapter here', () => {
    const registry = new AdapterRegistry().register(cli);
    expect(Object.keys(registryEngines(registry, catalog)).sort()).toEqual(['amass', 'subfinder']);

    registry.register(python);
    expect(Object.keys(registryEngines(registry, catalog)).sort()).toEqual([
      'amass',
      'sherlock',
      'subfinder',
    ]);
  });

  it('offers nothing when the host registered no adapter at all', () => {
    expect(registryEngines(new AdapterRegistry(), catalog)).toEqual({});
  });

  it('builds engines the executor can run', async () => {
    const engine = registryEngines(new AdapterRegistry().register(cli), catalog)['subfinder']?.();
    const outcome = await runEngine(engine as never, {
      input: { kind: 'domain', value: 'example.com' },
      mode: 'configured',
      deadlineMs: 5_000,
      maxResults: 100,
      fetch: async () => ({ status: 200, body: null }),
    });
    expect(outcome.entities).toEqual([
      expect.objectContaining({ kind: 'hostname', value: 'a.example.com' }),
    ]);
  });
});
