/**
 * `spiderfoot-scan` inside the runner: probe → start → poll → artifact, through the same builtin
 * executor contract `expand-url` uses (12_SPIDERFOOT.md §4.4–§4.7).
 *
 * The instance is a fake `sfwebui` behind the runner's own transport seam, so nothing here talks to
 * a network and the SSRF guard of `safeFetch` still sits in the path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Transport } from '@nexus/domain';
import { effectiveLimits, networkPolicyOf } from '@nexus/integrations';
import { scanManifest } from '@nexus/integrations/spiderfoot/scan-manifest';

import { createBuiltinExecutor } from '../src/executors/builtin.ts';
import { requireBuiltin } from '../src/executors/builtin-registry.ts';
import type { CancelWatch } from '../src/cancel.ts';

const limits = effectiveLimits(scanManifest.execution.limits, networkPolicyOf(scanManifest));

const json = (body: unknown): ReturnType<Transport> =>
  Promise.resolve({
    status: 200,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    body: async function* () {
      yield new TextEncoder().encode(JSON.stringify(body));
    },
  });

/** A scan that is already finished on the first poll: one row of results, then done. */
function fakeInstance(): { transport: Transport; started: string[] } {
  const started: string[] = [];
  const transport: Transport = (request) => {
    const path = request.url.pathname;
    if (path === '/ping') return json(['SUCCESS', '4.0.0']);
    if (path === '/modules') return json([{ name: 'sfp_dnsresolve', descr: 'DNS' }]);
    if (path === '/startscan') {
      started.push(request.body ?? '');
      return json(['SUCCESS', 'scan-1234']);
    }
    if (path === '/scanstatus')
      return json(['Raven example.test', 'example.test', '', '', '', 'FINISHED', {}]);
    if (path === '/scaneventresults')
      return json([
        [
          '2026-08-23 10:00:00',
          'mail.example.test',
          'example.test',
          'sfp_dnsresolve',
          'INTERNET_NAME',
        ],
      ]);
    return json([]);
  };
  return { transport, started };
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

const request = (input: Record<string, unknown>) => ({
  runId: 'run-sf-1',
  manifest: scanManifest,
  input,
  secretsRef: [],
  limits,
  cancelToken: 'cancel:run-sf-1',
});

let previousBaseUrl: string | undefined;

beforeEach(() => {
  previousBaseUrl = process.env.SPIDERFOOT_BASE_URL;
  process.env.SPIDERFOOT_BASE_URL = 'https://spiderfoot.test';
});

afterEach(() => {
  if (previousBaseUrl === undefined) delete process.env.SPIDERFOOT_BASE_URL;
  else process.env.SPIDERFOOT_BASE_URL = previousBaseUrl;
});

describe('spiderfoot-scan builtin', () => {
  it('is registered in this build', () => {
    expect(requireBuiltin('spiderfoot-scan').name).toBe('spiderfoot-scan');
  });

  it('starts a scan for the target and stores what it found', async () => {
    const store = sink();
    const instance = fakeInstance();
    const executor = createBuiltinExecutor({
      sink: store,
      bucket: 'raven',
      orgId: 'org-1',
      transport: instance.transport,
      resolve: () => Promise.resolve(['93.184.216.34']),
      watch: idleWatch(),
    });

    const result = await executor.execute(request({ target: 'example.test', useCase: 'passive' }));

    expect(result.status).toBe('succeeded');
    expect(instance.started[0]).toContain('scantarget=example.test');
    expect(instance.started[0]).toContain('usecase=passive');
    const events = JSON.parse(store.written[0]?.body ?? '[]') as unknown[][];
    expect(events[0]?.[1]).toBe('mail.example.test');
  }, 20_000);

  it('refuses to run without a target', async () => {
    const executor = createBuiltinExecutor({
      sink: sink(),
      bucket: 'raven',
      orgId: 'org-1',
      transport: fakeInstance().transport,
      resolve: () => Promise.resolve(['93.184.216.34']),
      watch: idleWatch(),
    });
    const result = await executor.execute(request({}));
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('INPUT_INVALID');
  });

  it('reports an unconfigured deployment instead of scanning a dead host', async () => {
    delete process.env.SPIDERFOOT_BASE_URL;
    const executor = createBuiltinExecutor({
      sink: sink(),
      bucket: 'raven',
      orgId: 'org-1',
      transport: fakeInstance().transport,
      resolve: () => Promise.resolve(['93.184.216.34']),
      watch: idleWatch(),
    });
    const result = await executor.execute(request({ target: 'example.test' }));
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('UPSTREAM_UNAVAILABLE');
  });
});
