import {
  BUILTIN_ENGINES,
  createCatalogRegistry,
  createResultCache,
  type HostFetch,
  type PlannerContext,
} from '@nexus/transforms';
import { describe, expect, it } from 'vitest';

import { createEngineLibrary, executePlan, runPlan, type ExecuteDeps } from '../src/executor.ts';
import { planQuery } from '../src/plan.ts';
import { createResourceManager, DEFAULT_RESOURCE_BUDGET } from '../src/resources.ts';
import type { QueryEvent } from '../src/events.ts';

const registry = createCatalogRegistry();

const ctx = (): PlannerContext => ({
  mode: 'zero-credential',
  configuredProviders: new Set<string>(),
  grantedPermissions: new Set(['network'] as const),
  // Wide enough that the planner keeps every keyless domain capability, including the deep one.
  budget: {
    maxNewNodes: 1_000,
    maxDepth: 2,
    maxRuntimeMs: 120_000,
    maxParallel: 4,
    maxTransforms: 12,
  },
});

const doh = (name: string, type: string): string =>
  `https://dns.google/resolve?name=${name}&type=${type}`;

const NET: Readonly<Record<string, { status: number; body: unknown }>> = {
  [doh('example.com', 'A')]: {
    status: 200,
    body: { Answer: [{ data: '93.184.216.34', TTL: 300 }] },
  },
  [doh('example.com', 'AAAA')]: { status: 200, body: { Answer: [] } },
  [doh('example.com', 'MX')]: { status: 200, body: { Answer: [{ data: '10 mail.example.com.' }] } },
  [doh('example.com', 'NS')]: { status: 200, body: { Answer: [{ data: 'a.iana-servers.net.' }] } },
  'https://crt.sh/?q=%25.example.com&output=json': {
    status: 200,
    body: [
      { name_value: 'www.example.com\nmail.example.com', issuer_name: "O=Let's Encrypt" },
      { name_value: 'shop.example.com', issuer_name: 'O=DigiCert' },
    ],
  },
  'https://rdap.org/domain/example.com': {
    status: 200,
    body: {
      status: ['active'],
      events: [{ eventAction: 'registration', eventDate: '1995-08-14T04:00:00Z' }],
      entities: [
        {
          roles: ['registrar'],
          vcardArray: ['vcard', [['fn', {}, 'text', 'IANA']]],
        },
      ],
    },
  },
};

/** Anything the fixture does not mock answers 503: an engine may fail, the run may not. */
const fetchMock =
  (calls: string[] = []): HostFetch =>
  (url) => {
    calls.push(url);
    return Promise.resolve(NET[url] ?? { status: 503, body: null });
  };

const deps = (over: Partial<ExecuteDeps> = {}): ExecuteDeps => ({
  registry,
  engines: createEngineLibrary(BUILTIN_ENGINES),
  mode: 'zero-credential',
  fetch: fetchMock(),
  ...over,
});

const collect = async (plan: ReturnType<typeof planQuery>, over: Partial<ExecuteDeps> = {}) => {
  const events: QueryEvent[] = [];
  const iterator = executePlan(plan, deps(over));
  for (;;) {
    const step = await iterator.next();
    if (step.done === true) return { events, result: step.value };
    events.push(step.value);
  }
};

describe('executePlan', () => {
  it('turns one typed input into a graph with provenance on every node', async () => {
    const { events, result } = await collect(planQuery(registry, 'example.com', ctx()));

    expect(events[0]).toEqual({ type: 'plan.started', stages: 1, steps: expect.any(Number) });
    expect(events.at(-1)?.type).toBe('plan.done');

    const values = result.entities.map((entity) => entity.value);
    expect(values).toContain('93.184.216.34');
    expect(values).toContain('shop.example.com');
    expect(result.entities.every((entity) => entity.sources.length > 0)).toBe(true);
    expect(result.entities.find((entity) => entity.seed)?.value).toBe('example.com');
    expect(result.runs.length).toBeGreaterThan(0);
    expect(result.summary.entities).toBe(result.entities.length);
  });

  it('streams entities as they arrive instead of only at the end', async () => {
    const { events } = await collect(planQuery(registry, 'example.com', ctx()));
    const found = events.filter((event) => event.type === 'entity.found');
    expect(found.length).toBeGreaterThan(3);
    expect(events.indexOf(found[0]!)).toBeLessThan(events.length - 1);
  });

  it('does not duplicate a host name several certificates list, and keeps kinds apart', async () => {
    const { result } = await collect(planQuery(registry, 'example.com', ctx()));

    const hosts = result.entities.filter(
      (entity) => entity.kind === 'hostname' && entity.value === 'mail.example.com',
    );
    expect(hosts).toHaveLength(1);
    // The MX record is a DNS record, not the host it points at: merging them would erase the
    // difference between "this name is certified" and "this name is a mail exchanger".
    expect(
      result.entities.some(
        (entity) => entity.kind === 'dns_record' && entity.value === 'mail.example.com',
      ),
    ).toBe(true);
  });

  it('degrades instead of failing when engines are missing or unavailable', async () => {
    const { events, result } = await collect(planQuery(registry, 'example.com', ctx()));
    const skipped = events.filter((event) => event.type === 'step.skipped');
    expect(skipped.length).toBeGreaterThan(0);
    expect(result.entities.length).toBeGreaterThan(0);
    expect(['completed', 'degraded']).toContain(result.summary.status);
  });

  it('keeps what it has when the node budget runs out', async () => {
    const result = await runPlan(
      planQuery(registry, 'example.com', ctx()),
      deps({
        budget: {
          maxNewNodes: 2,
          maxDepth: 2,
          maxRuntimeMs: 60_000,
          maxParallel: 1,
          maxTransforms: 12,
        },
      }),
    );
    expect(result.summary.status).toBe('partial');
    expect(result.entities.length).toBeGreaterThan(0);
    expect(result.summary.warnings.join(' ')).toMatch(/budget/u);
  });

  it('stops on cancellation and reports it as cancelled, not as a failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runPlan(
      planQuery(registry, 'example.com', ctx()),
      deps({ signal: controller.signal }),
    );
    expect(result.summary.status).toBe('cancelled');
  });

  it('labels a cached answer as cached and does not call the provider twice', async () => {
    const cache = createResultCache();
    const calls: string[] = [];
    const shared = deps({ cache, fetch: fetchMock(calls) });

    await runPlan(planQuery(registry, 'example.com', ctx()), shared);
    const first = calls.length;
    const second = await runPlan(planQuery(registry, 'example.com', ctx()), shared);

    expect(calls.length).toBeLessThan(first * 2);
    expect(second.summary.cacheHits).toBeGreaterThan(0);
    expect(second.provenance.some((source) => source.cached)).toBe(true);
  });

  it('runs a second stage on what the first stage produced', async () => {
    const { events } = await collect(planQuery(registry, 'example.com', ctx(), { depth: 2 }));
    const stages = new Set(
      events.filter((event) => event.type === 'stage.started').map((event) => event.stage),
    );
    expect(stages.size).toBeGreaterThan(1);
    const secondStageInputs = events
      .filter((event) => event.type === 'step.started' && event.step.stage === 2)
      .map((event) => (event.type === 'step.started' ? event.step.input.value : ''));
    expect(secondStageInputs.every((value) => value !== 'example.com')).toBe(true);
  });

  it('emits the scheduled DAG before it runs anything', async () => {
    const { events } = await collect(planQuery(registry, 'example.com', ctx(), { depth: 2 }));
    const graph = events.find((event) => event.type === 'plan.graph');
    expect(graph).toBeDefined();
    if (graph?.type !== 'plan.graph') throw new Error('expected plan.graph');
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.depth).toBeGreaterThan(0);
    expect(graph.width).toBeGreaterThan(0);
    expect(events.findIndex((event) => event.type === 'plan.graph')).toBeLessThan(
      events.findIndex((event) => event.type === 'step.started'),
    );
  });

  it('streams per-step and whole-run progress', async () => {
    const { events } = await collect(planQuery(registry, 'example.com', ctx()));
    const stepProgress = events.filter((event) => event.type === 'step.progress');
    const runProgress = events.filter((event) => event.type === 'run.progress');
    expect(stepProgress.length).toBeGreaterThan(0);
    expect(runProgress.length).toBeGreaterThan(0);
    for (const event of [...stepProgress, ...runProgress]) {
      if (event.type === 'step.progress' || event.type === 'run.progress') {
        expect(event.fraction).toBeGreaterThanOrEqual(0);
        expect(event.fraction).toBeLessThanOrEqual(1);
      }
    }
    const last = runProgress.at(-1);
    if (last?.type !== 'run.progress') throw new Error('expected run.progress');
    expect(last.settled).toBe(last.planned);
    expect(last.fraction).toBe(1);
  });

  it('starts independent steps together instead of serialising them', async () => {
    let open = 0;
    let peak = 0;
    const slowFetch: HostFetch = async (url) => {
      open += 1;
      peak = Math.max(peak, open);
      await new Promise((resolve) => setTimeout(resolve, 5));
      open -= 1;
      return NET[url] ?? { status: 503, body: null };
    };
    await runPlan(planQuery(registry, 'example.com', ctx()), deps({ fetch: slowFetch }));
    expect(peak).toBeGreaterThan(1);
  });

  it('says why it did nothing when the input types to nothing routable', async () => {
    const result = await runPlan(planQuery(registry, '   ', ctx()), deps());
    expect(result.summary.status).toBe('failed');
    expect(result.entities).toEqual([]);
    expect(result.summary.warnings[0]).toMatch(/routable/u);
  });
});

describe('raw output persistence', () => {
  it('hands each run its chunks, and keeps the results when the store fails', async () => {
    const stored: string[] = [];
    const { result } = await collect(planQuery(registry, 'example.com', ctx()), {
      persistChunks: (runId, chunks) => {
        stored.push(runId);
        expect(chunks.length).toBeGreaterThan(0);
      },
    });
    expect(stored.length).toBeGreaterThan(0);

    const failing = await collect(planQuery(registry, 'example.com', ctx()), {
      persistChunks: () => Promise.reject(new Error('disk full')),
    });
    expect(failing.result.entities.map((entity) => entity.value)).toEqual(
      result.entities.map((entity) => entity.value),
    );
  });
});

describe('admission control (§32)', () => {
  it('runs normally while the host has room, and releases every lease afterwards', async () => {
    const resources = createResourceManager();
    const { result } = await collect(planQuery(registry, 'example.com', ctx()), { resources });
    expect(result.entities.length).toBeGreaterThan(0);
    expect(resources.usage().inFlight).toBe(0);
  });

  it('skips a step the host has no capacity for instead of failing the query', async () => {
    const resources = createResourceManager({ ...DEFAULT_RESOURCE_BUDGET, memoryMb: 1 });
    const { events, result } = await collect(planQuery(registry, 'example.com', ctx()), {
      resources,
    });
    const skips = events.filter(
      (event) => event.type === 'step.skipped' && event.reason === 'over-capacity',
    );
    expect(skips.length).toBeGreaterThan(0);
    expect(result.summary.warnings.some((warning) => warning.includes('RAM left'))).toBe(true);
  });
});
