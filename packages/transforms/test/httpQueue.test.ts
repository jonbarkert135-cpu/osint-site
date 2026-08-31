/**
 * HTTP transport for the remote execution queue (Part 2 §36). The two halves are tested against
 * each other — the worker transport talks to `handleQueueRequest` over a fake socket — because a
 * transport that is only tested against a stub is a transport that agrees with itself.
 */

import { describe, expect, it, vi } from 'vitest';

import type { AdapterInput, AdapterResult } from '../src/adapters.ts';
import {
  createHttpWorkerTransport,
  handleQueueRequest,
  type QueueHttpFetch,
} from '../src/httpQueue.ts';
import { createRemoteQueue, type RemoteQueue } from '../src/remote.ts';
import { createRemoteWorker } from '../src/remoteWorker.ts';

const input = (engineId = 'subfinder'): AdapterInput => ({
  engineId,
  capability: 'subdomains',
  payload: {},
  timeoutMs: 1_000,
});

const ok = (engineId: string): AdapterResult => ({ ok: true, output: { items: [{ engineId }] } });

/** The network, minus the network: routes a request straight into the queue's own router. */
const loopback = (queue: RemoteQueue): QueueHttpFetch => {
  return (url, init) =>
    Promise.resolve(
      handleQueueRequest(queue, {
        method: init.method,
        path: new URL(url).pathname.replace('/api/remote-queue', ''),
        body: init.body === undefined ? undefined : JSON.parse(init.body),
      }),
    );
};

describe('remote queue over HTTP (§36)', () => {
  it('drives a worker on another machine end to end', async () => {
    const queue = createRemoteQueue();
    const job = queue.enqueue(input());
    const worker = createRemoteWorker({
      workerId: 'worker-eu-1',
      transport: createHttpWorkerTransport({
        baseUrl: 'https://raven.test/api/remote-queue/',
        fetch: loopback(queue),
        token: 'secret',
      }),
      execute: (claimed) => Promise.resolve(ok(claimed.engineId)),
    });

    expect((await worker.runOnce())?.id).toBe(job.id);
    const stored = queue.get(job.id);
    expect(stored?.state).toBe('done');
    expect(stored?.claimedBy).toBe('worker-eu-1');
  });

  it('sends the token and the worker id, and reports an empty queue as no work', async () => {
    const queue = createRemoteQueue();
    const fetch = vi.fn(loopback(queue));
    const transport = createHttpWorkerTransport({
      baseUrl: 'https://raven.test/api/remote-queue',
      fetch,
      token: 'secret',
    });

    expect(await transport.claim('worker-1')).toBeNull();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://raven.test/api/remote-queue/claim');
    expect(init?.headers?.['authorization']).toBe('Bearer secret');
    expect(init?.body).toBe(JSON.stringify({ workerId: 'worker-1' }));
  });

  it('treats a refused or malformed answer as no work rather than crashing the drain', async () => {
    const transport = createHttpWorkerTransport({
      baseUrl: 'https://raven.test/q',
      fetch: (url) =>
        Promise.resolve(
          url.endsWith('/claim') ? { status: 401, body: null } : { status: 200, body: {} },
        ),
    });
    expect(await transport.claim('worker-1')).toBeNull();

    const garbage = createHttpWorkerTransport({
      baseUrl: 'https://raven.test/q',
      fetch: () => Promise.resolve({ status: 200, body: { id: 7 } }),
    });
    expect(await garbage.claim('worker-1')).toBeNull();
  });

  it('exposes the job state for the core to poll', async () => {
    const queue = createRemoteQueue();
    const job = queue.enqueue(input());
    const found = handleQueueRequest(queue, { method: 'GET', path: `/jobs/${job.id}` });

    expect(found.status).toBe(200);
    expect((found.body as { id: string }).id).toBe(job.id);
    expect(handleQueueRequest(queue, { method: 'GET', path: '/jobs/nope' }).status).toBe(404);
  });

  it('refuses the requests a queue must refuse', () => {
    const queue = createRemoteQueue();
    const job = queue.enqueue(input());

    expect(handleQueueRequest(queue, { method: 'GET', path: '/claim' }).status).toBe(405);
    expect(handleQueueRequest(queue, { method: 'POST', path: '/claim', body: {} }).status).toBe(
      400,
    );
    expect(handleQueueRequest(queue, { method: 'GET', path: '/nothing' }).status).toBe(404);
    expect(
      handleQueueRequest(queue, { method: 'GET', path: `/jobs/${job.id}/result` }).status,
    ).toBe(405);
    expect(
      handleQueueRequest(queue, { method: 'POST', path: `/jobs/${job.id}/result`, body: {} })
        .status,
    ).toBe(400);

    // A worker that posts twice loses the race the second time: 409, not a silent overwrite.
    const first = handleQueueRequest(queue, {
      method: 'POST',
      path: `/jobs/${job.id}/result`,
      body: { result: ok('subfinder') },
    });
    expect(first.status).toBe(200);
    expect(
      handleQueueRequest(queue, {
        method: 'POST',
        path: `/jobs/${job.id}/result`,
        body: { result: ok('subfinder') },
      }).status,
    ).toBe(409);
  });
});
