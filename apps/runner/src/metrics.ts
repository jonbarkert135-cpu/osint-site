/**
 * Runner metrics (19_DEPLOYMENT.md §10.2 "Runner" block, §64 observability).
 *
 * Names, label sets and histogram buckets are copied verbatim from the spec — it says
 * "implementations must use exactly these". The runner is the service where an operator first
 * looks when a query is slow, so engine latency, failure class and the sandbox-violation counter
 * are recorded for every run, including the ones that never reached the executor.
 */

import { createServer } from 'node:http';

import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { IntegrationErrorCode, RawRunResult } from '@nexus/integrations';

export const registry = new Registry();

/** `status` is the spec's five-value classification, not the run row's status. */
export type RunOutcome = 'success' | 'failed' | 'timeout' | 'resource_limit' | 'blocked';

export const runsTotal = new Counter({
  name: 'raven_runs_total',
  help: 'Integration runs the runner finished, by tool and outcome class',
  labelNames: ['tool', 'status'] as const,
  registers: [registry],
});

export const runDuration = new Histogram({
  name: 'raven_run_duration_seconds',
  help: 'Wall-clock duration of one engine execution',
  labelNames: ['tool'] as const,
  buckets: [1, 5, 15, 30, 60, 120, 300],
  registers: [registry],
});

export const runOutputBytes = new Histogram({
  name: 'raven_run_output_bytes',
  help: 'Bytes of output an engine produced',
  labelNames: ['tool'] as const,
  buckets: [1_000, 10_000, 100_000, 1_000_000, 10_000_000, 40_000_000],
  registers: [registry],
});

export const concurrentRuns = new Gauge({
  name: 'raven_runner_concurrent_runs',
  help: 'Runs currently occupying a runner slot',
  registers: [registry],
});

export const sandboxViolations = new Counter({
  name: 'raven_runner_sandbox_violations_total',
  help: 'Sandbox policy denials observed while executing engines',
  labelNames: ['kind'] as const, // network | filesystem | caps | pids
  registers: [registry],
});

const TIMEOUT_CODES = new Set<IntegrationErrorCode>([
  'TIMEOUT',
  'START_TIMEOUT',
  'QUEUE_TIMEOUT',
  'IMAGE_PULL_TIMEOUT',
  'PARSE_TIMEOUT',
]);

const RESOURCE_CODES = new Set<IntegrationErrorCode>([
  'OOM_KILLED',
  'QUOTA_EXCEEDED',
  'RATE_LIMITED',
  'CONCURRENCY_LIMIT',
  'OUTPUT_TOO_LARGE',
  'EGRESS_THROTTLED',
]);

const BLOCKED_CODES = new Set<IntegrationErrorCode>([
  'EGRESS_DENIED',
  'TARGET_NOT_ALLOWED',
  'PERMISSION_DENIED',
  'CONSENT_REQUIRED',
  'CONSENT_EXPIRED',
  'INTEGRATION_DISABLED',
  'APPROVAL_REQUIRED',
  'APPROVAL_DENIED',
  'IMAGE_REGISTRY_DENIED',
  'SANDBOX_VIOLATION',
]);

const SANDBOX_KINDS = new Set(['network', 'filesystem', 'caps', 'pids']);

/**
 * Maps a terminal run status plus its error code onto the spec's five outcome classes. A cancelled
 * run counts as `failed`: the alert in §10.5 is a ratio of non-success runs, and a run the user
 * killed did not produce intelligence either.
 */
export function outcomeOf(
  status: RawRunResult['status'],
  code: IntegrationErrorCode | undefined,
): RunOutcome {
  if (status === 'succeeded' || status === 'partial') return 'success';
  if (status === 'timed_out') return 'timeout';
  if (code === undefined) return 'failed';
  if (TIMEOUT_CODES.has(code)) return 'timeout';
  if (RESOURCE_CODES.has(code)) return 'resource_limit';
  if (BLOCKED_CODES.has(code)) return 'blocked';
  return 'failed';
}

/** Records the four run metrics for one finished execution. `tool` is the integration id. */
export function observeRun(tool: string, result: RawRunResult): void {
  runsTotal.inc({ tool, status: outcomeOf(result.status, result.error?.code) });
  runDuration.observe({ tool }, result.durationMs / 1000);
  runOutputBytes.observe({ tool }, result.stats.bytesOut);
  if (result.stats.egressDenied > 0) {
    sandboxViolations.inc({ kind: 'network' }, result.stats.egressDenied);
  }
  const kind =
    result.error?.code === 'SANDBOX_VIOLATION' ? result.error.detail?.['kind'] : undefined;
  if (typeof kind === 'string' && SANDBOX_KINDS.has(kind)) sandboxViolations.inc({ kind });
}

/** Holds the concurrency gauge for the lifetime of one run, including the failure path. */
export async function withRunSlot<T>(run: () => Promise<T>): Promise<T> {
  concurrentRuns.inc();
  try {
    return await run();
  } finally {
    concurrentRuns.dec();
  }
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
export async function startMetricsServer(port = 9466): Promise<MetricsServer> {
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
