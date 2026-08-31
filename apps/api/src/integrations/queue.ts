/**
 * The API's half of the job protocol (10_INTEGRATIONS.md §6.5).
 *
 * The API only ever *enqueues* and *signals*; it never executes (N5). Redis and BullMQ are created
 * lazily so a test — and a local-mode deployment, which has no runner at all — never opens a
 * connection it does not use.
 */

import { Queue } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';

import { loadServerEnvFromProcess } from '../env.ts';

export const RUN_QUEUE = 'integration.run';
/** Part 2 §36/§37: the runner's plan queue — the API asks for a plan, it never derives one. */
export const PLAN_QUEUE = 'query.plan';

export interface RunJobPayload {
  readonly runId: string;
  readonly orgId: string;
  readonly attempt: number;
}

export interface PlanJobPayload {
  readonly runId: string;
  readonly orgId: string;
  readonly query: string;
  readonly mode: string;
  readonly permissions: readonly string[];
  readonly depth?: 1 | 2 | 'deep';
}

let connection: Redis | null = null;
let queue: Queue | null = null;
let planQueueInstance: Queue | null = null;

function redis(): Redis {
  connection ??= new IORedis(loadServerEnvFromProcess().REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
}

function runQueue(): Queue {
  queue ??= new Queue(RUN_QUEUE, { connection: redis() });
  return queue;
}

/** `attempts: 1` — retries are explicit (§11.3); a blind retry re-scans a third party. */
export async function enqueueRun(payload: RunJobPayload): Promise<void> {
  await runQueue().add(RUN_QUEUE, payload, {
    attempts: 1,
    removeOnComplete: 1000,
    removeOnFail: 5000,
  });
}

/** Same rule as a run: one job, no blind retry — a re-planned query re-contacts third parties. */
export async function enqueuePlan(payload: PlanJobPayload): Promise<void> {
  planQueueInstance ??= new Queue(PLAN_QUEUE, { connection: redis() });
  await planQueueInstance.add(PLAN_QUEUE, payload, {
    attempts: 1,
    removeOnComplete: 1000,
    removeOnFail: 5000,
  });
}

/** The cancel key is authoritative: it works even when the runner is mid-execution (§6.7). */
export async function requestRunCancel(runId: string, ttlMs: number): Promise<void> {
  await redis().set(`cancel:${runId}`, '1', 'PX', ttlMs);
  await redis().publish(
    `run:${runId}`,
    JSON.stringify({ t: 'status', status: 'cancelled', at: new Date().toISOString() }),
  );
}

export function publishRunEvent(runId: string, event: Record<string, unknown>): void {
  void redis().publish(`run:${runId}`, JSON.stringify(event));
}

/** Test/shutdown seam: closes whatever was opened lazily. */
export async function closeQueue(): Promise<void> {
  await queue?.close();
  await planQueueInstance?.close();
  connection?.disconnect();
  queue = null;
  planQueueInstance = null;
  connection = null;
}
