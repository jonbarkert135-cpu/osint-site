/**
 * The remote queue over a real socket — Part 2 §36. The transport is already tested against a
 * loopback fetch in `packages/transforms`; this drives it over `node:http` + the platform `fetch`,
 * because a transport tested only against its own stub proves agreement, not a working server.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { createRemoteQueue, type AdapterInput, type AdapterResult } from '@nexus/transforms';

import {
  createHttpRemoteWorker,
  createRemoteQueueServer,
  nodeQueueFetch,
  runRemoteWorkerLoop,
  type RemoteQueueServer,
} from '../src/remoteQueueHttp.ts';

const TOKEN = 'shared-secret';

const input = (): AdapterInput => ({
  engineId: 'subfinder',
  capability: 'subdomain-discovery',
  payload: { domain: 'example.com' },
  timeoutMs: 30_000,
});

const okResult = (): AdapterResult => ({
  ok: true,
  output: { items: [{ value: 'a.example.com' }] },
});

let server: RemoteQueueServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

const start = async (
  queue = createRemoteQueue(),
): Promise<{ base: string; queue: typeof queue }> => {
  server = createRemoteQueueServer({ queue, token: TOKEN });
  const port = await server.listen(0);
  return { base: `http://127.0.0.1:${String(port)}`, queue };
};

describe('remote queue server + http worker', () => {
  it('a worker claims a real job over HTTP and the result is recorded', async () => {
    const { base, queue } = await start();
    const job = queue.enqueue(input());

    const worker = createHttpRemoteWorker({
      baseUrl: base,
      token: TOKEN,
      workerId: 'w1',
      execute: () => Promise.resolve(okResult()),
    });

    const handled = await worker.runOnce();
    expect(handled?.id).toBe(job.id);

    const settled = queue.get(job.id);
    expect(settled?.state).toBe('done');
    expect(settled?.result).toEqual(okResult());
  });

  it('an empty queue answers "no work" and the worker does not throw', async () => {
    const { base } = await start();
    const worker = createHttpRemoteWorker({
      baseUrl: base,
      token: TOKEN,
      workerId: 'w1',
      execute: () => Promise.reject(new Error('must not run on an empty queue')),
    });
    expect(await worker.runOnce()).toBeNull();
  });

  it('refuses an unauthenticated caller with 401 and never touches the queue', async () => {
    const { base, queue } = await start();
    queue.enqueue(input());

    const res = await nodeQueueFetch(`${base}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: 'w1' }),
    });
    expect(res.status).toBe(401);
    // The one queued job was never claimed.
    expect(queue.list().every((j) => j.state === 'queued')).toBe(true);
  });

  it('a worker with the wrong token sees no work rather than an error', async () => {
    const { base } = await start();
    const worker = createHttpRemoteWorker({
      baseUrl: base,
      token: 'wrong',
      workerId: 'w1',
      execute: () => Promise.resolve(okResult()),
    });
    expect(await worker.runOnce()).toBeNull();
  });

  it('a second result for a claimed job is a 409, not a silent overwrite', async () => {
    const { base, queue } = await start();
    const job = queue.enqueue(input());
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

    const first = await nodeQueueFetch(`${base}/jobs/${job.id}/result`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ result: okResult() }),
    });
    expect(first.status).toBe(200);

    const second = await nodeQueueFetch(`${base}/jobs/${job.id}/result`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ result: okResult() }),
    });
    expect(second.status).toBe(409);
  });

  it('rejects a malformed body with 400', async () => {
    const { base } = await start();
    const res = await nodeQueueFetch(`${base}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('drains a busy queue and then idles until stopped', async () => {
    const { base, queue } = await start();
    queue.enqueue(input());
    queue.enqueue(input());

    const worker = createHttpRemoteWorker({
      baseUrl: base,
      token: TOKEN,
      workerId: 'w1',
      execute: () => Promise.resolve(okResult()),
    });

    let ticks = 0;
    const idles: number[] = [];
    await runRemoteWorkerLoop(worker, {
      idleMs: 5,
      // Two jobs (no idle), then one empty claim (one idle) ends the loop.
      stop: () => ticks++ >= 3,
      sleep: (ms) => {
        idles.push(ms);
        return Promise.resolve();
      },
    });

    expect(queue.list().filter((j) => j.state === 'done')).toHaveLength(2);
    expect(idles).toEqual([5]);
  });
});
