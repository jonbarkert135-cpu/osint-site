/**
 * Raven starts the scan itself (12_SPIDERFOOT.md §4.2, §4.4–§4.7).
 *
 * The fake instance answers exactly what `sfwebui.py` of SpiderFoot v4.0.0 answers, so the test
 * fails if we ever start guessing a different shape.
 */

import { describe, expect, it } from 'vitest';

import {
  isTerminal,
  pollIntervalMs,
  runScan,
  SpiderFootClient,
  SpiderFootError,
  type SpiderFootHttp,
  type SpiderFootHttpRequest,
} from '../spiderfoot/client.ts';

const BASE = 'https://sf.internal.example:5001';

interface FakeOptions {
  /** Status strings answered by successive `/scanstatus` calls; the last one repeats. */
  readonly statuses?: readonly string[];
  readonly eventsPerPoll?: readonly number[];
  readonly modules?: boolean;
  readonly startAnswer?: readonly [string, string];
  readonly stopAnswer?: string;
  readonly pingStatus?: number;
}

interface Fake {
  readonly http: SpiderFootHttp;
  readonly calls: SpiderFootHttpRequest[];
}

function eventRow(index: number): readonly unknown[] {
  return [
    '2026-08-23 10:00:00',
    `host${index}.example.com`,
    'example.com',
    'sfp_dnsresolve',
    'INTERNET_NAME',
    0,
    0,
    1,
    0,
    'INFO',
    `id${index}`,
  ];
}

function fakeInstance(options: FakeOptions = {}): Fake {
  const calls: SpiderFootHttpRequest[] = [];
  let statusPolls = 0;
  const http: SpiderFootHttp = async (request) => {
    calls.push(request);
    const path = request.url.slice(BASE.length).split('?')[0] ?? '';
    if (path === '/ping') {
      const status = options.pingStatus ?? 200;
      return { status, body: status === 200 ? JSON.stringify(['SUCCESS', '4.0.0']) : 'nope' };
    }
    if (path === '/modules') {
      if (options.modules === false) return { status: 404, body: 'not found' };
      return {
        status: 200,
        body: JSON.stringify([{ name: 'sfp_dnsresolve', descr: 'DNS Resolver' }]),
      };
    }
    if (path === '/startscan') {
      return { status: 200, body: JSON.stringify(options.startAnswer ?? ['SUCCESS', 'ABCD1234']) };
    }
    if (path === '/scanstatus') {
      const statuses = options.statuses ?? ['RUNNING', 'FINISHED'];
      const raw = statuses[Math.min(statusPolls, statuses.length - 1)] ?? 'FINISHED';
      statusPolls += 1;
      return {
        status: 200,
        body: JSON.stringify([
          'scan',
          'example.com',
          '2026-08-23 10:00:00',
          '2026-08-23 10:00:01',
          '',
          raw,
          {},
        ]),
      };
    }
    if (path === '/scaneventresults') {
      const counts = options.eventsPerPoll ?? [1, 3];
      const count = counts[Math.min(statusPolls - 1, counts.length - 1)] ?? 0;
      return {
        status: 200,
        body: JSON.stringify(Array.from({ length: count }, (_, index) => eventRow(index))),
      };
    }
    if (path === '/stopscan') return { status: 200, body: options.stopAnswer ?? '' };
    return { status: 404, body: 'not found' };
  };
  return { http, calls };
}

function client(fake: Fake): SpiderFootClient {
  return new SpiderFootClient({ http: fake.http, baseUrl: BASE });
}

describe('spiderfoot capability probe', () => {
  it('reads the version from /ping and the module list from /modules', async () => {
    const fake = fakeInstance();
    const capabilities = await client(fake).probe();
    expect(capabilities.reachable).toBe(true);
    expect(capabilities.version).toBe('4.0.0');
    expect(capabilities.modules).toEqual([{ name: 'sfp_dnsresolve', descr: 'DNS Resolver' }]);
    expect(capabilities.supports.createScan).toBe(true);
    // the probe never starts a scan
    expect(fake.calls.some((call) => call.url.includes('/startscan'))).toBe(false);
  });

  it('degrades to use-case selection when the instance hides its module list', async () => {
    const capabilities = await client(fakeInstance({ modules: false })).probe();
    expect(capabilities.supports.listModules).toBe(false);
    expect(capabilities.notes.join(' ')).toContain('module list');
  });

  it('reports an unreachable instance instead of pretending', async () => {
    await expect(client(fakeInstance({ pingStatus: 500 })).probe()).rejects.toMatchObject({
      code: 'SF_UNREACHABLE',
    });
  });

  it('refuses every operation before the probe ran', async () => {
    await expect(
      client(fakeInstance()).createScan({ name: 'n', target: 'example.com', useCase: 'passive' }),
    ).rejects.toMatchObject({ code: 'SF_PROBE_FAILED' });
  });
});

describe('spiderfoot scan creation', () => {
  it('posts a form-encoded start and returns the scan id', async () => {
    const fake = fakeInstance();
    const sf = client(fake);
    await sf.probe();
    const scanId = await sf.createScan({
      name: 'raven-run',
      target: 'example.com',
      moduleNames: ['sfp_dnsresolve'],
    });
    expect(scanId).toBe('ABCD1234');
    const start = fake.calls.find((call) => call.url.includes('/startscan'));
    expect(start?.method).toBe('POST');
    expect(start?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(start?.body).toContain('scantarget=example.com');
    expect(start?.body).toContain('modulelist=module_sfp_dnsresolve');
  });

  it('surfaces the instance error text when the scan is refused', async () => {
    const sf = client(fakeInstance({ startAnswer: ['ERROR', 'Unrecognised target type.'] }));
    await sf.probe();
    await expect(
      sf.createScan({ name: 'n', target: '???', useCase: 'passive' }),
    ).rejects.toMatchObject({ code: 'SF_SCAN_REJECTED', message: 'Unrecognised target type.' });
  });

  it('rejects a scan with neither modules nor a use case', async () => {
    const sf = client(fakeInstance());
    await sf.probe();
    await expect(sf.createScan({ name: 'n', target: 'example.com' })).rejects.toBeInstanceOf(
      SpiderFootError,
    );
  });
});

describe('spiderfoot polling', () => {
  it('backs off 2s, then 5s, then 15s', () => {
    expect(pollIntervalMs(0)).toBe(2_000);
    expect(pollIntervalMs(59_999)).toBe(2_000);
    expect(pollIntervalMs(60_000)).toBe(5_000);
    expect(pollIntervalMs(599_999)).toBe(5_000);
    expect(pollIntervalMs(600_000)).toBe(15_000);
  });

  it('maps the instance vocabulary onto scan states and keeps the raw string', async () => {
    const sf = client(fakeInstance({ statuses: ['ABORT-REQUESTED'] }));
    await sf.probe();
    const status = await sf.getStatus('ABCD1234');
    expect(status.state).toBe('running');
    expect(status.raw).toBe('ABORT-REQUESTED');
    expect(isTerminal(status.state)).toBe(false);
  });

  it('treats an unknown scan id as state unknown, not as a crash', async () => {
    const fake = fakeInstance();
    const sf = new SpiderFootClient({
      http: async (request) =>
        request.url.includes('/scanstatus') ? { status: 200, body: '[]' } : fake.http(request),
      baseUrl: BASE,
    });
    await sf.probe();
    expect((await sf.getStatus('nope')).state).toBe('unknown');
  });
});

describe('runScan', () => {
  it('creates, polls with backoff and returns the finished result', async () => {
    const fake = fakeInstance({ statuses: ['RUNNING', 'FINISHED'], eventsPerPoll: [1, 3] });
    const sf = client(fake);
    await sf.probe();
    const slept: number[] = [];
    const progress: number[] = [];
    let clock = 0;
    const result = await runScan(
      sf,
      { name: 'raven-run', target: 'example.com', useCase: 'passive' },
      {
        now: () => clock,
        sleep: async (ms) => {
          slept.push(ms);
          clock += ms;
        },
        onProgress: (update) => progress.push(update.events.length),
      },
    );
    expect(result.scanId).toBe('ABCD1234');
    expect(result.status.state).toBe('finished');
    expect(result.partial).toBe(false);
    expect(result.canceled).toBe(false);
    expect(result.events).toHaveLength(3);
    // partial results arrived while the scan was still running
    expect(progress).toEqual([1, 3]);
    expect(slept).toEqual([2_000, 2_000]);
  });

  it('cancels on timeout and keeps the partial results already read', async () => {
    const fake = fakeInstance({ statuses: ['RUNNING'], eventsPerPoll: [2] });
    const sf = client(fake);
    await sf.probe();
    let clock = 0;
    const result = await runScan(
      sf,
      { name: 'raven-run', target: 'example.com', useCase: 'passive' },
      {
        timeoutMs: 5_000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    );
    expect(result.canceled).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.events).toHaveLength(2);
    expect(fake.calls.some((call) => call.url.includes('/stopscan'))).toBe(true);
  });

  it('stops collecting when the caller aborts', async () => {
    const fake = fakeInstance({ statuses: ['RUNNING'], eventsPerPoll: [1] });
    const sf = client(fake);
    await sf.probe();
    const signal = { aborted: false };
    let clock = 0;
    const result = await runScan(
      sf,
      { name: 'raven-run', target: 'example.com', useCase: 'passive' },
      {
        signal,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
          signal.aborted = true;
        },
      },
    );
    expect(result.canceled).toBe(true);
    expect(result.events).toHaveLength(1);
  });

  it('never reports a fake cancel success when the instance refuses', async () => {
    const sf = client(
      fakeInstance({
        stopAnswer: JSON.stringify({ error: { message: 'Scan already finished.' } }),
      }),
    );
    await sf.probe();
    await expect(sf.cancel('ABCD1234')).rejects.toMatchObject({
      code: 'SF_SCAN_REJECTED',
      message: 'Scan already finished.',
    });
  });
});
