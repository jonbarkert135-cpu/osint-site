/**
 * The API's enqueue side of repository analysis (11_GITHUB.md §10, 10_INTEGRATIONS.md R1).
 *
 * The API never analyzes anything itself (N5): it puts one job on the queue the worker consumes,
 * and the queue name, job name and options all come from `@nexus/integrations` so the core stays
 * tool-agnostic. Redis and BullMQ are created lazily, so a test — and a local-mode deployment with
 * no worker — never opens a connection it does not use.
 */

import { Queue } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import {
  repositoryAnalysisJob,
  type RepositoryAnalysisRequest,
} from '@nexus/integrations/repository-analysis';

import { loadServerEnvFromProcess } from '../env.ts';

let connection: Redis | null = null;
const queues = new Map<string, Queue>();

function redis(): Redis {
  connection ??= new IORedis(loadServerEnvFromProcess().REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
}

function queueFor(name: string): Queue {
  const existing = queues.get(name);
  if (existing !== undefined) return existing;
  const created = new Queue(name, { connection: redis() });
  queues.set(name, created);
  return created;
}

/** Enqueues one repository analysis; dedupe and retries are the job options' business. */
export async function enqueueRepositoryAnalysis(request: RepositoryAnalysisRequest): Promise<void> {
  const job = repositoryAnalysisJob(request);
  await queueFor(job.queue).add(job.name, job.payload, job.options);
}

/** Test/shutdown seam: closes whatever was opened lazily. */
export async function closeAnalysisQueue(): Promise<void> {
  await Promise.all([...queues.values()].map(async (queue) => queue.close()));
  queues.clear();
  connection?.disconnect();
  connection = null;
}
