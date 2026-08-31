/**
 * The job protocol (10_INTEGRATIONS.md §6.5).
 *
 * A queue message carries *only* identifiers. Manifest, input and limits are loaded from Postgres
 * by the runner, so a message that sat in Redis over a deploy can never carry stale limits — the
 * single most dangerous kind of staleness in a sandbox.
 */

import { z } from 'zod';

export const RUN_QUEUE = 'integration.run';
export const PARSE_QUEUE = 'integration.parse';
/** Part 2 §36/§37: asks the runner to plan and execute one query on the host adapters. */
export const PLAN_QUEUE = 'query.plan';

export const zRunJob = z.object({
  runId: z.string().min(1),
  orgId: z.string().min(1),
  attempt: z.number().int().min(1).max(3),
});

export type RunJob = z.infer<typeof zRunJob>;

export const zParseJob = z.object({
  runId: z.string().min(1),
  orgId: z.string().min(1),
  attempt: z.number().int().min(1).max(3),
});

export type ParseJob = z.infer<typeof zParseJob>;

/**
 * A plan job carries the query itself rather than a row id: there is no plan table, and a plan is
 * derived from the registry at claim time, so nothing here can go stale over a deploy the way run
 * limits can. Permissions are stated by the caller — the runner never widens them (N4).
 */
export const zPlanJob = z.object({
  runId: z.string().min(1),
  orgId: z.string().min(1),
  query: z.string().min(1),
  mode: z
    .enum(['strict-local', 'zero-credential', 'free-tier', 'configured', 'maximum-coverage'])
    .default('zero-credential'),
  permissions: z
    .array(z.enum(['network', 'filesystem', 'subprocess', 'credentials', 'browser']))
    .default([]),
  depth: z.union([z.literal(1), z.literal(2), z.literal('deep')]).optional(),
});

export type PlanJob = z.infer<typeof zPlanJob>;

/** BullMQ options for both queues: we retry explicitly (§11.3), never blindly. */
export const JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: 1000,
  removeOnFail: 5000,
} as const;

export const zRunEvent = z.discriminatedUnion('t', [
  z.object({ t: z.literal('status'), status: z.string(), at: z.string() }),
  z.object({
    t: z.literal('log'),
    seq: z.number().int(),
    level: z.enum(['info', 'warn', 'error']),
    phase: z.string(),
    message: z.string(),
  }),
  z.object({ t: z.literal('stdout'), chunk: z.string().max(4096) }),
  z.object({
    t: z.literal('metric'),
    name: z.enum(['egress', 'bytesOut', 'records']),
    value: z.number(),
  }),
  z.object({ t: z.literal('partial'), entities: z.number().int(), edges: z.number().int() }),
  z.object({
    t: z.literal('done'),
    status: z.string(),
    proposalId: z.string().optional(),
    error: z.unknown().optional(),
  }),
]);

export type RunEvent = z.infer<typeof zRunEvent>;

export const runChannel = (runId: string): string => `run:${runId}`;
export const cancelKey = (runId: string): string => `cancel:${runId}`;

/** Timers from §6.7, in one place so the runner and the stale-run monitor cannot disagree. */
export const TIMERS = {
  queueWaitMs: 15 * 60 * 1000,
  imagePullMs: 120_000,
  containerStartMs: 30_000,
  graceMs: 5_000,
  noOutputWatchdogMs: 180_000,
  parseMs: 120_000,
  /** §8 edge case: anything stuck in `parsing` beyond this is flagged by the stale-run monitor. */
  staleParsingMs: 10 * 60 * 1000,
} as const;

/** Stdout coalescing (§6.5): flush at 4 KiB or every 100 ms, whichever comes first. */
export const STDOUT_FLUSH_BYTES = 4096;
export const STDOUT_FLUSH_MS = 100;
