/**
 * A server for the remote execution queue, and a runnable HTTP worker — Part 2 §36.
 *
 *   Core → Remote Execution Queue → External Worker → Result API → Core
 *
 * `httpQueue.ts` in @nexus/transforms is the transport, and it is pure and browser-safe on purpose:
 * `handleQueueRequest` is a `(queue, request) → response` function and `createHttpWorkerTransport`
 * is three fetches over an injected primitive. They were tested against each other over a loopback
 * fetch, which proves they agree but not that either has a home — a transport with no server is a
 * contract nobody signed. This file is the home: a `node:http` server that mounts the Result API on
 * the host, and a worker loop that drives the transport over a real socket from a second machine.
 * The process door (`node:http`, `node:crypto`, the platform `fetch`) lives here in the runner, not
 * in the package, so `@nexus/transforms` stays importable from the browser bundle (N2).
 *
 * Still the operator's to wire: the runner does not yet instantiate a `RemoteQueue` in its plan
 * path (the plan worker runs locally today), and a second machine that claims work still needs its
 * own container executor — `execute` here is injected exactly so that confinement stays the host's
 * (N5, one door). What this file removes is the missing server, not the missing second box.
 */

import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  createHttpWorkerTransport,
  createRemoteWorker,
  handleQueueRequest,
} from '@nexus/transforms';
import type {
  AdapterInput,
  AdapterResult,
  QueueHttpFetch,
  RemoteJob,
  RemoteQueue,
  RemoteWorker,
} from '@nexus/transforms';

/** A queue message is small; anything larger than this is not ours and is refused unread. */
const MAX_BODY_BYTES = 1 << 20;

/**
 * Timing-safe bearer check. A missing header or a wrong-length token fails without a length-leaking
 * early return into `timingSafeEqual` (which throws on unequal lengths).
 */
const tokenOk = (expected: string, header: string | undefined): boolean => {
  const prefix = 'Bearer ';
  if (header === undefined || !header.startsWith(prefix)) return false;
  const got = Buffer.from(header.slice(prefix.length));
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
};

type ParsedBody = { readonly ok: true; readonly body: unknown } | { readonly ok: false };

const readBody = (req: IncomingMessage): Promise<ParsedBody> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve({ ok: false });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw === '') {
        resolve({ ok: true, body: undefined });
        return;
      }
      try {
        resolve({ ok: true, body: JSON.parse(raw) });
      } catch {
        resolve({ ok: false });
      }
    });
    req.on('error', () => resolve({ ok: false }));
  });

export interface RemoteQueueServer {
  /** Binds to `127.0.0.1:port` (0 = an ephemeral port). Resolves with the port actually bound. */
  readonly listen: (port: number) => Promise<number>;
  readonly close: () => Promise<void>;
}

export interface RemoteQueueServerOptions {
  readonly queue: RemoteQueue;
  /** Shared secret every caller presents as `Authorization: Bearer <token>`. A queue open to the internet is not a queue. */
  readonly token: string;
}

/**
 * The Result API as a real `node:http` server. Authentication is the one thing the host owns and
 * the pure router does not, so it lives here: an unauthenticated request never reaches the queue.
 * Everything past the token check is `handleQueueRequest` verbatim — this file adds a socket and a
 * secret, not a second copy of the protocol.
 */
export const createRemoteQueueServer = (options: RemoteQueueServerOptions): RemoteQueueServer => {
  const write = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? null));
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      if (!tokenOk(options.token, req.headers.authorization)) {
        write(res, 401, { error: 'unauthorized' });
        return;
      }
      const parsed = await readBody(req);
      if (!parsed.ok) {
        write(res, 400, { error: 'invalid or oversized body' });
        return;
      }
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      const response = handleQueueRequest(options.queue, {
        method: req.method ?? 'GET',
        path,
        ...(parsed.body === undefined ? {} : { body: parsed.body }),
      });
      write(res, response.status, response.body);
    })();
  });

  return {
    listen: (port) =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          const address = server.address();
          resolve(typeof address === 'object' && address !== null ? address.port : port);
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
};

/**
 * A `QueueHttpFetch` over the platform `fetch`. It talks only to the operator-configured Result API
 * — a fixed control-plane address like `RUNNER_URL`, never a user-supplied host — so it does not go
 * through `safeFetch`: a constant address has no SSRF surface. A non-JSON or empty body reads as
 * `null`, which the transport treats as "no work" rather than crashing the drain (U5).
 */
export const nodeQueueFetch: QueueHttpFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    ...(init.headers === undefined ? {} : { headers: { ...init.headers } }),
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  const text = await response.text();
  let body: unknown = null;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: response.status, body };
};

export interface HttpRemoteWorkerOptions {
  /** Result API root, e.g. `http://raven-host:3004`. */
  readonly baseUrl: string;
  readonly token: string;
  readonly workerId: string;
  /** Runs one job under whatever confinement this machine provides (the runner's container executor). */
  readonly execute: (input: AdapterInput) => Promise<AdapterResult>;
  /** Injected so tests drive a loopback fetch; production leaves it as `nodeQueueFetch`. */
  readonly fetch?: QueueHttpFetch;
  readonly onDone?: (job: RemoteJob, result: AdapterResult) => void;
}

/** Builds a worker that claims and completes over HTTP. The drain loop is `runRemoteWorkerLoop`. */
export const createHttpRemoteWorker = (options: HttpRemoteWorkerOptions): RemoteWorker =>
  createRemoteWorker({
    workerId: options.workerId,
    transport: createHttpWorkerTransport({
      baseUrl: options.baseUrl,
      token: options.token,
      fetch: options.fetch ?? nodeQueueFetch,
    }),
    execute: options.execute,
    ...(options.onDone === undefined ? {} : { onDone: options.onDone }),
  });

export interface WorkerLoopOptions {
  /** Wait between empty claims; a claim that returned work loops straight back with no gap. */
  readonly idleMs: number;
  /** Checked before each claim — the process's shutdown signal. */
  readonly stop: () => boolean;
  /** Injected so tests advance without real time. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll the Result API until `stop()`. The loop never throws: a worker that dies on one bad round
 * trip is a worker that stops draining, so a failed claim is treated as an empty one (U5).
 */
export const runRemoteWorkerLoop = async (
  worker: RemoteWorker,
  options: WorkerLoopOptions,
): Promise<void> => {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  while (!options.stop()) {
    let handled: RemoteJob | null = null;
    try {
      handled = await worker.runOnce();
    } catch {
      handled = null;
    }
    if (handled === null) await sleep(options.idleMs);
  }
};
