/**
 * Job metrics (19_DEPLOYMENT.md §10.2 "Jobs" block, §64 observability).
 *
 * Queue depth is the number the `QueueBacklog` alert reads, and it cannot be derived from the
 * handler: it is polled from BullMQ. Duration, failures and retries are recorded by wrapping the
 * handler, so every queue this service registers is instrumented the same way instead of each
 * handler counting for itself.
 */

import { createServer } from 'node:http';

import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export const registry = new Registry();

export const queueDepth = new Gauge({
  name: 'raven_queue_depth',
  help: 'Jobs waiting or delayed in a queue',
  labelNames: ['queue'] as const,
  registers: [registry],
});

export const jobDuration = new Histogram({
  name: 'raven_job_duration_seconds',
  help: 'Time one job handler spent running',
  labelNames: ['queue', 'job'] as const,
  buckets: [0.05, 0.25, 1, 5, 15, 30, 60, 120, 300],
  registers: [registry],
});

export const jobFailures = new Counter({
  name: 'raven_job_failures_total',
  help: 'Job handlers that threw',
  labelNames: ['queue', 'job', 'reason'] as const,
  registers: [registry],
});

export const jobRetries = new Counter({
  name: 'raven_job_retries_total',
  help: 'Job attempts that were not the first one',
  labelNames: ['queue', 'job'] as const,
  registers: [registry],
});

/** The slice of a BullMQ job the metrics need — keeps the wrapper testable without a real queue. */
export interface MeasuredJob {
  readonly name?: string;
  readonly attemptsMade?: number;
}

/** `reason` stays low-cardinality: an error code if the thrower gave one, else the class name. */
export function reasonOf(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0 && code.length <= 40) return code;
    return error.name;
  }
  return 'unknown';
}

/**
 * Wraps one job handler. Re-throws untouched: BullMQ's retry policy is the source of truth for
 * what happens next, this only records what happened.
 */
export async function measureJob<T>(
  queue: string,
  job: MeasuredJob,
  handler: () => Promise<T>,
): Promise<T> {
  const name = job.name ?? queue;
  if ((job.attemptsMade ?? 0) > 0) jobRetries.inc({ queue, job: name });
  const stop = jobDuration.startTimer({ queue, job: name });
  try {
    const result = await handler();
    stop();
    return result;
  } catch (error) {
    stop();
    jobFailures.inc({ queue, job: name, reason: reasonOf(error) });
    throw error;
  }
}

/** What `pollQueueDepth` needs from a BullMQ `Queue`. */
export interface CountableQueue {
  readonly name: string;
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
}

/** Refreshes `raven_queue_depth` for the given queues; returns the stop function. */
export function pollQueueDepth(
  queues: readonly CountableQueue[],
  intervalMs = 15_000,
  onError: (error: unknown) => void = () => {},
): () => void {
  const tick = async (): Promise<void> => {
    for (const queue of queues) {
      const counts = await queue.getJobCounts('waiting', 'delayed');
      queueDepth.set({ queue: queue.name }, (counts['waiting'] ?? 0) + (counts['delayed'] ?? 0));
    }
  };
  const timer = setInterval(() => void tick().catch(onError), intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
  };
}

/** A metrics endpoint on its own port, so it is never reachable through the public ingress. */
export interface MetricsServer {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * `node:http` rather than Fastify: this service has no HTTP framework in its dependency tree and
 * a scrape endpoint is not a reason to add one.
 */
export async function startMetricsServer(port = 9467): Promise<MetricsServer> {
  const server = createServer((req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    void registry.metrics().then(
      (body) => {
        res.writeHead(200, { 'content-type': registry.contentType });
        res.end(body);
      },
      () => {
        res.writeHead(500).end();
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  const address = server.address();
  return {
    port: typeof address === 'object' && address !== null ? address.port : port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
