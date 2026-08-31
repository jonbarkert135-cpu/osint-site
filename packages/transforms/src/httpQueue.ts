/**
 * HTTP transport for the remote execution queue — Part 2 §36.
 *
 *   Core → Remote Execution Queue → External Worker → Result API → Core
 *
 * `remote.ts` holds the jobs and `remoteWorker.ts` drains them, both transport-blind. This file is
 * the transport that lets the two halves live on different machines, and it is deliberately the
 * smallest one that can: the worker side is three requests over an injected `fetch`, the core side
 * is one pure request router that a host mounts on whatever server it already runs. No server, no
 * framework, no dependency — so the file stays inside the browser-safe bundle (N2).
 */

import type { AdapterResult } from './adapters.ts';
import type { RemoteJob, RemoteQueue } from './remote.ts';
import type { RemoteWorkerTransport } from './remoteWorker.ts';

export interface QueueHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

/** The one network primitive this file needs. Injected, so nothing here imports a client. */
export type QueueHttpFetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
  },
) => Promise<QueueHttpResponse>;

export interface HttpWorkerTransportOptions {
  /** Result API root, e.g. `https://raven.example/api/remote-queue`. */
  readonly baseUrl: string;
  readonly fetch: QueueHttpFetch;
  /** Sent as `authorization` when present; a queue open to the internet is not a queue. */
  readonly token?: string;
}

const isJob = (value: unknown): value is RemoteJob =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { id?: unknown }).id === 'string' &&
  typeof (value as { input?: unknown }).input === 'object';

/**
 * The worker half of the transport. A refused or malformed answer is reported as "no work" rather
 * than as a throw: a worker that crashes on a bad response stops draining (U5, partial beats
 * perfect), and the core falls back locally anyway when nobody claims a job (N2).
 */
export const createHttpWorkerTransport = (
  options: HttpWorkerTransportOptions,
): RemoteWorkerTransport => {
  const base = options.baseUrl.replace(/\/$/, '');
  const headers = {
    'content-type': 'application/json',
    ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
  };

  return {
    claim: async (workerId) => {
      const response = await options.fetch(`${base}/claim`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ workerId }),
      });
      if (response.status !== 200) return null;
      return isJob(response.body) ? response.body : null;
    },

    complete: (jobId, result) =>
      options.fetch(`${base}/jobs/${encodeURIComponent(jobId)}/result`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ result }),
      }),
  };
};

export interface QueueHttpRequest {
  readonly method: string;
  /** Path below the mount point: `/claim`, `/jobs/{id}/result`, `/jobs/{id}`. */
  readonly path: string;
  readonly body?: unknown;
}

const json = (status: number, body: unknown): QueueHttpResponse => ({ status, body });

/**
 * The core half: the Result API as a pure function of (queue, request). A host mounts it on its own
 * server, which is where authentication and rate limiting already live — this file judges nothing
 * about the caller, it only speaks the protocol.
 */
export const handleQueueRequest = (
  queue: RemoteQueue,
  request: QueueHttpRequest,
): QueueHttpResponse => {
  const path = request.path.replace(/\/$/, '');
  const body = (request.body ?? {}) as Record<string, unknown>;

  if (path === '/claim') {
    if (request.method !== 'POST') return json(405, { error: 'POST /claim' });
    const workerId = body['workerId'];
    if (typeof workerId !== 'string' || workerId === '') {
      return json(400, { error: 'workerId is required' });
    }
    // 200 with `null` on an empty queue: "nothing to do" is an answer, not an error.
    return json(200, queue.claim(workerId));
  }

  const result = /^\/jobs\/([^/]+)\/result$/.exec(path);
  if (result !== null) {
    if (request.method !== 'POST') return json(405, { error: 'POST /jobs/{id}/result' });
    const posted = body['result'];
    if (typeof posted !== 'object' || posted === null) {
      return json(400, { error: 'result is required' });
    }
    const job = queue.complete(decodeURIComponent(result[1] ?? ''), posted as AdapterResult);
    // A job the queue no longer accepts (unknown, done, expired) is a 409: the worker lost the
    // race and must not be told its answer was recorded when it was not.
    return job === null ? json(409, { error: 'job is not claimable' }) : json(200, job);
  }

  const get = /^\/jobs\/([^/]+)$/.exec(path);
  if (get !== null) {
    if (request.method !== 'GET') return json(405, { error: 'GET /jobs/{id}' });
    const job = queue.get(decodeURIComponent(get[1] ?? ''));
    return job === undefined ? json(404, { error: 'no such job' }) : json(200, job);
  }

  return json(404, { error: 'no such route' });
};
